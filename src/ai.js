'use strict';
// Local AI via Ollama. Everything stays on this machine - no prompt, no racing
// data and no question ever leaves the PC.
//
// WHY THIS FILE LOOKS THE WAY IT DOES
// -----------------------------------
// The previous version connected to "http://localhost:11434". On Windows,
// "localhost" resolves to the IPv6 address ::1 first (Node 17+ keeps the OS
// resolver order instead of preferring IPv4), but Ollama binds to 127.0.0.1
// only. Node therefore dialled [::1]:11434, got ECONNREFUSED, and the whole
// app reported "Local AI is offline" even with Ollama running and the model
// pulled. We now try explicit address candidates and remember the one that
// works, so name resolution order cannot break the integration.
//
// The old code also treated "no models installed" as "offline", and split
// streaming NDJSON on chunk boundaries (which corrupts tokens). Both fixed.

const http = require('http');
const { execFile, spawn } = require('child_process');
const db = require('./db');
const analytics = require('./analytics');

const WANTED_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const AUTO_START = process.env.OLLAMA_AUTOSTART !== '0';

// Distinct, actionable states. "offline" is never the whole story.
const S = {
  READY: 'READY',
  NOT_INSTALLED: 'NOT_INSTALLED',
  NOT_RUNNING: 'NOT_RUNNING',
  UNREACHABLE: 'UNREACHABLE',
  NO_MODELS: 'NO_MODELS',
  MODEL_MISSING: 'MODEL_MISSING',
  MODEL_DOWNLOADING: 'MODEL_DOWNLOADING',
  MODEL_LOAD_FAILED: 'MODEL_LOAD_FAILED',
  API_ERROR: 'API_ERROR',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN'
};

const state = {
  status: S.UNKNOWN,
  online: false,
  installed: null,
  reachable: false,
  endpoint: null,
  model: null,
  models: [],
  wanted: WANTED_MODEL,
  headline: 'Checking local AI...',
  detail: '',
  action: '',
  canPull: false,
  testPassed: false,
  lastCheck: null,
  lastError: null,
  cost: '£0',
  pull: { active: false, model: null, percent: 0, status: '', error: null, done: false }
};

let lastLogged = null;
function logAI(msg) { console.log('  [AI] ' + msg); }
function logOnce(key, msg) { if (lastLogged !== key) { lastLogged = key; logAI(msg); } }

// --- endpoint candidates ----------------------------------------------------
// An explicit OLLAMA_HOST always wins. Otherwise try IPv4 first (what Ollama
// actually binds), then IPv6, then the name.
function candidates() {
  const env = process.env.OLLAMA_HOST;
  if (env) {
    const withScheme = /^https?:\/\//i.test(env) ? env : 'http://' + env;
    return [withScheme];
  }
  return ['http://127.0.0.1:11434', 'http://[::1]:11434', 'http://localhost:11434'];
}

function parseEndpoint(base) {
  const u = new URL(base);
  return {
    hostname: u.hostname.replace(/^\[|\]$/g, ''), // http.request wants ::1, not [::1]
    port: parseInt(u.port || '11434', 10),
    base
  };
}

