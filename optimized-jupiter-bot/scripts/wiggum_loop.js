#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = process.cwd();
const DEFAULT_STATE_ROOT = path.join(ROOT, '.swarm', 'wiggum');
const DEFAULT_HEARTBEAT_TTL_SEC = 180;
const DEFAULT_FINAL_HEARTBEAT_TTL_SEC = 3600;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60000;
const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434/api/chat';
let activeHeartbeat = null;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith('--')) {
      args._.push(part);
      continue;
    }
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, fallback, minValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (Number.isFinite(minValue)) {
    return Math.max(minValue, parsed);
  }
  return parsed;
}

function formatTemplate(template, values) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function trimForPrompt(value, limit) {
  const text = String(value || '');
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n...\n[truncated ${text.length - limit} chars]`;
}

function createUpstashClient() {
  const baseUrl = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!baseUrl || !token) {
    return null;
  }

  const target = new URL(baseUrl);
  const transport = target.protocol === 'https:' ? https : http;
  const normalizedPath = target.pathname && target.pathname !== '/' ? target.pathname.replace(/\/$/, '') : '';

  return {
    async command(args) {
      const body = JSON.stringify(args);
      return new Promise((resolve, reject) => {
        const req = transport.request({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: `${normalizedPath}${target.search || ''}`,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 10000,
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`Upstash HTTP ${res.statusCode}: ${data.slice(0, 240)}`));
              return;
            }
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch (error) {
              reject(new Error(`Failed to parse Upstash response: ${data.slice(0, 240)}`));
            }
          });
        });

        req.on('timeout', () => {
          req.destroy(new Error('Upstash request timed out'));
        });
        req.on('error', (error) => reject(error));
        req.write(body);
        req.end();
      });
    },
  };
}

function createHeartbeatPublisher({ loopName, configPath, stateFile, task, maxIterations, initialIteration }) {
  const client = createUpstashClient();
  const heartbeatTtlSec = clampNumber(process.env.WIGGUM_HEARTBEAT_TTL_SEC, DEFAULT_HEARTBEAT_TTL_SEC, 30);
  const finalHeartbeatTtlSec = clampNumber(process.env.WIGGUM_FINAL_HEARTBEAT_TTL_SEC, DEFAULT_FINAL_HEARTBEAT_TTL_SEC, heartbeatTtlSec);
  const intervalMs = clampNumber(process.env.WIGGUM_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS, 15000);
  const heartbeatKey = `health:wiggum:${loopName}`;
  let intervalHandle = null;
  let publishing = null;
  const snapshot = {
    loopName,
    task,
    configPath,
    stateFile,
    heartbeatKey,
    pid: process.pid,
    hostname: os.hostname(),
    maxIterations,
    iteration: initialIteration,
    status: 'booting',
    phase: 'starting',
    result: 'starting',
    updatedAt: nowIso(),
  };

  async function publish(ttlSec = heartbeatTtlSec) {
    if (!client) {
      return false;
    }
    snapshot.updatedAt = nowIso();
    if (publishing) {
      return publishing;
    }
    const payload = JSON.stringify(snapshot);
    publishing = client.command(['SETEX', heartbeatKey, String(ttlSec), payload])
      .then(() => true)
      .catch((error) => {
        console.error(`[WIGGUM] Upstash heartbeat failed: ${error.message}`);
        return false;
      })
      .finally(() => {
        publishing = null;
      });
    return publishing;
  }

  return {
    enabled: Boolean(client),
    heartbeatKey,
    touch(patch = {}, ttlSec = heartbeatTtlSec) {
      Object.assign(snapshot, patch, { updatedAt: nowIso() });
      return publish(ttlSec);
    },
    start() {
      if (!client || intervalHandle) {
        return;
      }
      publish().catch(() => {});
      intervalHandle = setInterval(() => {
        publish().catch(() => {});
      }, intervalMs);
      if (typeof intervalHandle.unref === 'function') {
        intervalHandle.unref();
      }
    },
    async finish(patch = {}, ttlSec = finalHeartbeatTtlSec) {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      if (!client) {
        return false;
      }
      Object.assign(snapshot, patch, { updatedAt: nowIso() });
      return publish(ttlSec);
    },
  };
}

function runCommand(command, options = {}) {
  const cwd = options.cwd || ROOT;
  const env = { ...process.env, ...(options.env || {}) };
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('close', (code, signal) => {
      resolve({ code: code ?? 1, signal: signal || null, stdout, stderr });
    });

    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      resolve({ code: 1, signal: null, stdout, stderr, error: error.message });
    });
  });
}

function isDefaultLocalOllamaEndpoint(endpoint) {
  try {
    const target = new URL(endpoint || DEFAULT_OLLAMA_ENDPOINT);
    const hostname = target.hostname || '';
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    return (hostname === '127.0.0.1' || hostname === 'localhost') && port === 11434;
  } catch {
    return false;
  }
}

function isOptionalLocalOllamaMiss(error, endpoint) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return isDefaultLocalOllamaEndpoint(endpoint) && (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH');
}

function ollamaChat({ model, prompt, systemPrompt, endpoint, timeoutMs }) {
  const target = new URL(endpoint);
  const transport = target.protocol === 'https:' ? https : http;
  const body = JSON.stringify({
    model,
    stream: false,
    messages: [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      { role: 'user', content: prompt },
    ],
  });

  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed?.message?.content || '');
        } catch (error) {
          reject(new Error(`Failed to parse Ollama response: ${data.slice(0, 400)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Ollama request timed out'));
    });
    req.on('error', (error) => reject(error));
    req.write(body);
    req.end();
  });
}

