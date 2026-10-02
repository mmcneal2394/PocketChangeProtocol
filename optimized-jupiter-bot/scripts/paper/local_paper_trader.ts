import fs from 'fs';
import path from 'path';

const ROTATION_MS = 10 * 60_000;
const MAX_HOLD_MS = 4 * 60 * 60_000;

export type PaperEventType = 'entry' | 'rotation_75' | 'force_close_4h' | 'stop_loss' | 'take_profit' | 'inactivity_exit' | 'exit_pending' | 'mark_stale' | 'candidate_rejected';

export interface PaperCandidate {
  mint: string;
  symbol?: string;
  decision: 'paper_entry_candidate' | 'provisional_candidate' | 'watch_only' | 'reject';
  entryPriceSol?: number;
  reasons?: string[];
}

export interface PaperMark {
  priceSol: number;
  updatedAt: number;
  fresh: boolean;
  exitQuotes?: Array<{ tokenAmount: number; proceedsSol: number }>;
}

export interface RpcUsage {
  requests: number;
  successes?: number;
  errors?: number;
  averageLatencyMs?: number;
}

export interface PipelineStatus {
  status: 'fresh' | 'stale' | 'missing' | 'conflict';
  updatedAt?: number;
  detail?: string;
}

export interface LocalPaperTraderInput {
  schemaVersion: 'local-paper-trader-input/v1';
  generatedAt: number;
  candidates?: PaperCandidate[];
  marksByMint?: Record<string, PaperMark>;
  rpcUsage?: Record<string, RpcUsage>;
  pipeline?: Record<string, PipelineStatus>;
  trafficByMint?: Record<string, { checkedAt: number; quietSince: number | null }>;
}

export interface PaperPosition {
  id: string;
  mint: string;
  symbol: string;
  openedAt: number;
  entryPriceSol: number;
  originalCapitalSol: number;
  originalTokenAmount: number;
  remainingTokenAmount: number;
  rotationAt: number | null;
  lastMarkSol: number | null;
  lastMarkAt: number | null;
  // High-water mark of net exit value over entry cost; drives breakeven/trailing stops.
  peakRatio?: number;
  realizedPnlSol: number;
  closedAt: number | null;
  closeReason: string | null;
  exitPending?: { reason: string; triggeredAt: number };
  exitDelayMs?: number;
}

export interface PaperEvent {
  id: string;
  ts: number;
  type: PaperEventType;
  mint: string;
  symbol: string;
  detail: string;
  pnlSol?: number;
}

export interface LocalPaperTraderState {
  schemaVersion: 'local-paper-trader-state/v1';
  generatedAt: number;
  execution: {
    mode: 'paper_only';
    paperExecution: 'enabled';
    signing: 'disabled';
    broadcasting: 'disabled';
    walletAccess: 'disabled';
  };
  config: {
    startingCapitalSol: number;
    initialPositionSol: number;
    maxOpenPositions: number;
    modeledFeeBps: number;
    rotationMs: number;
    maxHoldMs: number;
    rotationTrigger?: 'position_age' | 'inactivity';
    stopLossPct?: number;
    takeProfitPct?: number;
    // Net return at which the stop moves to entry (0), disabling the breakeven step.
    breakevenAtPct?: number;
    // Giveback below the peak once the breakeven step has activated.
    trailingStopPct?: number;
    inactivityExit?: 'full' | 'rotate_75';
  };
  availableCapitalSol: number;
  positions: PaperPosition[];
  events: PaperEvent[];
  marksByMint: Record<string, PaperMark>;
  rpcUsage: Record<string, RpcUsage>;
  pipeline: Record<string, PipelineStatus>;
}

export interface LocalPaperTraderSummary {
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  largestWinSol: number;
  largestWinSymbol: string | null;
  closedPositions: number;
  openPositions: number;
  rotatedRunners: number;
  totalRpcRequests: number;
}

function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function validMint(mint: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
}

function newEvent(type: PaperEventType, position: Pick<PaperPosition, 'id' | 'mint' | 'symbol'>, ts: number, detail: string, pnlSol?: number): PaperEvent {
  return {
    id: `${position.id}:${type}:${ts}`,
    ts,
    type,
    mint: position.mint,
    symbol: position.symbol,
    detail,
    ...(pnlSol === undefined ? {} : { pnlSol: Number(pnlSol.toFixed(9)) }),
  };
}