// --- low level request ------------------------------------------------------
function request(endpoint, pathname, { method = 'GET', body = null, timeout = 5000, stream = false } = {}) {
  const ep = typeof endpoint === 'string' ? parseEndpoint(endpoint) : endpoint;
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: ep.hostname,
      port: ep.port,
      path: pathname,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : {}
    }, res => {
      if (stream) return resolve({ res, statusCode: res.statusCode });
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* non-JSON body */ }
        resolve({ statusCode: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', err => reject(err));
    req.setTimeout(timeout, () => {
      const e = new Error('Timed out after ' + timeout + 'ms');
      e.code = 'ETIMEDOUT';
      req.destroy(e);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// --- is the ollama binary present? -----------------------------------------
let installedCache = null;
function detectBinary() {
  if (installedCache !== null) return Promise.resolve(installedCache);
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise(resolve => {
    execFile(cmd, ['ollama'], { timeout: 5000 }, (err, stdout) => {
      installedCache = !err && !!String(stdout || '').trim();
      resolve(installedCache);
    });
  });
}

// --- start ollama if it is installed but not running ------------------------
let startAttempted = false;
async function startOllama() {
  if (startAttempted) return false;
  startAttempted = true;
  if (!(await detectBinary())) return false;
  logAI('Ollama is installed but not responding - attempting to start it...');
  try {
    // "ollama serve" exits immediately if a server is already running; that is
    // harmless. Detached so it outlives this process cleanly.
    const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
    child.on('error', e => logAI('Could not launch "ollama serve": ' + e.code));
    child.unref();
  } catch (e) {
    logAI('Could not launch "ollama serve": ' + e.message);
    return false;
  }
  // Wait for the API to come up.
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    const probe = await probeApi();
    if (probe.reachable) { logAI('Ollama started and the API is responding'); return true; }
  }
  logAI('Started Ollama but the API did not respond within 10s');
  return false;
}

// --- probe the API across candidates ---------------------------------------
async function probeApi() {
  const list = state.endpoint ? [state.endpoint, ...candidates().filter(c => c !== state.endpoint)] : candidates();
  let lastErr = null;
  for (const base of list) {
    try {
      const r = await request(base, '/api/tags', { timeout: 3000 });
      if (r.statusCode === 200 && r.body && Array.isArray(r.body.models)) {
        return { reachable: true, endpoint: base, models: r.body.models };
      }
      lastErr = new Error('HTTP ' + r.statusCode + ' from ' + base);
      lastErr.code = 'BAD_RESPONSE';
    } catch (e) {
      lastErr = e;
    }
  }
  return { reachable: false, error: lastErr };
}

// --- model matching ---------------------------------------------------------
function normalise(n) { return String(n || '').replace(/:latest$/, ''); }

function pickModel(names, wanted) {
  const w = normalise(wanted);
  const exact = names.find(n => normalise(n) === w);
  if (exact) return { name: exact, exact: true };
  // Same family (llama3.1:8b -> llama3.1:70b) is usable but worth reporting.
  const family = w.split(':')[0];
  const fam = names.find(n => normalise(n).split(':')[0] === family);
  if (fam) return { name: fam, exact: false };
  return null;
}

function setState(status, patch) {
  state.status = status;
  Object.assign(state, patch);
  state.online = status === S.READY;
  state.lastCheck = new Date().toISOString();
}

// --- the main health check --------------------------------------------------
async function checkOllama({ autoStart = false, quiet = true } = {}) {
  if (!quiet) logAI('Checking Ollama...');

  let probe = await probeApi();

  if (!probe.reachable && autoStart && AUTO_START) {
    const installed = await detectBinary();
    if (installed) {
      await startOllama();
      probe = await probeApi();
    }
  }

  if (!probe.reachable) {
    const installed = await detectBinary();
    const err = probe.error || {};
    state.lastError = err.code || err.message || 'unreachable';

    // A timeout means something ACCEPTED the connection but never answered.
    // That is never "not installed", so it is classified before that branch.
    if (err.code === 'ETIMEDOUT') {
      setState(S.TIMEOUT, {
        reachable: false, models: [], model: null, testPassed: false, canPull: false,
        headline: 'Ollama did not respond in time',
        detail: 'Something is listening on port 11434 but it did not answer within 3 seconds.',
        action: 'Ollama may still be starting up, or may be stuck. Wait a moment and click Re-check.'
      });
      logOnce(S.TIMEOUT, 'Ollama is listening but the API did not respond (timeout)');
      return getAiStatus();
    }

    if (!installed) {
      setState(S.NOT_INSTALLED, {
        reachable: false, models: [], model: null, testPassed: false, canPull: false,
        headline: 'Ollama is not installed',
        detail: 'The local AI engine could not be found on this PC.',
        action: 'Install Ollama (free) from https://ollama.com, then click Re-check.'
      });
      logOnce(S.NOT_INSTALLED, 'Ollama is not installed');
      return getAiStatus();
    }

    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EAFNOSUPPORT') {
      setState(S.NOT_RUNNING, {
        reachable: false, models: [], model: null, testPassed: false, canPull: false,
        headline: 'Ollama is installed but not running',
        detail: 'Nothing is listening on port 11434 (' + err.code + ').',
        action: 'Start Ollama from the Start menu, or run "ollama serve", then click Re-check.'
      });
      logOnce(S.NOT_RUNNING, 'Ollama detected but the API is not responding (' + err.code + ')');
      return getAiStatus();
    }

    setState(S.UNREACHABLE, {
      reachable: false, models: [], model: null, testPassed: false, canPull: false,
      headline: 'Ollama is running but unreachable',
      detail: 'Could not connect on 127.0.0.1, ::1 or localhost port 11434 (' +
        (err.code || err.message || 'unknown') + ').',
      action: 'Check that no firewall is blocking local connections, then click Re-check.'
    });
    logOnce(S.UNREACHABLE, 'Ollama unreachable: ' + (err.code || err.message));
    return getAiStatus();
  }

  // API is up.
  state.endpoint = probe.endpoint;
  state.reachable = true;
  const names = probe.models.map(m => m.name || m.model).filter(Boolean);
  state.models = names;

  if (!names.length) {
    setState(S.NO_MODELS, {
      model: null, testPassed: false, canPull: true,
      headline: 'Ollama is running but has no models',
      detail: 'The AI engine is working; it just has nothing to run yet.',
      action: 'Download ' + state.wanted + ' (about 4.7 GB) to enable AI.'
    });
    logOnce(S.NO_MODELS, 'Ollama API responding at ' + probe.endpoint + ' but no models are installed');
    return getAiStatus();
  }

  const match = pickModel(names, state.wanted);
  if (!match) {
    setState(S.MODEL_MISSING, {
      model: null, testPassed: false, canPull: true,
      headline: state.wanted + ' is not installed',
      detail: 'Ollama is running with: ' + names.join(', ') + '.',
      action: 'Download ' + state.wanted + ', or set OLLAMA_MODEL in src\\.env to one you already have.'
    });
    logOnce(S.MODEL_MISSING, 'Ollama is running but ' + state.wanted + ' is not installed');
    return getAiStatus();
  }

  setState(S.READY, {
    model: match.name, canPull: false,
    headline: 'Local AI ready',
    detail: 'Ollama at ' + probe.endpoint + ' running ' + match.name +
      (match.exact ? '' : ' (closest match for ' + state.wanted + ')') + '. Runs on your PC, free.',
    action: ''
  });
  logOnce(S.READY + match.name, 'Ollama API responding at ' + probe.endpoint +
    ' | model ' + match.name + ' available');
  return getAiStatus();
}

// --- real end-to-end connectivity test --------------------------------------
// /api/tags responding is NOT proof the AI works. This sends a real prompt.
async function selfTest({ timeout = 90000 } = {}) {
  if (state.status !== S.READY) {
    return { ok: false, status: state.status, error: state.headline };
  }
  logAI('Running AI connectivity test (' + state.model + ')...');
  const t0 = Date.now();
  try {
    const r = await request(state.endpoint, '/api/chat', {
      method: 'POST', timeout,
      body: {
        model: state.model,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        stream: false,
        options: { num_predict: 12 }
      }
    });
    if (r.statusCode !== 200) {
      const msg = (r.body && r.body.error) || ('HTTP ' + r.statusCode);
      setState(S.MODEL_LOAD_FAILED, {
        testPassed: false,
        headline: 'The model failed to load',
        detail: 'Ollama answered: ' + msg,
        action: 'Try "ollama run ' + state.model + '" in a terminal to see the full error.'
      });
      logAI('AI test FAILED: ' + msg);
      return { ok: false, status: state.status, error: msg };
    }
    const text = (r.body && r.body.message && r.body.message.content) || '';
    const ms = Date.now() - t0;
    if (!text.trim()) {
      setState(S.API_ERROR, {
        testPassed: false,
        headline: 'The model returned an empty response',
        detail: 'Ollama replied but produced no text.',
        action: 'Try re-pulling the model: ollama pull ' + state.model
      });
      logAI('AI test FAILED: empty response');
      return { ok: false, status: state.status, error: 'empty response' };
    }
    state.testPassed = true;
    logAI('AI test successful (' + ms + 'ms): "' + text.trim().slice(0, 40) + '"');
    return { ok: true, status: S.READY, model: state.model, ms, reply: text.trim().slice(0, 200) };
  } catch (e) {
    const timedOut = e.code === 'ETIMEDOUT';
    setState(timedOut ? S.TIMEOUT : S.API_ERROR, {
      testPassed: false,
      headline: timedOut ? 'The AI request timed out' : 'The AI request failed',
      detail: timedOut
        ? 'The model did not answer within ' + Math.round(timeout / 1000) + 's. The first request after starting Ollama loads the model into memory and can be slow.'
        : String(e.message),
      action: timedOut ? 'Try again - it is usually much faster once loaded.' : 'Check that Ollama is still running.'
    });
    logAI('AI test FAILED: ' + (e.code || e.message));
    return { ok: false, status: state.status, error: e.code || e.message };
  }
}

// --- model download with progress -------------------------------------------
async function pullModel(model) {
  const target = model || state.wanted;
  if (state.pull.active) return { ok: false, error: 'A download is already in progress' };
  if (!state.reachable) return { ok: false, error: 'Ollama is not reachable' };

  state.pull = { active: true, model: target, percent: 0, status: 'starting', error: null, done: false };
  logAI('Downloading model ' + target + '...');

  try {
    const { res, statusCode } = await request(state.endpoint, '/api/pull', {
      method: 'POST', body: { model: target, stream: true }, stream: true, timeout: 0
    });
    if (statusCode !== 200) {
      state.pull = { ...state.pull, active: false, error: 'HTTP ' + statusCode, done: true };
      return { ok: false, error: 'HTTP ' + statusCode };
    }
    await new Promise((resolve, reject) => {
      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if (j.error) { state.pull.error = j.error; continue; }
            if (j.status) state.pull.status = j.status;
            if (j.total && j.completed) {
              state.pull.percent = Math.round((j.completed / j.total) * 100);
            }
          } catch { /* partial line */ }
        }
      });
      res.on('end', resolve);
      res.on('error', reject);
    });

    state.pull.active = false;
    state.pull.done = true;
    if (state.pull.error) {
      logAI('Model download failed: ' + state.pull.error);
      return { ok: false, error: state.pull.error };
    }
    state.pull.percent = 100;
    logAI('Model ' + target + ' downloaded');
    installedCache = null;
    await checkOllama();
    return { ok: true, model: target };
  } catch (e) {
    state.pull = { ...state.pull, active: false, error: e.message, done: true };
    logAI('Model download failed: ' + e.message);
    return { ok: false, error: e.message };
  }
}

