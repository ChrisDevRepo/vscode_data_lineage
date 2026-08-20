#!/usr/bin/env node
// Live progress for a headless live-provider run — `node tests/tools/e2e-watch.mjs`.
//
// `test:live-provider` prints a start banner and then nothing until the run ends, which for T6/T7 is
// five to fifteen minutes of apparent silence. Measured from the tracked artifacts: T6 averages
// 274s and has hit the 900s watchdog, T7 averages 240s. Silence that long is indistinguishable
// from a hang, and a watcher that only reported success would keep looking healthy through one.
//
// This reads the run's own NDJSON trace, which the runtime appends as it goes, and emits one line
// per meaningful event plus an explicit STALL line when the trace stops growing. Read-only: it
// never writes into the run directory and never touches the provider.
//
// Usage:
//   node tests/tools/e2e-watch.mjs                      # newest run under test-results/e2e
//   node tests/tools/e2e-watch.mjs --dir <runDir>       # a specific run-N directory
//   node tests/tools/e2e-watch.mjs --interval 10 --stall 120
//
// Exit codes: 0 terminal ok, 1 terminal not ok, 2 watch error (no trace appeared).
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ROOT = flag('root', 'test-results/e2e');
const INTERVAL_MS = Number(flag('interval', '15')) * 1000;
const STALL_MS = Number(flag('stall', '180')) * 1000;
const WAIT_MS = Number(flag('wait', '120')) * 1000;

/**
 * Newest `run-N` directory across all batches, or the one named by `--dir`.
 *
 * @param skipFinished - Pass over runs whose trace already carries a terminal event. Auto-selection
 *   always does: the newest EXISTING directory is otherwise chosen even when it finished hours ago,
 *   and its terminal event replays instantly and reads as the live run's verdict. Age is the wrong
 *   test — a T6 that started twenty minutes ago is exactly what should be watched — so completeness
 *   is the test instead. An explicit `--dir` is exempt: naming a directory asserts which run is meant.
 */
