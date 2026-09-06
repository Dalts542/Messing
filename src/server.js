'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Load src/.env relative to THIS file, so the server works no matter what the
// current working directory is (double-clicked launcher, shortcut, etc).
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return false;
  let raw;
  try { raw = fs.readFileSync(envPath, 'utf8'); }
  catch (e) { console.error('  [config] Could not read .env: ' + e.message); return false; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
  return true;
}
loadEnv();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3000', 10);
const RACING_USER = process.env.RACING_USER || '';
const RACING_PASS = process.env.RACING_PASS || '';

const v = process.versions.node.split('.').map(Number);
if (v[0] < 22 || (v[0] === 22 && v[1] < 5)) {
  console.error('\n  ERROR: Node.js 22.5+ required (you have ' + process.version + ')');
  console.error('  Download the latest LTS from https://nodejs.org\n');
  process.exit(1);
}

const db = require('./db');
const sources = require('./sources');
const analytics = require('./analytics');
const ai = require('./ai');

try {
  db.initDb();
} catch (e) {
  console.error('\n  ERROR: Could not initialise the local database.');
  console.error('  ' + e.message);
  console.error('  Expected location: ' + path.join(__dirname, '..', 'data', 'racing.db') + '\n');
  throw e;
}

const ALLOWED_DOMAINS = [
  'api.theracingapi.com', 'www.racingpost.com',
  'www.sportinglife.com', 'www.timeform.com'
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

// Routes from the retired original Paddock interface. All redirect to V2.
const LEGACY_PADDOCK_ROUTES = new Set(['/paddock', '/paddock.html', '/paddock-v1', '/paddock-v1.html']);

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) { req.destroy(); reject(new Error('Too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
  });
}

function proxyRequest(target, user, pass, res) {
  const parsed = new URL(target);
  const headers = { 'Accept': 'application/json', 'User-Agent': 'PaddockIntelligence/2.0' };
  if (user && pass) headers['Authorization'] = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
  const req = https.request({
    hostname: parsed.hostname, port: 443,
    path: parsed.pathname + parsed.search, method: 'GET', headers
  }, proxyRes => {
    let body = '';
    proxyRes.on('data', c => { body += c; });
    proxyRes.on('end', () => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': proxyRes.headers['content-type'] || 'application/json', ...CORS });
      res.end(body);
    });
  });
  req.on('error', e => { res.writeHead(502, { 'Content-Type': 'text/plain', ...CORS }); res.end('Proxy error: ' + e.message); });
  req.setTimeout(15000, () => { req.destroy(); res.writeHead(504, { 'Content-Type': 'text/plain', ...CORS }); res.end('Proxy timeout'); });
  req.end();
}