function getAiStatus() {
  return {
    online: state.online,
    status: state.status,
    model: state.model,
    models: state.models,
    wanted: state.wanted,
    endpoint: state.endpoint,
    installed: state.installed !== null ? state.installed : installedCache,
    reachable: state.reachable,
    headline: state.headline,
    detail: state.detail,
    action: state.action,
    canPull: state.canPull,
    testPassed: state.testPassed,
    lastCheck: state.lastCheck,
    lastError: state.lastError,
    pull: state.pull,
    cost: state.cost
  };
}

// --- prompt building --------------------------------------------------------
function buildSystemPrompt() {
  const summary = analytics.todaySummary();
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `You are Paddock Intelligence, an expert UK and Irish horse racing analyst.
Today is ${today}. You have access to a local racing database with live data.

CURRENT DATA: ${summary.total_meetings} meetings today (${summary.gb_meetings} GB, ${summary.ire_meetings} IRE), ${summary.total_races} races, ${summary.total_runners} runners.
${summary.meetings.map(m => `${m.course} (${m.country}): ${m.race_count} races, going: ${m.going || 'UNKNOWN'}, first: ${m.first_race || '?'}, last: ${m.last_race || '?'}`).join('\n')}

RULES:
- Ground answers in actual retrieved data. Do NOT invent race times, runners, or results.
- If data is missing, say UNKNOWN or NOT AVAILABLE. Never hallucinate.
- Use the current date (${today}) for "today" questions.
- Separate FACTS (from data) from ANALYSIS (your interpretation).
- Do not present AI output as guaranteed betting advice.
- Show form figures, ratings, and statistics where available.
- Note small sample sizes when statistics are limited.

Format responses clearly with structure when listing multiple items.`;
}