export function createLocalPaperTraderState(config: Partial<LocalPaperTraderState['config']> = {}): LocalPaperTraderState {
  const startingCapitalSol = Math.max(0, safeNumber(config.startingCapitalSol, 1));
  return {
    schemaVersion: 'local-paper-trader-state/v1',
    generatedAt: Date.now(),
    execution: {
      mode: 'paper_only',
      paperExecution: 'enabled',
      signing: 'disabled',
      broadcasting: 'disabled',
      walletAccess: 'disabled',
    },
    config: {
      startingCapitalSol,
      initialPositionSol: Math.max(0.000001, safeNumber(config.initialPositionSol, 0.05)),
      maxOpenPositions: Math.max(1, Math.floor(safeNumber(config.maxOpenPositions, 4))),
      modeledFeeBps: Math.max(0, safeNumber(config.modeledFeeBps, 100)),
      rotationMs: ROTATION_MS,
      maxHoldMs: MAX_HOLD_MS,
      rotationTrigger: config.rotationTrigger || 'position_age',
      ...(config.stopLossPct !== undefined ? { stopLossPct: config.stopLossPct } : {}),
      ...(config.takeProfitPct !== undefined ? { takeProfitPct: config.takeProfitPct } : {}),
      ...(config.breakevenAtPct !== undefined ? { breakevenAtPct: config.breakevenAtPct } : {}),
      ...(config.trailingStopPct !== undefined ? { trailingStopPct: config.trailingStopPct } : {}),
      ...(config.inactivityExit ? { inactivityExit: config.inactivityExit } : {}),
    },
    availableCapitalSol: startingCapitalSol,
    positions: [],
    events: [],
    marksByMint: {},
    rpcUsage: {},
    pipeline: {},
  };
}

function feeMultiplier(feeBps: number): number {
  return Math.max(0, 1 - feeBps / 10_000);
}

export function isFreshMark(mark: PaperMark | undefined, now: number): boolean {
  return !!mark?.fresh && Number.isFinite(mark.priceSol) && mark.priceSol > 0 &&
    Number.isFinite(mark.updatedAt) && mark.updatedAt <= now && now - mark.updatedAt <= 30000;
}

function quotedValue(tokens: number, mark: PaperMark, feeBps: number): number | null {
  if (mark.exitQuotes) {
    const quote = mark.exitQuotes.find(q => Math.abs(q.tokenAmount - tokens) <= Math.max(1e-10, tokens * 1e-9));
    return quote && Number.isFinite(quote.proceedsSol) && quote.proceedsSol > 0
      ? quote.proceedsSol * feeMultiplier(feeBps) : null;
  }
  return tokens * mark.priceSol * feeMultiplier(feeBps);
}

function currentExitValue(position: PaperPosition, mark: PaperMark | undefined, feeBps: number): number | null {
  if (!mark?.fresh || safeNumber(mark.priceSol) <= 0) return null;
  return quotedValue(position.remainingTokenAmount, mark, feeBps);
}

function positionEntryCost(position: PaperPosition): number {
  return position.originalCapitalSol * (position.remainingTokenAmount / position.originalTokenAmount);
}

// Net stop threshold below entry, or null when no stop is configured. Once the
// position has banked the breakeven step, the stop ratchets up to entry and then
// trails the peak, so a fade after real upside exits near flat instead of riding
// back through the base stop. A trailing threshold is legitimately zero/negative.
function effectiveStopPct(config: LocalPaperTraderState['config'], position: PaperPosition): number | null {
  const baseStop = config.stopLossPct;
  if (typeof baseStop !== 'number' || !Number.isFinite(baseStop) || baseStop <= 0 || baseStop >= 100) return null;
  const breakeven = config.breakevenAtPct;
  const trail = config.trailingStopPct;
  if (typeof breakeven !== 'number' || !Number.isFinite(breakeven) || breakeven <= 0) return baseStop;
  const peak = Number(position.peakRatio);
  if (!Number.isFinite(peak) || peak < 1 + breakeven / 100) return baseStop;
  const trailPct = typeof trail === 'number' && Number.isFinite(trail) && trail > 0 ? trail : 0;
  // Stop value = peakValue * (1 - trail/100); expressed as a net % below entry.
  return (1 - peak * (1 - trailPct / 100)) * 100;
}

function openPositions(state: LocalPaperTraderState): PaperPosition[] {
  return state.positions.filter((position) => position.closedAt === null);
}