function serveStatic(filePath, res) {
  const safePath = path.resolve(__dirname, filePath);
  if (!safePath.startsWith(path.resolve(__dirname))) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(safePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  try {
    if (p === '/api/today') {
      const summary = analytics.todaySummary();
      const refresh = sources.getRefreshStatus();
      const aiStatus = ai.getAiStatus();
      const dbStats = db.getDbStats();
      return json(res, { ...summary, refresh, ai: aiStatus, db: dbStats });
    }

    if (p === '/api/meetings') {
      return json(res, db.getTodaysMeetings());
    }

    if (p.startsWith('/api/meeting/')) {
      const id = decodeURIComponent(p.slice(13));
      const races = db.getMeetingRaces(id);
      return json(res, { meeting_id: id, races });
    }

    if (p.startsWith('/api/race/')) {
      const id = decodeURIComponent(p.slice(10));
      const race = db.getRace(id);
      if (!race) return json(res, { error: 'Race not found' }, 404);
      const runners = db.getRaceRunners(id);
      const analysis = analytics.analyzeRace(race, runners);
      return json(res, analysis);
    }

    if (p.startsWith('/api/race-summary/')) {
      const id = decodeURIComponent(p.slice(18));
      const summary = await ai.generateSummary(id);
      return json(res, { race_id: id, summary: summary || 'AI summary unavailable' });
    }

    if (p === '/api/search') {
      const q = parsed.query.q || '';
      if (!q) return json(res, { error: 'Missing query parameter q' }, 400);
      return json(res, db.searchAll(q));
    }

    if (p.startsWith('/api/horse/')) {
      const name = decodeURIComponent(p.slice(11));
      return json(res, db.getHorseHistory(name));
    }

    if (p.startsWith('/api/trainer/')) {
      const name = decodeURIComponent(p.slice(13));
      return json(res, analytics.trainerForm(name));
    }

    if (p.startsWith('/api/jockey/')) {
      const name = decodeURIComponent(p.slice(12));
      return json(res, analytics.jockeyForm(name));
    }

    if (p === '/api/status') {
      const sourceSt = db.getSourceStatus();
      const aiStatus = ai.getAiStatus();
      const refresh = sources.getRefreshStatus();
      const dbStats = db.getDbStats();
      return json(res, { sources: sourceSt, ai: aiStatus, refresh, db: dbStats });
    }

    if (p === '/api/refresh' && req.method === 'POST') {
      const result = await sources.ingestTodaysData();
      return json(res, result);
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const messages = body.messages || [];
      if (!messages.length) return json(res, { error: 'No messages' }, 400);
      return ai.chat(messages, res);
    }

    if (p === '/api/ai-status') {
      await ai.checkOllama();
      return json(res, ai.getAiStatus());
    }

    // Full diagnostic: detect -> optionally start -> models -> real test prompt.
    if (p === '/api/ai/diagnose') {
      const status = await ai.diagnose({
        autoStart: parsed.query.autostart !== '0',
        test: parsed.query.test !== '0'
      });
      return json(res, status);
    }

    // Proves the whole chain by sending a real prompt to the model.
    if (p === '/api/ai/test') {
      const result = await ai.selfTest();
      return json(res, { ...result, status: ai.getAiStatus() });
    }

    // Download the model. Returns immediately; poll /api/ai-status for progress.
    if (p === '/api/ai/pull' && req.method === 'POST') {
      let model = null;
      try { const b = await readBody(req); model = b.model || null; } catch { /* optional body */ }
      const current = ai.getAiStatus();
      if (current.pull && current.pull.active) {
        return json(res, { ok: false, error: 'A download is already in progress', pull: current.pull });
      }
      ai.pullModel(model).catch(() => { /* progress is reported via status */ });
      return json(res, { ok: true, started: true, model: model || current.wanted });
    }

    if (p === '/proxy') {
      const target = parsed.query.url;
      if (!target) return json(res, { error: 'Missing url parameter' }, 400);
      try { if (!ALLOWED_DOMAINS.includes(new URL(target).hostname)) return json(res, { error: 'Domain not allowed' }, 403); }
      catch { return json(res, { error: 'Invalid URL' }, 400); }
      const user = parsed.query.user || RACING_USER;
      const pass = parsed.query.pass || RACING_PASS;
      return proxyRequest(target, user, pass, res);
    }

    if (p === '/health') {
      const aiStatus = ai.getAiStatus();
      return json(res, { status: 'ok', racing_configured: !!(RACING_USER && RACING_PASS), ai: aiStatus.online, model: aiStatus.model });
    }

    // Paddock V2 (index.html) is the only Paddock UI. The original interface
    // has been removed; these routes exist so old bookmarks, shortcuts and
    // browser refreshes land on V2 instead of 404ing.
    if (LEGACY_PADDOCK_ROUTES.has(p.toLowerCase())) {
      res.writeHead(302, { Location: '/', ...CORS });
      return res.end();
    }

    let file = p === '/' ? 'index.html' : p.slice(1);
    if (!path.extname(file)) file += '.html';
    serveStatic(file, res);

  } catch (e) {
    console.error('  [server] Error:', e.message);
    if (!res.headersSent) json(res, { error: e.message }, 500);
  }
});

let refreshTimer = null;
let aiPollTimer = null;