function buildJudge(config, workerResult, validatorResult) {
  const validator = config.validator || {};
  const successExitCodes = Array.isArray(validator.successExitCodes) && validator.successExitCodes.length > 0
    ? validator.successExitCodes.map((value) => Number(value))
    : [0];
  const stdout = validatorResult.stdout || '';
  const stderr = validatorResult.stderr || '';
  const marker = validator.successMarker;
  const stdoutIncludes = Array.isArray(validator.stdoutIncludes) ? validator.stdoutIncludes : [];
  const stderrExcludes = Array.isArray(validator.stderrExcludes) ? validator.stderrExcludes : [];
  const requireWorkerSuccess = config.requireWorkerSuccess !== false;

  const checks = [];
  if (requireWorkerSuccess) {
    checks.push({ name: 'worker_exit_code', pass: Number(workerResult.code) === 0 });
  }
  checks.push({ name: 'validator_exit_code', pass: successExitCodes.includes(Number(validatorResult.code)) });
  if (marker) {
    checks.push({ name: 'success_marker', pass: stdout.includes(marker) || stderr.includes(marker) });
  }
  for (const token of stdoutIncludes) {
    checks.push({ name: `stdout_includes:${token}`, pass: stdout.includes(token) });
  }
  for (const token of stderrExcludes) {
    checks.push({ name: `stderr_excludes:${token}`, pass: !stderr.includes(token) });
  }

  return {
    passed: checks.every((check) => check.pass),
    checks,
  };
}