function appendEvent(state: LocalPaperTraderState, event: PaperEvent) {
  if (!state.events.some((existing) => existing.id === event.id)) state.events.unshift(event);
  state.events = state.events.slice(0, 500);
}

export function rotationDue(state: LocalPaperTraderState, position: PaperPosition, now: number, traffic?: { checkedAt: number; quietSince: number | null }): boolean {
  if (state.config.rotationTrigger !== 'inactivity') return now - position.openedAt >= state.config.rotationMs;
  return !!traffic && Number.isFinite(traffic.checkedAt) && traffic.checkedAt <= now && now - traffic.checkedAt <= 30000 &&
    traffic.quietSince !== null && Number.isFinite(traffic.quietSince) &&
    now - Math.max(position.openedAt, traffic.quietSince) >= state.config.rotationMs;
}

function applyPositionLifecycle(state: LocalPaperTraderState, now: number, marksByMint: Record<string, PaperMark>, trafficByMint: LocalPaperTraderInput['trafficByMint']) {
  for (const position of openPositions(state)) {
    const latch = (reason: string) => {
      if (!position.exitPending) {
        position.exitPending = { reason, triggeredAt: now };
        appendEvent(state, newEvent('exit_pending', position, now, `Exit requested: ${reason}; awaiting valid sell quote.`));
      }
    };
    const initialMark = marksByMint[position.mint];
    const initialValue = isFreshMark(initialMark, now) ? currentExitValue(position, initialMark, state.config.modeledFeeBps) : null;
    // An already-armed stop or target keeps firing until a sell quote lands, so
    // recovery still executes regardless of where the price sits by then.
    const threshold = effectiveStopPct(state.config, position);
    if (initialValue !== null && threshold !== null && initialValue <= positionEntryCost(position) * (1 - threshold / 100)) latch('stop_loss');
    const target = state.config.takeProfitPct;
    if (initialValue !== null && typeof target === 'number' && Number.isFinite(target) && target > 0 && initialValue >= positionEntryCost(position) * (1 + target / 100)) latch('take_profit');
    if (now - position.openedAt >= state.config.maxHoldMs) latch('max_hold_4h');
    else if (state.config.inactivityExit === 'full' && state.config.rotationTrigger === 'inactivity' && rotationDue(state, position, now, trafficByMint?.[position.mint])) latch('inactivity_10m');
    const mark = marksByMint[position.mint];
    if (!isFreshMark(mark, now)) {
      appendEvent(state, newEvent('mark_stale', position, now, 'No fresh paper mark; lifecycle unchanged.'));
      continue;
    }

    position.lastMarkSol = mark.priceSol;
    position.lastMarkAt = mark.updatedAt;
    const heldMs = now - position.openedAt;
    const exitValue = currentExitValue(position, mark, state.config.modeledFeeBps);
    if (exitValue === null) continue;

    const remainingCost = positionEntryCost(position);
    // Track the net high-water mark before the stop test so the trailing stop can
    // act on the same mark that set a new peak.
    const ratio = remainingCost > 0 ? exitValue / remainingCost : 1;
    position.peakRatio = Math.max(Number.isFinite(position.peakRatio) ? (position.peakRatio as number) : 1, ratio);
    const stop = effectiveStopPct(state.config, position);
    if (stop !== null && exitValue <= remainingCost * (1 - stop / 100)) latch('stop_loss');
    if (position.exitPending?.reason === 'stop_loss' || position.exitPending?.reason === 'take_profit') {
      const reason = position.exitPending.reason;
      const pnl = exitValue - remainingCost;
      position.realizedPnlSol += pnl;
      state.availableCapitalSol += exitValue;
      position.remainingTokenAmount = 0;
      position.closedAt = now;
      position.exitDelayMs = now - position.exitPending.triggeredAt;
      position.closeReason = reason;
      appendEvent(state, newEvent(reason, position, now,
        `Closed all remaining tokens after ${reason} trigger (${reason === 'stop_loss' ? `${Number.isFinite(stop) ? (stop as number).toFixed(2) : 'base'}` : target}% net) using net paper exit quote.`, pnl));
      continue;
    }

    if (position.exitPending?.reason === 'inactivity_10m') {
      const pnl = exitValue - remainingCost;
      position.realizedPnlSol += pnl;
      state.availableCapitalSol += exitValue;
      position.remainingTokenAmount = 0;
      position.closedAt = now;
      position.exitDelayMs = now - position.exitPending.triggeredAt;
      position.closeReason = 'inactivity_10m';
      appendEvent(state, newEvent('inactivity_exit', position, now,
        'Closed all remaining tokens after 10 minutes of verified zero traffic.', pnl));
      continue;
    }

    if (position.rotationAt === null && heldMs < state.config.maxHoldMs && rotationDue(state, position, now, trafficByMint?.[position.mint])) {
      const rotationTokens = position.originalTokenAmount * 0.75;
      const rotationProceeds = quotedValue(rotationTokens, mark, state.config.modeledFeeBps);
      if (rotationProceeds === null) continue;
      const rotationPnl = rotationProceeds - (position.originalCapitalSol * 0.75);
      position.remainingTokenAmount = Math.max(0, position.remainingTokenAmount - rotationTokens);
      position.realizedPnlSol += rotationPnl;
      position.rotationAt = now;
      state.availableCapitalSol += rotationProceeds;
      appendEvent(state, newEvent(
        'rotation_75',
        position,
        now,
        state.config.rotationTrigger === 'inactivity' ? 'Rotated 75% after 10 minutes of verified inactivity; 25% runner remains.' : 'Rotated 75% of the original position after 10 minutes; 25% runner remains.',
        rotationPnl,
      ));
    }

    if (position.exitPending?.reason === 'max_hold_4h') {
      const remainderValue = currentExitValue(position, mark, state.config.modeledFeeBps);
      if (remainderValue === null) continue;
      const closePnl = remainderValue - positionEntryCost(position);
      position.realizedPnlSol += closePnl;
      state.availableCapitalSol += remainderValue;
      position.remainingTokenAmount = 0;
      position.closedAt = now;
      position.exitDelayMs = now - position.exitPending.triggeredAt;
      position.closeReason = 'max_hold_4h';
      appendEvent(state, newEvent(
        'force_close_4h',
        position,
        now,
        'Closed remaining runner at the four-hour maximum hold.',
        closePnl,
      ));
    }
  }
}