// Binds the HTTP server. Resolves once it is actually listening.
// Rejects with err.code === 'EADDRINUSE' if the port is already taken, so the
// launcher can report a port conflict instead of crashing with a stack trace.
function listen(port = PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    function onError(err) { server.removeListener('listening', onListening); reject(err); }
    function onListening() { server.removeListener('error', onError); resolve(server.address()); }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// Optional subsystems. Neither Ollama nor the racing data provider may prevent
// the core website from starting — both degrade to a status message.
async function startOptionalSubsystems() {
  // Full AI diagnostic, including a real prompt sent to the model. Every branch
  // is non-fatal: the racing dashboard must come up regardless.
  let aiStatus = { online: false, model: null, headline: 'AI check did not run' };
  try {
    aiStatus = await ai.diagnose({ autoStart: true, test: true });
  } catch (e) {
    console.log('  [AI] Diagnostic failed (non-fatal): ' + e.message);
  }
  if (aiStatus.online && aiStatus.testPassed) {
    console.log('  AI: READY - ' + aiStatus.model + ' via ' + aiStatus.endpoint + ' (free, runs locally)');
  } else {
    console.log('  AI: ' + (aiStatus.status || 'UNAVAILABLE') + ' - ' + (aiStatus.headline || ''));
    if (aiStatus.detail) console.log('      ' + aiStatus.detail);
    if (aiStatus.action) console.log('      ' + aiStatus.action);
    console.log('      The racing dashboard is unaffected and will still load.');
  }

  if (RACING_USER && RACING_PASS) {
    console.log('  Racing API: configured');
  } else {
    console.log('  Racing API: NOT configured - dashboard runs with no race data.');
    console.log('       Add RACING_USER / RACING_PASS to src\\.env, then see Data Status.');
  }

  // Background work is fire-and-forget; failures are recorded in source_log and
  // surfaced on the Data Status page rather than thrown.
  try {
    sources.startBackgroundRefresh(300000);
    refreshTimer = true;
  } catch (e) {
    console.log('  [sources] Background refresh could not start (non-fatal): ' + e.message);
  }
  try {
    aiPollTimer = setInterval(() => { ai.checkOllama({ autoStart: false }).catch(() => {}); }, 30000);
    if (aiPollTimer.unref) aiPollTimer.unref();
  } catch { /* non-fatal */ }
}

async function startup({ quiet = false } = {}) {
  if (!quiet) {
    console.log('');
    console.log('  Paddock Intelligence v2');
    console.log('  =======================');
    console.log('');
  }

  // Bind FIRST. The site must come up even if AI and data sources are absent.
  const addr = await listen();

  if (!quiet) {
    console.log('  Paddock V2:     http://' + HOST + ':' + PORT + '/');
    console.log('  NEXUS:          http://' + HOST + ':' + PORT + '/nexus-standalone.html');
    console.log('  Bet Tracker:    http://' + HOST + ':' + PORT + '/bet-tracker.html');
    console.log('  Health:         http://' + HOST + ':' + PORT + '/health');
    console.log('');
  }

  await startOptionalSubsystems();

  if (!quiet) {
    console.log('');
    console.log('  Server is ready. Press Ctrl+C to stop (or run stop.bat).');
    console.log('');
  }
  return addr;
}

async function shutdown() {
  if (aiPollTimer) { clearInterval(aiPollTimer); aiPollTimer = null; }
  if (refreshTimer) { try { sources.stopBackgroundRefresh(); } catch { /* ignore */ } refreshTimer = null; }
  await new Promise(resolve => server.close(resolve));
}

module.exports = { server, startup, shutdown, listen, HOST, PORT };

// Only auto-start when run directly (node src/server.js). When the launcher
// requires this module it drives startup() itself so it can report failures.
if (require.main === module) {
  startup().catch(err => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('\n  ERROR: Port ' + PORT + ' is already in use.');
      console.error('  Another program (possibly another copy of this app) is using it.');
      console.error('  Run stop.bat, or set PORT=3001 in src\\.env.\n');
    } else {
      console.error('\n  ERROR: Server failed to start.');
      console.error('  ' + (err && err.stack ? err.stack : err) + '\n');
    }
    process.exit(1);
  });
}