function contextForQuestion(question) {
  const q = String(question || '').toLowerCase();
  const context = [];
  const summary = analytics.todaySummary();

  if (/today|meeting|racing|race/.test(q)) context.push({ type: 'meetings', data: summary });

  if (/race|runner|horse|card/.test(q)) {
    for (const race of db.getTodaysRaces().slice(0, 20)) {
      const runners = db.getRaceRunners(race.id);
      if (!runners.length) continue;
      context.push({
        type: 'race',
        data: {
          course: race.course, time: race.off_time, name: race.race_name,
          class: race.race_class, distance: race.distance, going: race.going,
          runners: runners.map(r => ({
            horse: r.horse, form: r.form, jockey: r.jockey, trainer: r.trainer,
            or: r.official_rating, age: r.age, weight: r.weight, draw: r.draw,
            odds: r.odds, nr: r.is_non_runner
          }))
        }
      });
    }
  }

  for (const m of summary.meetings) {
    if (!q.includes(m.course.toLowerCase())) continue;
    for (const race of db.getMeetingRaces(m.id)) {
      context.push({ type: 'race_detail', data: analytics.analyzeRace(race, db.getRaceRunners(race.id)) });
    }
  }
  return context;
}

// --- chat (streamed to the browser over SSE) --------------------------------
function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }

async function chat(messages, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*'
  });

  // Re-check rather than trusting a stale flag, so a user who just started
  // Ollama does not have to restart the whole app.
  if (state.status !== S.READY) await checkOllama({ autoStart: true });

  if (state.status !== S.READY) {
    sse(res, {
      type: 'status', status: state.status,
      headline: state.headline, detail: state.detail, action: state.action,
      canPull: state.canPull
    });
    sse(res, { type: 'text', content: state.headline + '\n\n' + state.detail + (state.action ? '\n\n' + state.action : '') });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  const last = messages[messages.length - 1]?.content || '';
  let systemPrompt = buildSystemPrompt();
  const ctx = contextForQuestion(last);
  if (ctx.length) systemPrompt += '\n\nRELEVANT DATA FOR THIS QUERY:\n' + JSON.stringify(ctx).slice(0, 8000);

  const payload = {
    model: state.model,
    messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-20)],
    stream: true
  };

  let upstream;
  try {
    upstream = await request(state.endpoint, '/api/chat', {
      method: 'POST', body: payload, stream: true, timeout: 120000
    });
  } catch (e) {
    const timedOut = e.code === 'ETIMEDOUT';
    logAI('Chat request failed: ' + (e.code || e.message));
    sse(res, {
      type: 'error',
      content: timedOut
        ? 'The AI request timed out. The first question after starting Ollama loads the model and can take a minute - please try again.'
        : 'Could not reach the local AI (' + (e.code || e.message) + '). Check the AI status panel.'
    });
    sse(res, { type: 'text', content: timedOut ? 'The AI request timed out. Please try again.' : 'Could not reach the local AI.' });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  if (upstream.statusCode !== 200) {
    let msg = 'HTTP ' + upstream.statusCode;
    try {
      const chunks = [];
      for await (const c of upstream.res) chunks.push(c);
      const j = JSON.parse(Buffer.concat(chunks).toString());
      if (j.error) msg = j.error;
    } catch { /* keep the status code */ }
    logAI('Chat request rejected by Ollama: ' + msg);
    sse(res, { type: 'error', content: msg });
    sse(res, { type: 'text', content: 'The local AI rejected the request: ' + msg });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // NDJSON. Buffer across chunk boundaries - a JSON object can be split in the
  // middle, which the previous implementation silently dropped.
  let buf = '';
  let got = 0;
  const stream = upstream.res;

  const finish = () => { if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); } };

  stream.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.error) { sse(res, { type: 'error', content: j.error }); continue; }
      const piece = j.message && j.message.content;
      if (piece) { got += piece.length; sse(res, { type: 'text', content: piece }); }
      if (j.done) finish();
    }
  });

  stream.on('end', () => {
    if (buf.trim()) {
      try {
        const j = JSON.parse(buf);
        if (j.message && j.message.content) sse(res, { type: 'text', content: j.message.content });
      } catch { /* trailing partial */ }
    }
    if (got === 0 && !res.writableEnded) {
      sse(res, { type: 'text', content: 'The local AI returned an empty response. Try asking again.' });
    }
    finish();
  });

  stream.on('error', e => {
    logAI('Chat stream error: ' + e.message);
    if (!res.writableEnded) { sse(res, { type: 'error', content: 'Stream error: ' + e.message }); finish(); }
  });

  res.on('close', () => { try { stream.destroy(); } catch { /* already gone */ } });
}