function applyCandidates(state: LocalPaperTraderState, now: number, input: LocalPaperTraderInput) {
  const activeMints = new Set(openPositions(state).map((position) => position.mint));
  const seenMints = new Set(state.positions.map((position) => position.mint));
  for (const candidate of input.candidates || []) {
    if (candidate.decision !== 'paper_entry_candidate') continue;
    if (!validMint(candidate.mint) || activeMints.has(candidate.mint) || seenMints.has(candidate.mint)) continue;
    if (openPositions(state).length >= state.config.maxOpenPositions) break;
    if (state.availableCapitalSol < state.config.initialPositionSol) break;

    const mark = input.marksByMint?.[candidate.mint];
    const entryPriceSol = safeNumber(candidate.entryPriceSol || mark?.priceSol);
    if (!isFreshMark(mark, now) || entryPriceSol <= 0) {
      const rejected = { id: `candidate:${candidate.mint}`, mint: candidate.mint, symbol: candidate.symbol || candidate.mint.slice(0, 8) };
      appendEvent(state, newEvent('candidate_rejected', rejected, now, 'Candidate lacked a fresh paper entry mark.'));
      continue;
    }

    const originalCapitalSol = state.config.initialPositionSol;
    const tokens = originalCapitalSol * feeMultiplier(state.config.modeledFeeBps) / entryPriceSol;
    const position: PaperPosition = {
      id: `${candidate.mint}:${now}`,
      mint: candidate.mint,
      symbol: candidate.symbol || candidate.mint.slice(0, 8),
      openedAt: now,
      entryPriceSol,
      originalCapitalSol,
      originalTokenAmount: tokens,
      remainingTokenAmount: tokens,
      rotationAt: null,
      lastMarkSol: mark.priceSol,
      lastMarkAt: mark.updatedAt,
      peakRatio: 1,
      realizedPnlSol: 0,
      closedAt: null,
      closeReason: null,
    };
    state.availableCapitalSol -= originalCapitalSol;
    state.positions.unshift(position);
    activeMints.add(candidate.mint);
    seenMints.add(candidate.mint);
    appendEvent(state, newEvent('entry', position, now, `Opened paper position from staged launch radar at ${entryPriceSol.toFixed(9)} SOL.`));
  }
}

