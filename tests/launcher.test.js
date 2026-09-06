'use strict';
// Launcher lifecycle test: start -> healthy -> STAYS ALIVE -> stop -> restart.
//
// Regression coverage for two real defects:
//   1. start.bat exiting before the server ever ran (the reported failure).
//   2. the launcher dying AFTER reporting healthy because the browser could
//      not be opened (spawn emits 'error' asynchronously; an unhandled
//      'error' event terminates the process).
//
// No npm dependencies.

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const LAUNCHER = path.join(ROOT, 'src', 'launcher.js');
const STOPPER = path.join(ROOT, 'src', 'stop.js');
const PID_FILE = path.join(ROOT, 'data', 'paddock.pid');
const PORT = parseInt(process.env.TEST_PORT || '3011', 10);
const HOST = '127.0.0.1';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function health(timeoutMs = 1200) {
  return new Promise(resolve => {
    const req = http.get({ host: HOST, port: PORT, path: '/health', timeout: timeoutMs }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        try { const j = JSON.parse(b); resolve(res.statusCode === 200 && j.status === 'ok'); }
        catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function status(p) {
  return new Promise(resolve => {
    const req = http.get({ host: HOST, port: PORT, path: p, timeout: 5000 }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

async function waitHealthy(n = 40) {
  for (let i = 0; i < n; i++) { if (await health()) return true; await sleep(250); }
  return false;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function startLauncher() {
  // PATH is emptied so the browser-open command cannot be found. This forces
  // the exact failure that previously killed the server after it was healthy.
  const child = spawn(process.execPath, [LAUNCHER], {
    env: { ...process.env, PORT: String(PORT), PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

async function main() {
  console.log('\n  Launcher lifecycle test');
  console.log('  -----------------------');
  console.log('  Port ' + PORT + '\n');

  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch {}

  // --- first start ----------------------------------------------------------
  let child = startLauncher();
  let exitedEarly = null;
  child.on('exit', code => { exitedEarly = code; });

  const healthy = await waitHealthy();
  record('launcher brings the server up and /health returns 200', healthy);
  if (!healthy) return finish();

  // The core regression: it must not have exited.
  record('launcher process did not exit before serving', exitedEarly === null,
    exitedEarly === null ? 'still running' : 'exited with ' + exitedEarly);

  // Give the browser-open attempt time to fail asynchronously.
  await sleep(1500);
  record('server SURVIVES a failed browser launch', exitedEarly === null && alive(child.pid),
    exitedEarly === null ? 'alive' : 'died with ' + exitedEarly);
  record('still healthy after failed browser launch', await health());

  record('PID file written', fs.existsSync(PID_FILE));
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch {}
  record('PID file records the live process', !!(rec && alive(rec.pid)),
    rec ? 'pid ' + rec.pid : 'unreadable');

  // --- pages ----------------------------------------------------------------
  for (const p of ['/paddock.html', '/nexus-standalone.html', '/bet-tracker.html', '/']) {
    record('serves ' + p, (await status(p)) === 200);
  }

  // --- second launcher must NOT start a duplicate ---------------------------
  const dup = spawnSync(process.execPath, [LAUNCHER], {
    env: { ...process.env, PORT: String(PORT), PATH: '' },
    encoding: 'utf8', timeout: 30000
  });
  record('second launch detects the running instance instead of duplicating',
    dup.status === 0 && /already running/i.test(dup.stdout || ''),
    'exit ' + dup.status);
  record('original process still alive after second launch', alive(child.pid));

  // --- stop -----------------------------------------------------------------
  const stopped = spawnSync(process.execPath, [STOPPER], {
    env: { ...process.env, PORT: String(PORT) }, encoding: 'utf8', timeout: 30000
  });
  record('stop.js exits 0', stopped.status === 0, 'exit ' + stopped.status);
  record('stop.js reports it stopped the app', /Stopped Paddock Intelligence/i.test(stopped.stdout || ''));

  await sleep(1200);
  record('server is no longer healthy after stop', !(await health()));
  record('launcher process is gone', !alive(child.pid));
  record('PID file removed', !fs.existsSync(PID_FILE));

  // --- restart --------------------------------------------------------------
  child = startLauncher();
  const restarted = await waitHealthy();
  record('start -> stop -> start works again', restarted);

  if (restarted) {
    const stop2 = spawnSync(process.execPath, [STOPPER], {
      env: { ...process.env, PORT: String(PORT) }, encoding: 'utf8', timeout: 30000
    });
    record('second stop succeeds', stop2.status === 0);
    await sleep(1000);
    record('port released after second stop', !(await health()));
  }

  // --- stopping when nothing is running -------------------------------------
  const stopIdle = spawnSync(process.execPath, [STOPPER], {
    env: { ...process.env, PORT: String(PORT) }, encoding: 'utf8', timeout: 30000
  });
  record('stop.js reports "was not running" cleanly', stopIdle.status === 0 &&
    /was not running/i.test(stopIdle.stdout || ''), 'exit ' + stopIdle.status);

  try { child.kill(); } catch {}
  finish();
}

function finish() {
  const passed = results.filter(r => r.ok).length;
  console.log('');
  console.log('  ' + passed + '/' + results.length + ' passed');
  console.log('');
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { record('unexpected error', false, e.message); finish(); });
