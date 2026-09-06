'use strict';
// Paddock Intelligence launcher.
//
// start.bat calls this. It performs preflight checks, starts the server,
// waits for /health to answer, records the PID so stop.bat can stop only this
// application, then opens the dashboard.
//
// Exit codes (start.bat reports these):
//   0  started (or already running)
//   2  preflight failure (missing files / unsupported Node)
//   3  port in use by an unrelated process
//   4  server failed to start
//   5  server started but never became healthy

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PID_FILE = path.join(DATA_DIR, 'paddock.pid');
const LOG_FILE = path.join(DATA_DIR, 'startup.log');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3000', 10);
const OPEN_PATH = process.env.OPEN_PATH || '/paddock.html';

const REQUIRED_FILES = [
  'src/server.js', 'src/db.js', 'src/sources.js', 'src/analytics.js', 'src/ai.js',
  'src/index.html', 'src/paddock.html', 'src/nexus-standalone.html', 'src/bet-tracker.html'
];

let logStream = null;
function log(msg) {
  const line = '  ' + msg;
  console.log(line);
  try {
    if (!logStream) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    }
    logStream.write(new Date().toISOString() + ' ' + msg + '\n');
  } catch { /* logging must never break startup */ }
}

function stage(n, total, text) { log('[' + n + '/' + total + '] ' + text); }

function fail(code, title, details) {
  log('');
  log('!! ' + title);
  for (const d of (details || [])) log('   ' + d);
  log('');
  log('   Log file: ' + LOG_FILE);
  log('');
  process.exitCode = code;
}

// --- health probe -----------------------------------------------------------

function probeHealth(timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get(
      { host: HOST, port: PORT, path: '/health', timeout: timeoutMs },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, foreign: true });
          try {
            const j = JSON.parse(body);
            // "status":"ok" is this application's marker. Anything else on the
            // port is some other program and must not be touched.
            resolve(j && j.status === 'ok'
              ? { ok: true, body: j }
              : { ok: false, foreign: true });
          } catch { resolve({ ok: false, foreign: true }); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, foreign: false }); });
    req.on('error', () => resolve({ ok: false, foreign: false }));
  });
}

async function waitForHealth(attempts = 40, delayMs = 250) {
  for (let i = 0; i < attempts; i++) {
    const r = await probeHealth();
    if (r.ok) return r;
    await new Promise(res => setTimeout(res, delayMs));
  }
  return { ok: false };
}

// --- browser ----------------------------------------------------------------

// Opening the browser must NEVER be able to stop the server. spawn() reports
// failure via an asynchronous 'error' event, and an unhandled 'error' event
// terminates the process - so the handler below is required, not optional.
function openBrowser(url) {
  let cmd, args;
  if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else { cmd = 'xdg-open'; args = [url]; }

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', err => {
      log('Could not open the browser automatically (' + err.code + ').');
      log('The server is still running - open this address yourself:');
      log('  ' + url);
    });
    child.unref();
    return true;
  } catch (e) {
    log('Could not open the browser automatically (' + e.message + ').');
    log('The server is still running - open this address yourself:');
    log('  ' + url);
    return false;
  }
}

// --- pid file ---------------------------------------------------------------

function writePidFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, JSON.stringify({
      pid: process.pid, port: PORT, host: HOST,
      started: new Date().toISOString()
    }, null, 2));
    return true;
  } catch (e) {
    log('Warning: could not write PID file (' + e.message + '). stop.bat will fall back to the health check.');
    return false;
  }
}