function newestRunDir(skipFinished = false) {
  const explicit = flag('dir', null);
  if (explicit) return explicit;
  if (!fs.existsSync(ROOT)) return null;
  const candidates = [];
  for (const batch of fs.readdirSync(ROOT)) {
    const batchDir = path.join(ROOT, batch);
    if (!fs.statSync(batchDir).isDirectory()) continue;
    for (const run of fs.readdirSync(batchDir)) {
      if (!run.startsWith('run-')) continue;
      const runDir = path.join(batchDir, run);
      const stat = fs.statSync(runDir);
      if (stat.isDirectory()) candidates.push({ dir: runDir, mtime: stat.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (!skipFinished) return candidates.length > 0 ? candidates[0].dir : null;
  // Newest first, so the first unfinished run is the one in flight. A directory with no trace yet
  // counts as unfinished: the runtime creates it before the first generation lands.
  for (const { dir } of candidates) {
    if (!isFinished(dir)) return dir;
  }
  return null;
}

/** Whether a run's trace already carries its terminal event. */
function isFinished(runDir) {
  const file = traceFile(runDir);
  if (!file) return false;
  try {
    return fs.readFileSync(file, 'utf8').includes('"type":"turn-terminal"');
  } catch {
    return false;
  }
}

/** The single NDJSON trace inside a run directory, once the runtime has created it. */
function traceFile(runDir) {
  const dir = path.join(runDir, 'lm-trace');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ndjson'));
  return files.length > 0 ? path.join(dir, files[0]) : null;
}

// Elapsed is measured from the run's own first event, not from watcher start — otherwise every
// line of an already-running run's backlog reads +00:00 and the pacing of a slow hop is invisible.
let runStart = null;
const stamp = eventAt => {
  const now = eventAt ? Date.parse(eventAt) : Date.now();
  const s = Math.max(0, Math.round((now - (runStart ?? now)) / 1000));
  return `[+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}]`;
};
const secs = ms => `${(ms / 1000).toFixed(1)}s`;
const say = (line, eventAt) => console.log(`${stamp(eventAt)} ${line}`);

/** One printed line per event worth acting on — progress AND every failure shape. */
function render(event) {
  switch (event.type) {
    case 'turn-start':
      return 'turn started';
    case 'phase':
      return `phase → ${event.phase}`;
    case 'gate':
      return `GATE ${event.phase}`;
    case 'generation': {
      const u = event.usage ?? {};
      return `gen#${event.generation} phase=${event.phase} finish=${event.finishReason} `
        + `latency=${secs(event.latencyMs ?? 0)} tokens=${u.inputTokens ?? '?'}/${u.outputTokens ?? '?'}`;
    }
    case 'tool': {
      const code = event.rejectionCode ?? event.code;
      const suffix = code ? ` code=${code}` : '';
      const marker = event.status === 'accepted' ? 'tool' : 'TOOL REJECTED';
      return `${marker} ${event.toolName} ${event.status}${suffix} (${event.durationMs ?? '?'}ms)`;
    }
    case 'turn-terminal':
      return `TERMINAL status=${event.status} modelCalls=${event.modelCalls} duration=${secs(event.durationMs ?? 0)}`;
    default:
      return null;
  }
}

// A run started at roughly the same moment as this watcher may not have created its directory yet,
// so auto-selection waits for an unfinished one rather than settling for whatever completed earlier.
let runDir = newestRunDir(true);
const selectDeadline = Date.now() + WAIT_MS;
while (!runDir && Date.now() < selectDeadline) {
  await new Promise(r => setTimeout(r, 2000));
  runDir = newestRunDir(true);
}
if (!runDir) {
  console.error(
    `[watch] no run directory created under ${ROOT} within ${WAIT_MS / 1000}s.`
    + ' Start a run first, or pass --dir to watch an existing one.',
  );
  process.exit(2);
}
say(`watching ${runDir}`);

let trace = traceFile(runDir);
const waitDeadline = Date.now() + WAIT_MS;
while (!trace && Date.now() < waitDeadline) {
  await new Promise(r => setTimeout(r, 2000));
  trace = traceFile(runDir);
}
if (!trace) {
  console.error(`[watch] no lm-trace/*.ndjson appeared in ${runDir} within ${WAIT_MS / 1000}s.`);
  process.exit(2);
}
say(`trace ${path.basename(trace)}`);

// One descriptor, read forward from `offset`. Re-reading the whole file each poll would cost bytes
// quadratic in run length — a T6 trace is polled dozens of times — and every pass but the last
// discards what it just read. `StringDecoder` holds back a multi-byte character split across a
// poll boundary; `carry` does the same one level up, for a line split across one.
const fd = fs.openSync(trace, 'r');
const decoder = new StringDecoder('utf8');
let offset = 0;
let carry = '';
let lastEventAt = Date.now();
let lastStallNotifyAt = 0;

for (;;) {
  const { size } = fs.fstatSync(fd);
  if (size > offset) {
    const buffer = Buffer.allocUnsafe(size - offset);
    const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
    offset += read;
    const lines = (carry + decoder.write(buffer.subarray(0, read))).split(/\r?\n/);
    carry = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // a partially flushed line reappears complete on the next pass
      }
      if (runStart === null && event.at) runStart = Date.parse(event.at);
      const rendered = render(event);
      if (!rendered) continue;
      lastEventAt = Date.now();
      lastStallNotifyAt = 0;
      say(rendered, event.at);
      if (event.type === 'turn-terminal') {
        process.exit(event.status === 'ok' ? 0 : 1);
      }
    }
  }

  // Silence is never reported as progress: a stalled trace says so, and keeps saying so — once per
  // STALL_MS, measured from the last notification rather than from the last event.
  const now = Date.now();
  const idle = now - lastEventAt;
  if (idle >= STALL_MS && now - lastStallNotifyAt >= STALL_MS) {
    lastStallNotifyAt = now;
    say(`STALL no trace activity for ${Math.round(idle / 1000)}s (watchdog kills a run at 900s)`);
  }

  await new Promise(r => setTimeout(r, INTERVAL_MS));
}
