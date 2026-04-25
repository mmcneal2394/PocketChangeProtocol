#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(process.cwd(), '.swarm', 'coordination', 'engine-state.db');
const VALID_STATES = new Set(['idle', 'armed', 'cooldown', 'blocked', 'degraded', 'kill_switch']);

let cachedHandle = null;

function nowIso() {
  return new Date().toISOString();
}

function resolveDbPath(overridePath) {
  return path.resolve(process.cwd(), overridePath || DEFAULT_DB_PATH);
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function serializeJson(value) {
  return JSON.stringify(value == null ? {} : value);
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeState(state) {
  const normalized = String(state || 'idle').trim().toLowerCase();
  return VALID_STATES.has(normalized) ? normalized : 'idle';
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_state (
      engine_name TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      reason TEXT,
      metadata_json TEXT,
      cooldown_until TEXT,
      heartbeat_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS engine_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engine_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      state TEXT NOT NULL,
      reason TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS capital_reservations (
      engine_name TEXT PRIMARY KEY,
      lamports INTEGER NOT NULL,
      reason TEXT,
      metadata_json TEXT,
      expires_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS opportunity_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      direction TEXT,
      net_edge_bps REAL,
      estimated_profit_lamports INTEGER,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_engine_events_engine_created_at
      ON engine_events(engine_name, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_opportunity_queue_source_created_at
      ON opportunity_queue(source, created_at DESC);
  `);
}

function getDb(dbPath) {
  const resolvedPath = resolveDbPath(dbPath);
  if (cachedHandle && cachedHandle.path === resolvedPath) {
    return cachedHandle.db;
  }

  ensureParentDir(resolvedPath);
  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  initSchema(db);
  cachedHandle = { path: resolvedPath, db };
  return db;
}

function mapEngineState(row) {
  if (!row) return null;
  return {
    engineName: row.engine_name,
    state: row.state,
    reason: row.reason || null,
    metadata: parseJson(row.metadata_json, {}),
    cooldownUntil: row.cooldown_until || null,
    heartbeatAt: row.heartbeat_at,
    updatedAt: row.updated_at,
  };
}

function mapReservation(row) {
  if (!row) return null;
  return {
    engineName: row.engine_name,
    lamports: Number(row.lamports || 0),
    reason: row.reason || null,
    metadata: parseJson(row.metadata_json, {}),
    expiresAt: row.expires_at || null,
    updatedAt: row.updated_at,
  };
}

function mapOpportunity(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    source: row.source,
    status: row.status,
    direction: row.direction || null,
    netEdgeBps: Number(row.net_edge_bps || 0),
    estimatedProfitLamports: Number(row.estimated_profit_lamports || 0),
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at || null,
  };
}

function appendEngineEvent(engineName, eventType, state, reason, metadata, dbPath) {
  const db = getDb(dbPath);
  db.prepare(`
    INSERT INTO engine_events (
      engine_name,
      event_type,
      state,
      reason,
      metadata_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    engineName,
    eventType,
    normalizeState(state),
    reason || null,
    serializeJson(metadata),
    nowIso()
  );
}

function upsertEngineState(engineName, details = {}, options = {}) {
  const db = getDb(options.dbPath);
  const state = normalizeState(details.state);
  const timestamp = nowIso();
  const heartbeatAt = details.heartbeatAt || timestamp;
  db.prepare(`
    INSERT INTO engine_state (
      engine_name,
      state,
      reason,
      metadata_json,
      cooldown_until,
      heartbeat_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(engine_name) DO UPDATE SET
      state = excluded.state,
      reason = excluded.reason,
      metadata_json = excluded.metadata_json,
      cooldown_until = excluded.cooldown_until,
      heartbeat_at = excluded.heartbeat_at,
      updated_at = excluded.updated_at
  `).run(
    engineName,
    state,
    details.reason || null,
    serializeJson(details.metadata),
    details.cooldownUntil || null,
    heartbeatAt,
    timestamp
  );
  appendEngineEvent(engineName, details.eventType || 'state_update', state, details.reason, details.metadata, options.dbPath);
  return getEngineState(engineName, options);
}

function getEngineState(engineName, options = {}) {
  const db = getDb(options.dbPath);
  const row = db.prepare(`
    SELECT engine_name, state, reason, metadata_json, cooldown_until, heartbeat_at, updated_at
    FROM engine_state
    WHERE engine_name = ?
  `).get(engineName);
  return mapEngineState(row);
}

function listEngineStates(options = {}) {
  const db = getDb(options.dbPath);
  const rows = db.prepare(`
    SELECT engine_name, state, reason, metadata_json, cooldown_until, heartbeat_at, updated_at
    FROM engine_state
    ORDER BY engine_name ASC
  `).all();
  return rows.map(mapEngineState);
}

function setCapitalReservation(engineName, lamports, options = {}) {
  const db = getDb(options.dbPath);
  const normalizedLamports = Math.max(0, Math.floor(Number(lamports || 0)));
  if (normalizedLamports === 0) {
    db.prepare('DELETE FROM capital_reservations WHERE engine_name = ?').run(engineName);
    appendEngineEvent(engineName, 'reservation_cleared', 'idle', options.reason || 'reservation-cleared', options.metadata, options.dbPath);
    return null;
  }

  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO capital_reservations (
      engine_name,
      lamports,
      reason,
      metadata_json,
      expires_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(engine_name) DO UPDATE SET
      lamports = excluded.lamports,
      reason = excluded.reason,
      metadata_json = excluded.metadata_json,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run(
    engineName,
    normalizedLamports,
    options.reason || null,
    serializeJson(options.metadata),
    options.expiresAt || null,
    timestamp
  );
  appendEngineEvent(engineName, 'reservation_updated', 'armed', options.reason || 'capital-reserved', { lamports: normalizedLamports, ...(options.metadata || {}) }, options.dbPath);
  return getCapitalReservation(engineName, options);
}

function getCapitalReservation(engineName, options = {}) {
  const db = getDb(options.dbPath);
  const row = db.prepare(`
    SELECT engine_name, lamports, reason, metadata_json, expires_at, updated_at
    FROM capital_reservations
    WHERE engine_name = ?
  `).get(engineName);
  return mapReservation(row);
}

function listActiveReservations(options = {}) {
  const db = getDb(options.dbPath);
  const asOf = options.asOf || nowIso();
  const rows = db.prepare(`
    SELECT engine_name, lamports, reason, metadata_json, expires_at, updated_at
    FROM capital_reservations
    WHERE expires_at IS NULL OR expires_at > ?
    ORDER BY updated_at DESC
  `).all(asOf);
  return rows.map(mapReservation);
}

function getCapitalSummary({ walletLamports = 0, reserveLamports = 0, dbPath } = {}) {
  const activeReservations = listActiveReservations({ dbPath });
  const reservedLamports = activeReservations.reduce((sum, reservation) => sum + Number(reservation.lamports || 0), 0);
  const walletTotal = Math.max(0, Math.floor(Number(walletLamports || 0)));
  const reserveFloor = Math.max(0, Math.floor(Number(reserveLamports || 0)));
  return {
    walletLamports: walletTotal,
    reserveLamports: reserveFloor,
    reservedLamports,
    availableLamports: Math.max(0, walletTotal - reserveFloor - reservedLamports),
    reservations: activeReservations,
  };
}

function enqueueOpportunity(details = {}, options = {}) {
  const db = getDb(options.dbPath);
  const timestamp = details.createdAt || nowIso();
  const result = db.prepare(`
    INSERT INTO opportunity_queue (
      source,
      status,
      direction,
      net_edge_bps,
      estimated_profit_lamports,
      payload_json,
      created_at,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    details.source || 'unknown',
    details.status || 'open',
    details.direction || null,
    Number(details.netEdgeBps || 0),
    Math.floor(Number(details.estimatedProfitLamports || 0)),
    serializeJson(details.payload),
    timestamp,
    details.expiresAt || null
  );
  return getOpportunityById(result.lastInsertRowid, options);
}

function getOpportunityById(id, options = {}) {
  const db = getDb(options.dbPath);
  const row = db.prepare(`
    SELECT id, source, status, direction, net_edge_bps, estimated_profit_lamports, payload_json, created_at, expires_at
    FROM opportunity_queue
    WHERE id = ?
  `).get(id);
  return mapOpportunity(row);
}

function getLatestOpportunity({ source, includeExpired = false, dbPath } = {}) {
  const db = getDb(dbPath);
  const baseSql = `
    SELECT id, source, status, direction, net_edge_bps, estimated_profit_lamports, payload_json, created_at, expires_at
    FROM opportunity_queue
    WHERE (? IS NULL OR source = ?)
      AND (? = 1 OR expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const row = db.prepare(baseSql).get(source || null, source || null, includeExpired ? 1 : 0, nowIso());
  return mapOpportunity(row);
}

function summarizeCoordinator({ walletLamports = 0, reserveLamports = 0, dbPath } = {}) {
  return {
    states: listEngineStates({ dbPath }),
    capital: getCapitalSummary({ walletLamports, reserveLamports, dbPath }),
    latestOpportunity: getLatestOpportunity({ dbPath }),
  };
}

module.exports = {
  DEFAULT_DB_PATH,
  getDb,
  getEngineState,
  listEngineStates,
  upsertEngineState,
  setCapitalReservation,
  getCapitalReservation,
  listActiveReservations,
  getCapitalSummary,
  enqueueOpportunity,
  getLatestOpportunity,
  summarizeCoordinator,
};