function removePidFile() {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

// --- main -------------------------------------------------------------------

async function main() {
  const TOTAL = 6;
  log('');
  log('Paddock Intelligence v2');
  log('=======================');
  log('');

  // 1. Node version
  stage(1, TOTAL, 'Checking Node.js');
  const v = process.versions.node.split('.').map(Number);
  if (v[0] < 22 || (v[0] === 22 && v[1] < 5)) {
    return fail(2, 'Node.js ' + process.version + ' is too old.', [
      'This app needs Node.js 22.5 or newer (it uses Node\'s built-in database).',
      'Install the current LTS from https://nodejs.org and run start.bat again.'
    ]);
  }
  log('      Node ' + process.version + ' OK');

  // 2. Project files
  stage(2, TOTAL, 'Checking project files');
  const missing = REQUIRED_FILES.filter(f => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    return fail(2, 'The project files are incomplete.', [
      'Missing: ' + missing.join(', '),
      'Extract the whole ZIP (not just some files) and try again.',
      'Project root detected as: ' + ROOT
    ]);
  }
  log('      ' + REQUIRED_FILES.length + ' files present');

  // Create src/.env from the template so the user has somewhere obvious to put
  // credentials. Its absence is never fatal - the app just runs with no data.
  try {
    const envFile = path.join(__dirname, '.env');
    const template = path.join(__dirname, 'env-example.txt');
    if (!fs.existsSync(envFile) && fs.existsSync(template)) {
      fs.copyFileSync(template, envFile);
      log('      Created src\\.env from the template - add racing credentials there.');
    }
  } catch (e) {
    log('      Note: could not create src\\.env (' + e.message + '). Not fatal.');
  }

  // 3. Already running? Never start a second copy.
  stage(3, TOTAL, 'Checking for an existing instance');
  const existing = await probeHealth();
  if (existing.ok) {
    log('      Paddock Intelligence is already running on port ' + PORT + '.');
    log('      Opening the existing dashboard instead of starting a second copy.');
    openBrowser('http://' + HOST + ':' + PORT + OPEN_PATH);
    log('');
    log('  http://' + HOST + ':' + PORT + OPEN_PATH);
    log('');
    return;
  }
  if (existing.foreign) {
    return fail(3, 'Port ' + PORT + ' is being used by another program.', [
      'Something that is NOT Paddock Intelligence is listening on port ' + PORT + '.',
      'It has been left alone on purpose - this app will not stop other software.',
      'Either close that program, or set  PORT=3001  in src\\.env and run start.bat again.'
    ]);
  }
  log('      No existing instance');

  // 4. Start server (this also initialises the local database)
  stage(4, TOTAL, 'Initialising database and starting server');
  let server;
  try {
    server = require('./server');
  } catch (e) {
    return fail(4, 'The server could not be loaded.', [
      String(e && e.message ? e.message : e),
      (e && e.stack ? e.stack.split('\n').slice(1, 4).join(' | ') : '')
    ].filter(Boolean));
  }

  try {
    await server.startup({ quiet: true });
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      return fail(3, 'Port ' + PORT + ' is already in use.', [
        'Run stop.bat first, or set  PORT=3001  in src\\.env.'
      ]);
    }
    return fail(4, 'The server failed to start.', [
      String(e && e.message ? e.message : e),
      'Exit detail: ' + (e && e.code ? e.code : 'none'),
      (e && e.stack ? e.stack.split('\n').slice(1, 4).join(' | ') : '')
    ].filter(Boolean));
  }
  log('      Listening on http://' + HOST + ':' + PORT);

  // 5. Health gate - do NOT open the browser before this passes
  stage(5, TOTAL, 'Waiting for health check');
  const healthy = await waitForHealth();
  if (!healthy.ok) {
    return fail(5, 'The server started but did not become healthy.', [
      'http://' + HOST + ':' + PORT + '/health did not return a valid response.'
    ]);
  }
  log('      /health OK'
    + (healthy.body ? '  (AI: ' + (healthy.body.ai ? 'online' : 'offline')
      + ', racing data: ' + (healthy.body.racing_configured ? 'configured' : 'not configured') + ')' : ''));

  writePidFile();

  // Once the site is up and healthy, a late non-fatal error (a failed browser
  // launch, a background data refresh blowing up) must not take the site down.
  // Startup errors are still reported normally because this is installed here,
  // after the health gate, not at the top of the file.
  process.on('uncaughtException', err => {
    log('Non-fatal error after startup: ' + (err && err.message ? err.message : err));
    log('The server is still running.');
  });
  process.on('unhandledRejection', err => {
    log('Non-fatal promise rejection after startup: ' + (err && err.message ? err.message : err));
    log('The server is still running.');
  });

  // 6. Open the dashboard
  stage(6, TOTAL, 'Opening dashboard');
  openBrowser('http://' + HOST + ':' + PORT + OPEN_PATH);

  log('');
  log('  Paddock:     http://' + HOST + ':' + PORT + '/paddock.html');
  log('  Dashboard:   http://' + HOST + ':' + PORT + '/');
  log('  NEXUS:       http://' + HOST + ':' + PORT + '/nexus-standalone.html');
  log('  Bet Tracker: http://' + HOST + ':' + PORT + '/bet-tracker.html');
  log('');
  log('  Server is running. Close this window or run stop.bat to stop it.');
  log('');
}

function cleanup() { removePidFile(); }
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

main().catch(e => {
  fail(4, 'Unexpected startup error.', [String(e && e.stack ? e.stack : e)]);
});
