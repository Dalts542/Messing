'use strict';
// Stops ONLY the Paddock Intelligence process started by this project.
//
// Safety rules:
//   - Never kill by image name (that would kill every node.exe on the PC).
//   - Only act on a PID we recorded ourselves, or the PID that owns port 3000
//     AFTER /health has confirmed the listener is this application.
//   - Always verify the target really is a node process before killing it.
//   - Remove stale PID state safely.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PID_FILE = path.join(ROOT, 'data', 'paddock.pid');
const HOST = '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3000', 10);
const IS_WIN = process.platform === 'win32';

function log(m) { console.log('  ' + m); }

function probeHealth(timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get({ host: HOST, port: PORT, path: '/health', timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(res.statusCode === 200 && j && j.status === 'ok');
        } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function readPidFile() {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    return j && Number.isInteger(j.pid) ? j : null;
  } catch { return null; }
}

function removePidFile() {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// Confirm the PID really is a node process, so we never kill something else
// that happens to have reused the PID.
function isNodeProcess(pid) {
  if (!IS_WIN) {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
      return /node/i.test(out);
    } catch { return false; }
  }
  try {
    const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
    return /"node\.exe"/i.test(out);
  } catch { return false; }
}

// Find which PID owns the port. Only used after /health proved the listener is us.
function pidOwningPort(port) {
  try {
    if (IS_WIN) {
      const out = execFileSync('netstat', ['-a', '-n', '-o'], { encoding: 'utf8' });
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        if (!new RegExp('[:.]' + port + '\\s').test(line)) continue;
        const m = line.trim().split(/\s+/);
        const pid = parseInt(m[m.length - 1], 10);
        if (Number.isInteger(pid)) return pid;
      }
    } else {
      const out = execFileSync('sh', ['-c', 'lsof -tiTCP:' + port + ' -sTCP:LISTEN 2>/dev/null || true'], { encoding: 'utf8' });
      const pid = parseInt(out.trim().split(/\s+/)[0], 10);
      if (Number.isInteger(pid)) return pid;
    }
  } catch { /* fall through */ }
  return null;
}

function killPid(pid) {
  if (IS_WIN) {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGTERM');
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForPortRelease(attempts = 20, delayMs = 250) {
  for (let i = 0; i < attempts; i++) {
    if (!(await probeHealth(500))) return true;
    await sleep(delayMs);
  }
  return false;
}

async function main() {
  console.log('');
  console.log('  Stopping Paddock Intelligence...');
  console.log('');

  const running = await probeHealth();
  const rec = readPidFile();

  if (!running && !rec) {
    log('Paddock Intelligence was not running.');
    console.log('');
    return 0;
  }

  if (!running && rec) {
    log('Paddock Intelligence was not running (clearing stale PID file).');
    removePidFile();
    console.log('');
    return 0;
  }

  // Running. Work out which PID to stop.
  let pid = rec && rec.pid;

  if (pid && !processExists(pid)) {
    log('Recorded PID ' + pid + ' no longer exists; locating the live process.');
    pid = null;
  }
  if (!pid) {
    // /health already confirmed the listener on this port is THIS application,
    // so resolving the port owner here is safe.
    pid = pidOwningPort(PORT);
  }

  if (!pid) {
    log('Could not identify the process ID.');
    log('Close the Paddock Intelligence window manually to stop it.');
    console.log('');
    return 1;
  }

  if (!isNodeProcess(pid)) {
    log('PID ' + pid + ' is not a Node.js process - leaving it alone.');
    log('Nothing was stopped. Close the Paddock Intelligence window manually.');
    removePidFile();
    console.log('');
    return 1;
  }

  try {
    killPid(pid);
    log('Stopped Paddock Intelligence (PID ' + pid + ').');
  } catch (e) {
    log('Could not stop PID ' + pid + ': ' + e.message);
    console.log('');
    return 1;
  }

  removePidFile();

  const released = await waitForPortRelease();
  log(released
    ? 'Port ' + PORT + ' has been released.'
    : 'Warning: port ' + PORT + ' still appears to be in use.');
  console.log('');
  return released ? 0 : 1;
}

main().then(code => { process.exitCode = code; })
  .catch(e => { console.error('  Error: ' + e.message); process.exitCode = 1; });