export function runLocalPaperTrader(state: LocalPaperTraderState, input: LocalPaperTraderInput): LocalPaperTraderState {
  if (input?.schemaVersion !== 'local-paper-trader-input/v1') throw new Error('schemaVersion must be local-paper-trader-input/v1.');
  if (state?.schemaVersion !== 'local-paper-trader-state/v1') throw new Error('state schemaVersion must be local-paper-trader-state/v1.');
  if (state.execution.mode !== 'paper_only' || state.execution.signing !== 'disabled' || state.execution.broadcasting !== 'disabled') {
    throw new Error('Local paper trader requires paper-only execution with signing and broadcasting disabled.');
  }

  const now = safeNumber(input.generatedAt, Date.now());
  state.marksByMint = Object.fromEntries(Object.entries(input.marksByMint || {}).map(([mint, mark]) => [mint, { ...mark, fresh: isFreshMark(mark, now) }]));
  state.rpcUsage = input.rpcUsage || state.rpcUsage;
  state.pipeline = input.pipeline || state.pipeline;
  applyPositionLifecycle(state, now, state.marksByMint, input.trafficByMint);
  applyCandidates(state, now, input);
  state.generatedAt = now;
  return state;
}

export function summarizeLocalPaperTrader(state: LocalPaperTraderState, marksByMint: Record<string, PaperMark> = {}): LocalPaperTraderSummary {
  const closed = state.positions.filter((position) => position.closedAt !== null);
  const realizedPnlSol = state.positions.reduce((sum, position) => sum + position.realizedPnlSol, 0);
  const unrealizedPnlSol = openPositions(state).reduce((sum, position) => {
    const value = currentExitValue(position, marksByMint[position.mint], state.config.modeledFeeBps);
    return sum + (value === null ? 0 : value - positionEntryCost(position));
  }, 0);
  const best = [...closed].sort((left, right) => right.realizedPnlSol - left.realizedPnlSol)[0];
  return {
    realizedPnlSol: Number(realizedPnlSol.toFixed(9)),
    unrealizedPnlSol: Number(unrealizedPnlSol.toFixed(9)),
    largestWinSol: Number(Math.max(0, best?.realizedPnlSol || 0).toFixed(9)),
    largestWinSymbol: best?.realizedPnlSol > 0 ? best.symbol : null,
    closedPositions: closed.length,
    openPositions: openPositions(state).length,
    rotatedRunners: openPositions(state).filter((position) => position.rotationAt !== null).length,
    totalRpcRequests: Object.values(state.rpcUsage).reduce((sum, usage) => sum + Math.max(0, safeNumber(usage.requests)), 0),
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function parseArgs(args: string[]) {
  const valueFor = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  return {
    input: valueFor('--input'),
    state: valueFor('--state'),
    init: args.includes('--init'),
    startingCapitalSol: valueFor('--starting-capital-sol'),
    initialPositionSol: valueFor('--initial-position-sol'),
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.state || (!args.init && !args.input)) {
    console.error('Usage: ts-node scripts/paper/local_paper_trader.ts --init --state <state.json> [--starting-capital-sol <sol>] [--initial-position-sol <sol>] | --input <snapshot.json> --state <state.json>');
    process.exit(1);
  }
  if (args.init) {
    if (fs.existsSync(args.state)) throw new Error('Refusing to overwrite an existing paper ledger.');
    const initial = createLocalPaperTraderState({
      startingCapitalSol: safeNumber(args.startingCapitalSol, 1),
      initialPositionSol: safeNumber(args.initialPositionSol, 0.05),
    });
    fs.mkdirSync(path.dirname(args.state), { recursive: true });
    fs.writeFileSync(args.state, `${JSON.stringify(initial, null, 2)}\n`);
    console.log(JSON.stringify({ execution: initial.execution, initialized: args.state }, null, 2));
    process.exit(0);
  }
  const state = fs.existsSync(args.state)
    ? readJson<LocalPaperTraderState>(args.state)
    : createLocalPaperTraderState({
      startingCapitalSol: safeNumber(args.startingCapitalSol, 1),
      initialPositionSol: safeNumber(args.initialPositionSol, 0.05),
    });
  const payload = readJson<LocalPaperTraderInput>(args.input as string);
  const next = runLocalPaperTrader(state, payload);
  fs.mkdirSync(path.dirname(args.state), { recursive: true });
  fs.writeFileSync(args.state, `${JSON.stringify(next, null, 2)}\n`);
  const summary = summarizeLocalPaperTrader(next, payload.marksByMint);
  console.log(JSON.stringify({ execution: next.execution, summary }, null, 2));
}