function defaultReviewPrompt(config, context) {
  return [
    `Task: ${config.task}`,
    `Iteration: ${context.iteration}`,
    '',
    'Worker command output:',
    trimForPrompt(context.workerStdout, 6000),
    '',
    'Worker command errors:',
    trimForPrompt(context.workerStderr, 4000),
    '',
    'Validator command output:',
    trimForPrompt(context.validatorStdout, 4000),
    '',
    'Validator command errors:',
    trimForPrompt(context.validatorStderr, 4000),
    '',
    'Return a short diagnosis with:',
    '1. whether progress was made',
    '2. the most likely blocker',
    '3. the next concrete action',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || !args.config) {
    console.log('Usage: node scripts/maintain/wiggum_loop.js --config <path-to-config.json>');
    process.exit(args.config ? 0 : 1);
  }

  const configPath = path.resolve(ROOT, args.config);
  const config = loadJson(configPath);
  const loopName = config.name || path.basename(configPath, path.extname(configPath));
  const stateRoot = path.resolve(ROOT, config.stateRoot || DEFAULT_STATE_ROOT);
  const loopDir = path.join(stateRoot, loopName);
  const runsDir = path.join(loopDir, 'runs');
  const stateFile = path.join(loopDir, 'state.json');
  ensureDir(runsDir);
  const maxIterations = Number(config.maxIterations || 10);

  const state = fs.existsSync(stateFile)
    ? loadJson(stateFile)
    : {
        name: loopName,
        createdAt: nowIso(),
        configPath,
        task: config.task || '',
        iterations: [],
        completed: false,
      };
  const shouldResetTerminalState = Array.isArray(state.iterations) && (
    state.completed === true
    || state.result === 'max_iterations_exceeded'
    || state.result === 'success'
    || state.iterations.length >= maxIterations
  );
  if (shouldResetTerminalState) {
    state.previousRun = {
      completed: Boolean(state.completed),
      result: state.result || null,
      updatedAt: state.updatedAt || null,
      iterationCount: state.iterations.length,
    };
    state.iterations = [];
    state.completed = false;
    state.result = 'starting';
    state.lastReview = '';
    state.updatedAt = nowIso();
  }

  const delayMs = Number(config.delayMs || 5000);
  const worker = config.worker || {};
  const validator = config.validator || {};
  const reviewer = config.reviewer || {};
  const heartbeat = createHeartbeatPublisher({
    loopName,
    configPath,
    stateFile,
    task: config.task || '',
    maxIterations,
    initialIteration: state.iterations.length,
  });
  activeHeartbeat = heartbeat;

  if (!config.task) {
    throw new Error('Config must include a task');
  }
  if (!worker.command) {
    throw new Error('Config must include worker.command');
  }
  if (!validator.command) {
    throw new Error('Config must include validator.command');
  }

  console.log(`[WIGGUM] Starting loop '${loopName}'`);
  console.log(`[WIGGUM] Task: ${config.task}`);
  console.log(`[WIGGUM] Max iterations: ${maxIterations}`);
  if (heartbeat.enabled) {
    console.log(`[WIGGUM] Upstash heartbeat enabled at ${heartbeat.heartbeatKey}`);
  }
  heartbeat.start();
  await heartbeat.touch({
    status: 'running',
    phase: 'idle',
    result: 'running',
    iteration: state.iterations.length,
    lastReview: state.lastReview || '',
    completed: false,
  });

  for (let iteration = state.iterations.length + 1; iteration <= maxIterations; iteration += 1) {
    const startedAt = nowIso();
    const iterationDir = path.join(runsDir, `iteration-${String(iteration).padStart(3, '0')}`);
    ensureDir(iterationDir);
    console.log(`\n[WIGGUM] ===== Iteration ${iteration}/${maxIterations} =====`);
    await heartbeat.touch({
      status: 'running',
      phase: 'worker',
      result: 'running',
      iteration,
      iterationStartedAt: startedAt,
      completed: false,
    });

    const previousReview = state.iterations.length > 0
      ? state.iterations[state.iterations.length - 1].review || ''
      : '';

    const templateValues = {
      iteration,
      loop_name: loopName,
      task: config.task,
      previous_review: previousReview,
      state_file: stateFile,
      iteration_dir: iterationDir,
      config_path: configPath,
    };

    const workerCommand = formatTemplate(worker.command, templateValues);
    const workerResult = await runCommand(workerCommand, {
      cwd: path.resolve(ROOT, worker.cwd || '.'),
      env: worker.env,
    });
    await heartbeat.touch({
      phase: 'validator',
      lastWorkerExitCode: workerResult.code,
      lastWorkerSignal: workerResult.signal,
    });

    const workerStdoutFile = path.join(iterationDir, 'worker.stdout.log');
    const workerStderrFile = path.join(iterationDir, 'worker.stderr.log');
    fs.writeFileSync(workerStdoutFile, workerResult.stdout || '', 'utf8');
    fs.writeFileSync(workerStderrFile, workerResult.stderr || '', 'utf8');

    const validatorValues = {
      ...templateValues,
      worker_stdout_file: workerStdoutFile,
      worker_stderr_file: workerStderrFile,
    };
    const validatorCommand = formatTemplate(validator.command, validatorValues);
    const validatorResult = await runCommand(validatorCommand, {
      cwd: path.resolve(ROOT, validator.cwd || '.'),
      env: validator.env,
    });
    await heartbeat.touch({
      phase: reviewer.enabled === false ? 'judging' : 'reviewer',
      lastValidatorExitCode: validatorResult.code,
      lastValidatorSignal: validatorResult.signal,
    });

    const validatorStdoutFile = path.join(iterationDir, 'validator.stdout.log');
    const validatorStderrFile = path.join(iterationDir, 'validator.stderr.log');
    fs.writeFileSync(validatorStdoutFile, validatorResult.stdout || '', 'utf8');
    fs.writeFileSync(validatorStderrFile, validatorResult.stderr || '', 'utf8');

    const judge = buildJudge(config, workerResult, validatorResult);
    console.log(`[WIGGUM] Validator status: ${judge.passed ? 'PASS' : 'FAIL'}`);

    let review = '';
    if (reviewer.enabled !== false) {
      const prompt = reviewer.prompt
        ? formatTemplate(reviewer.prompt, {
            ...templateValues,
            worker_stdout: trimForPrompt(workerResult.stdout, 6000),
            worker_stderr: trimForPrompt(workerResult.stderr, 4000),
            validator_stdout: trimForPrompt(validatorResult.stdout, 4000),
            validator_stderr: trimForPrompt(validatorResult.stderr, 4000),
          })
        : defaultReviewPrompt(config, {
            iteration,
            workerStdout: workerResult.stdout,
            workerStderr: workerResult.stderr,
            validatorStdout: validatorResult.stdout,
            validatorStderr: validatorResult.stderr,
          });

      try {
        const reviewerEndpoint = reviewer.endpoint || process.env.OLLAMA_URL || DEFAULT_OLLAMA_ENDPOINT;
        review = await ollamaChat({
          model: reviewer.model || process.env.GEMMA4_MODEL || process.env.OLLAMA_MODEL || 'dmind-risk',
          prompt,
          systemPrompt: reviewer.systemPrompt || 'You are a loop reviewer. Be concise, practical, and action-oriented.',
          endpoint: reviewerEndpoint,
          timeoutMs: Number(reviewer.timeoutMs || 120000),
        });
      } catch (error) {
        if (isOptionalLocalOllamaMiss(error, reviewer.endpoint || process.env.OLLAMA_URL || DEFAULT_OLLAMA_ENDPOINT)) {
          review = '[reviewer-skipped] Local Ollama is not running on 127.0.0.1:11434.';
          console.warn('[WIGGUM] Reviewer skipped: local Ollama endpoint is unavailable.');
        } else {
          review = `[reviewer-error] ${error.message}`;
        }
      }
      fs.writeFileSync(path.join(iterationDir, 'review.txt'), review, 'utf8');
    }

    const record = {
      iteration,
      startedAt,
      finishedAt: nowIso(),
      worker: {
        command: workerCommand,
        code: workerResult.code,
        signal: workerResult.signal,
        stdoutFile: workerStdoutFile,
        stderrFile: workerStderrFile,
      },
      validator: {
        command: validatorCommand,
        code: validatorResult.code,
        signal: validatorResult.signal,
        stdoutFile: validatorStdoutFile,
        stderrFile: validatorStderrFile,
        judge,
      },
      review,
    };

    state.updatedAt = nowIso();
    state.iterations.push(record);
    state.lastReview = review;
    state.completed = judge.passed;
    state.result = judge.passed ? 'success' : 'retrying';
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    await heartbeat.touch({
      status: judge.passed ? 'success' : 'running',
      phase: judge.passed ? 'complete' : 'sleeping',
      result: state.result,
      iteration,
      completed: state.completed,
      lastReview: review,
      lastSuccessAt: judge.passed ? nowIso() : undefined,
    });

    if (judge.passed) {
      console.log(`[WIGGUM] Success criteria met on iteration ${iteration}.`);
      await heartbeat.finish({
        status: 'success',
        phase: 'complete',
        result: 'success',
        iteration,
        completed: true,
        exitedAt: nowIso(),
      });
      process.exit(0);
    }

    if (iteration < maxIterations) {
      console.log(`[WIGGUM] Sleeping for ${delayMs}ms before retry.`);
      await sleep(delayMs);
    }
  }

  state.updatedAt = nowIso();
  state.completed = false;
  state.result = 'max_iterations_exceeded';
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
  await heartbeat.finish({
    status: 'failed',
    phase: 'exhausted',
    result: 'max_iterations_exceeded',
    iteration: state.iterations.length,
    completed: false,
    exitedAt: nowIso(),
  });
  console.error('[WIGGUM] Max iterations exceeded without meeting success criteria.');
  process.exit(1);
}

async function shutdownWithHeartbeat(status, exitCode) {
  if (activeHeartbeat) {
    await activeHeartbeat.finish({
      status,
      phase: 'terminated',
      result: status,
      exitedAt: nowIso(),
    });
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => {
  shutdownWithHeartbeat('interrupted', 130).catch(() => process.exit(130));
});

process.on('SIGTERM', () => {
  shutdownWithHeartbeat('terminated', 143).catch(() => process.exit(143));
});

main().catch((error) => {
  console.error(`[WIGGUM] Fatal error: ${error.message}`);
  if (!activeHeartbeat) {
    process.exit(1);
    return;
  }
  activeHeartbeat.finish({
    status: 'error',
    phase: 'fatal',
    result: 'error',
    error: error.message,
    exitedAt: nowIso(),
  }).finally(() => process.exit(1));
});
