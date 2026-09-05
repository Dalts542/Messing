'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const HOST = '127.0.0.1';
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

db.initDb();

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
      const status = await ai.checkOllama();
      return json(res, status);
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

    let file = p === '/' ? 'index.html' : p.slice(1);
    if (!path.extname(file)) file += '.html';
    serveStatic(file, res);

  } catch (e) {
    console.error('  [server] Error:', e.message);
    if (!res.headersSent) json(res, { error: e.message }, 500);
  }
});

async function startup() {
  console.log('');
  console.log('  Paddock Intelligence v2');
  console.log('  =======================');
  console.log('');
  console.log('  Checking local AI...');
  const aiStatus = await ai.checkOllama();
  if (aiStatus.online) {
    console.log('  AI: ONLINE — ' + aiStatus.model + ' (£0 per query)');
  } else {
    console.log('  AI: OFFLINE — Install Ollama from https://ollama.com');
    console.log('       Then run: ollama pull llama3.1:8b');
  }
  console.log('');
  console.log('  Racing API: ' + (RACING_USER ? 'configured' : 'NOT configured — set RACING_USER/RACING_PASS in .env'));
  console.log('');
  sources.startBackgroundRefresh(300000);
  setInterval(() => ai.checkOllama(), 30000);
  server.listen(PORT, HOST, () => {
    console.log('  Dashboard: http://' + HOST + ':' + PORT + '/');
    console.log('  Bet Tracker: http://' + HOST + ':' + PORT + '/bet-tracker');
    console.log('  Legacy Paddock: http://' + HOST + ':' + PORT + '/paddock');
    console.log('  Legacy NEXUS: http://' + HOST + ':' + PORT + '/nexus-standalone');
    console.log('');
    console.log('  Press Ctrl+C to stop.');
    console.log('');
  });
}

startup();