// --- cached race summaries --------------------------------------------------
async function generateSummary(raceId) {
  if (state.status !== S.READY) return null;
  const race = db.getRace(raceId);
  if (!race) return null;
  const runners = db.getRaceRunners(raceId);
  if (!runners.length) return null;

  const dataHash = db.hash({ race, runners });
  const cached = db.getAiCache('summary_' + raceId);
  if (cached && cached.data_hash === dataHash) return cached.content;

  const a = analytics.analyzeRace(race, runners);
  const prompt = `Briefly summarize this horse race (3-4 paragraphs max):

${race.off_time} ${race.course} - ${race.race_name}
${race.distance || '?'} | ${race.going || 'Going unknown'} | ${a.race_class} | ${a.field_size} runners

Top on form: ${a.top_on_form.map(r => `${r.horse} (form score ${r.form_score}, OR ${r.or || '?'})`).join(', ')}
Competitiveness: ${a.competitiveness}

Runners: ${a.runners.map(r => `${r.horse} - Form: ${r.form || 'none'}, OR: ${r.official_rating || '?'}, J: ${r.jockey || '?'}, T: ${r.trainer || '?'}, Score: ${r.form_score}`).join('; ')}

Separate: FACTS (what data shows), DERIVED STATS (calculated metrics), AI INTERPRETATION (your analysis). State unknowns clearly. Do not present as betting advice.`;

  try {
    const r = await request(state.endpoint, '/api/chat', {
      method: 'POST', timeout: 120000,
      body: { model: state.model, messages: [{ role: 'user', content: prompt }], stream: false }
    });
    const content = (r.body && r.body.message && r.body.message.content) || '';
    if (content) db.setAiCache('summary_' + raceId, dataHash, content);
    return content || null;
  } catch (e) {
    logAI('Race summary failed: ' + (e.code || e.message));
    return null;
  }
}

// Full startup diagnostic: detect -> (start) -> models -> real prompt.
async function diagnose({ autoStart = true, test = true } = {}) {
  await checkOllama({ autoStart, quiet: false });
  if (test && state.status === S.READY && !state.testPassed) await selfTest();
  return getAiStatus();
}

module.exports = {
  STATUS: S, checkOllama, getAiStatus, chat, generateSummary,
  selfTest, pullModel, diagnose, detectBinary
};
