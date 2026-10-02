'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const ROOT = path.resolve(__dirname, '../..');
const DIR = path.join(ROOT, 'artifacts/paper');
// The active paper ledger is not the worker/dashboard default state file name.
// Attach every service to it unless the caller overrides the path explicitly.
const WORKER_STATE = process.env.PAPER_STATE_FILE ? path.resolve(process.env.PAPER_STATE_FILE) : path.join(DIR, 'functionality-20260915.json');
const DASHBOARD_STATE = process.env.LOCAL_PAPER_STATE_FILE ? path.resolve(process.env.LOCAL_PAPER_STATE_FILE) : WORKER_STATE;
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function archiveStaleLock(file) {
  const lock = path.join(DIR, file);
  if (!fs.existsSync(lock)) return;
  const pid = Number(String(fs.readFileSync(lock, 'utf8')).trim());
  if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) throw new Error(`${file} is held by live pid ${pid}; refusing to start another service.`);
  const stale = `${lock}.stale-${Date.now()}`;
  fs.renameSync(lock, stale);
  console.log(`Archived stale ${file} -> ${path.basename(stale)}`);
}
async function available(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  archiveStaleLock('live-worker.lock');
  archiveStaleLock('productive-treasury.lock');
  let port = 8790;
  while (port < 8800 && !(await available(port))) port++;
  if (port === 8800) throw new Error('No free dashboard port.');
  const spawnService = (name, file, env = {}) => {
    const log = fs.openSync(path.join(DIR, `${name}.log`), 'a', 0o600);
    const child = spawn(process.execPath, ['--require', 'ts-node/register/transpile-only', path.join(__dirname, file)], {
      cwd: ROOT, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    child.unref();
    return child.pid;
  };
  const worker = spawnService('live-worker', 'live_paper_worker.js', { PAPER_STATE_FILE: WORKER_STATE });
  const treasury = spawnService('productive-treasury', 'productive_treasury_worker.ts');
  const dashboard = spawnService('live-dashboard', 'local_paper_dashboard.ts', { LOCAL_PAPER_DASHBOARD_PORT: String(port), LOCAL_PAPER_DASHBOARD_HOST: '127.0.0.1', LOCAL_PAPER_STATE_FILE: DASHBOARD_STATE });
  const services = { worker, treasury, dashboard, url: `http://127.0.0.1:${port}`, startedAt: Date.now(), stateFile: WORKER_STATE, dashboardStateFile: DASHBOARD_STATE };
  fs.writeFileSync(path.join(DIR, 'local-services.json'), JSON.stringify(services, null, 2));
  console.log(JSON.stringify(services));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
