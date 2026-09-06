'use strict';
// Ollama integration tests.
//
// Every distinct failure state is asserted, and the full pipeline
//   Paddock V2 -> Node -> Ollama -> model -> streamed response -> Paddock V2
// is exercised against a mock Ollama that behaves like the real API.
//
// Regression covered: the client used to dial "http://localhost:11434".
// On Windows that resolves to ::1 first while Ollama binds 127.0.0.1 only,
// producing ECONNREFUSED and a permanent, misleading "Local AI is offline".

const path = require('path');
const fs = require('fs');
const os = require('os');
const { startMockOllama } = require('./mock-ollama');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}
function check(name, cond, detail) { record(name, !!cond, detail); }

// Load a pristine copy of the AI module with specific env.
function freshAi(env = {}) {
  for (const k of Object.keys(require.cache)) {
    if (/src[\\/](ai|analytics|db|sources|server)\.js$/.test(k)) delete require.cache[k];
  }
  delete process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_MODEL;
  delete process.env.OLLAMA_AUTOSTART;
  Object.assign(process.env, env);
  const db = require(path.join(__dirname, '..', 'src', 'db.js'));
  db.initDb();
  return require(path.join(__dirname, '..', 'src', 'ai.js'));
}

// Minimal stand-in for a Node ServerResponse, capturing the SSE stream the
// browser would receive.
function fakeRes() {
  const chunks = [];
  const r = {
    headersSent: false,
    writableEnded: false,
    _resolve: null,
    writeHead() { r.headersSent = true; return r; },
    write(c) { chunks.push(String(c)); return true; },
    end() { r.writableEnded = true; if (r._resolve) r._resolve(); return r; },
    on() { return r; },
    removeListener() { return r; },
    once() { return r; },
    raw: () => chunks.join(''),
    events() {
      return chunks.join('').split('\n')
        .filter(l => l.startsWith('data: '))
        .map(l => l.slice(6))
        .filter(p => p !== '[DONE]')
        .map(p => { try { return JSON.parse(p); } catch { return null; } })
        .filter(Boolean);
    },
    text() { return r.events().filter(e => e.type === 'text').map(e => e.content).join(''); },
    errors() { return r.events().filter(e => e.type === 'error').map(e => e.content); },
    finished() { return new Promise(res => { if (r.writableEnded) return res(); r._resolve = res; }); }
  };
  return r;
}

async function main() {
  console.log('\n  Ollama integration tests');
  console.log('  ------------------------\n');

  // === 1. Ollama not installed / nothing listening ==========================
  {
    const ai = freshAi({ OLLAMA_HOST: 'http://127.0.0.1:1', OLLAMA_AUTOSTART: '0' });
    const st = await ai.checkOllama();
    check('unavailable Ollama is NOT reported as READY', st.status !== 'READY', st.status);
    check('unavailable Ollama gives an actionable status',
      ['NOT_INSTALLED', 'NOT_RUNNING', 'UNREACHABLE'].includes(st.status), st.status);
    check('unavailable Ollama has a headline', !!st.headline, st.headline);
    check('unavailable Ollama has an action', !!st.action);
    check('online flag is false', st.online === false);
  }

  // === 2. Installed but not running =========================================
  {
    // Put a fake "ollama" on PATH so detection finds the binary while nothing
    // is listening - the "installed but stopped" case.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fakeollama-'));
    const isWin = process.platform === 'win32';
    const file = path.join(bin, isWin ? 'ollama.cmd' : 'ollama');
    fs.writeFileSync(file, isWin ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
    if (!isWin) fs.chmodSync(file, 0o755);

    const ai = freshAi({
      OLLAMA_HOST: 'http://127.0.0.1:1',
      OLLAMA_AUTOSTART: '0',
      PATH: bin + path.delimiter + process.env.PATH
    });
    const st = await ai.checkOllama();
    check('installed-but-stopped reports NOT_RUNNING', st.status === 'NOT_RUNNING', st.status);
    check('NOT_RUNNING tells the user to start Ollama', /start/i.test(st.action || ''), st.action);
    check('NOT_RUNNING is distinct from NOT_INSTALLED', st.status !== 'NOT_INSTALLED');
    fs.rmSync(bin, { recursive: true, force: true });
  }

  // === 3. Running but no models installed ===================================
  {
    const mock = await startMockOllama({ models: [] });
    const ai = freshAi({ OLLAMA_HOST: mock.url });
    const st = await ai.checkOllama();
    check('running with no models reports NO_MODELS', st.status === 'NO_MODELS', st.status);
    check('NO_MODELS does NOT claim Ollama is offline', /running/i.test(st.headline), st.headline);
    check('NO_MODELS offers a download', st.canPull === true);
    await mock.close();
  }

  // === 4. Running, but the wanted model is missing ==========================
  {
    const mock = await startMockOllama({ models: ['mistral:7b', 'phi3:mini'] });
    const ai = freshAi({ OLLAMA_HOST: mock.url, OLLAMA_MODEL: 'llama3.1:8b' });
    const st = await ai.checkOllama();
    check('missing model reports MODEL_MISSING', st.status === 'MODEL_MISSING', st.status);
    check('MODEL_MISSING lists what IS installed', /mistral/.test(st.detail), st.detail);
    check('MODEL_MISSING offers a download', st.canPull === true);
    await mock.close();
  }

  // === 5. Fully working: model present ======================================
  {
    const mock = await startMockOllama({ models: ['llama3.1:8b'] });
    const ai = freshAi({ OLLAMA_HOST: mock.url, OLLAMA_MODEL: 'llama3.1:8b' });
    const st = await ai.checkOllama();
    check('llama3.1:8b present reports READY', st.status === 'READY', st.status);
    check('READY resolves the exact model', st.model === 'llama3.1:8b', st.model);
    check('online flag true when READY', st.online === true);

    // The real proof: an actual prompt/response round trip.
    const t = await ai.selfTest({ timeout: 10000 });
    check('self-test sends a real prompt and gets a reply', t.ok === true, t.error || t.reply);
    check('self-test reply is non-empty text', !!(t.reply && t.reply.length), t.reply);
    check('status records the test as passed', ai.getAiStatus().testPassed === true);
    const chatCall = mock.calls.find(c => c.url === '/api/chat');
    check('self-test used the correct model name',
      chatCall && chatCall.body.model === 'llama3.1:8b', chatCall && chatCall.body.model);
    await mock.close();
  }

  // === 6. Model tagged :latest still matches ================================
  {
    const mock = await startMockOllama({ models: ['llama3.1:8b-instruct-q4_0', 'llama3.1:latest'] });
    const ai = freshAi({ OLLAMA_HOST: mock.url, OLLAMA_MODEL: 'llama3.1' });
    const st = await ai.checkOllama();
    check('family match resolves a usable model', st.status === 'READY', st.status + ' ' + st.model);
    await mock.close();
  }

  // === 7. Full streaming chat pipeline ======================================
  {
    const mock = await startMockOllama({ models: ['llama3.1:8b'], reply: 'Kempton has 7 races today. ' });
    const ai = freshAi({ OLLAMA_HOST: mock.url, OLLAMA_MODEL: 'llama3.1:8b' });
    await ai.checkOllama();

    const res = fakeRes();
    await ai.chat([{ role: 'user', content: 'What is racing today?' }], res);
    await res.finished();

    check('chat streams SSE to the browser', res.raw().includes('data: '));
    check('chat delivers the model text end to end',
      res.text().includes('Kempton has 7 races today.'), JSON.stringify(res.text()));
    check('chat terminates the SSE stream with [DONE]', res.raw().includes('data: [DONE]'));
    check('chat reported no errors', res.errors().length === 0, res.errors().join(';'));

    const call = mock.calls.filter(c => c.url === '/api/chat').pop();
    check('chat requested streaming', call && call.body.stream === true);
    check('chat sent a system prompt first',
      call && call.body.messages[0].role === 'system');
    check('chat forwarded the user question',
      call && call.body.messages.some(m => m.role === 'user' && /racing today/i.test(m.content)));
    await mock.close();
  }

  // === 8. Streaming JSON split across chunk boundaries ======================
  // This is the exact corruption the previous per-chunk split('\n') caused.
  {
    const mock = await startMockOllama({
      models: ['llama3.1:8b'], reply: 'Alpha Beta Gamma Delta Epsilon ', splitMidJson: true
    });
    const ai = freshAi({ OLLAMA_HOST: mock.url, OLLAMA_MODEL: 'llama3.1:8b' });
    await ai.checkOllama();
    const res = fakeRes();
    await ai.chat([{ role: 'user', content: 'hello' }], res);
    await res.finished();
    check('tokens survive JSON split across TCP chunks',
      res.text().includes('Alpha Beta Gamma Delta Epsilon'), JSON.stringify(res.text()));
    await mock.close();
  }

  // === 9. Ollama API error during chat ======================================
  {
    const mock = await startMockOllama({ models: ['llama3.1:8b'], mode: 'error500' });
    const ai = freshAi({ OLLAMA_HOST: mock.url, OLLAMA_MODEL: 'llama3.1:8b' });
    await ai.checkOllama();
    const res = fakeRes();
    await ai.chat([{ role: 'user', content: 'hello' }], res);
    await res.finished();
    check('API error is surfaced, not swallowed', res.errors().length > 0, res.errors().join(';'));
    check('API error still shows the user something', res.text().length > 0);
    check('API error still closes the stream', res.raw().includes('[DONE]'));
    await mock.close();
  }

  // === 10. Model missing at request time ====================================
  {
    const mock = await startMockOllama({ models: ['llama3.1:8b'], mode: 'modelNotFound' });
    const ai = freshAi({ OLLAMA_HOST: mock.url, OLLAMA_MODEL: 'llama3.1:8b' });
    await ai.checkOllama();
    const res = fakeRes();
    await ai.chat([{ role: 'user', content: 'hello' }], res);
    await res.finished();
    check('"model not found" is reported verbatim',
      res.errors().some(e => /not found/i.test(e)), res.errors().join(';'));
    await mock.close();
  }

  // === 11. Timeout =========================================================
  {
    const mock = await startMockOllama({ models: ['llama3.1:8b'], mode: 'hang' });
    const ai = freshAi({ OLLAMA_HOST: mock.url, OLLAMA_MODEL: 'llama3.1:8b' });
    // /api/tags hangs too, so the check itself must time out cleanly.
    const st = await ai.checkOllama();
    check('a hanging Ollama reports TIMEOUT (not a crash)', st.status === 'TIMEOUT', st.status);
    check('TIMEOUT explains itself', /respond/i.test(st.headline), st.headline);
    await mock.close();
  }

  // === 12. Empty model response ============================================
  {
    const mock = await startMockOllama({ models: ['llama3.1:8b'], mode: 'empty' });
    const ai = freshAi({ OLLAMA_HOST: mock.url, OLLAMA_MODEL: 'llama3.1:8b' });
    await ai.checkOllama();
    const t = await ai.selfTest({ timeout: 8000 });
    check('empty model reply fails the self-test', t.ok === false, t.error);
    check('empty reply is not reported as READY', ai.getAiStatus().status !== 'READY',
      ai.getAiStatus().status);
    await mock.close();
  }

  // === 13. Model pull with progress ========================================
  {
    const mock = await startMockOllama({ models: [] });
    const ai = freshAi({ OLLAMA_HOST: mock.url, OLLAMA_MODEL: 'llama3.1:8b' });
    const before = await ai.checkOllama();
    check('pull precondition: NO_MODELS', before.status === 'NO_MODELS', before.status);

    const r = await ai.pullModel('llama3.1:8b');
    check('pull completes successfully', r.ok === true, r.error);
    const pullCall = mock.calls.find(c => c.url === '/api/pull');
    check('pull requested the right model',
      pullCall && pullCall.body.model === 'llama3.1:8b', pullCall && pullCall.body.model);
    check('pull reported 100% when finished', ai.getAiStatus().pull.percent === 100);
    check('pull is not left marked active', ai.getAiStatus().pull.active === false);
    await mock.close();
  }

  // === 14. THE WINDOWS REGRESSION ==========================================
  // Mock binds 127.0.0.1 only, exactly like Ollama. With no OLLAMA_HOST set,
  // the client must still find it via its candidate list rather than relying
  // on how the OS happens to resolve "localhost".
  {
    const mock = await startMockOllama({ models: ['llama3.1:8b'], host: '127.0.0.1', port: 11434 });
    const ai = freshAi({ OLLAMA_MODEL: 'llama3.1:8b' }); // no OLLAMA_HOST on purpose
    const st = await ai.checkOllama();
    check('finds an IPv4-only Ollama with no OLLAMA_HOST configured',
      st.status === 'READY', st.status);
    check('records which endpoint actually worked',
      st.endpoint === 'http://127.0.0.1:11434', st.endpoint);
    check('endpoint is an explicit address, never bare "localhost"',
      !/\/\/localhost:/.test(st.endpoint || ''), st.endpoint);

    const t = await ai.selfTest({ timeout: 10000 });
    check('IPv4-only Ollama completes a real prompt round trip', t.ok === true, t.error);
    await mock.close();
  }

  // === 15. Source guard: no bare localhost in the AI client =================
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai.js'), 'utf8');
    const defaultsToLocalhost = /OLLAMA_HOST\s*\|\|\s*['"]http:\/\/localhost/.test(src);
    check('ai.js does not default to http://localhost (the Windows bug)', !defaultsToLocalhost);
    check('ai.js tries 127.0.0.1 explicitly', /127\.0\.0\.1:11434/.test(src));
    check('ai.js buffers streaming NDJSON across chunks',
      /buf\s*\+=\s*chunk/.test(src) && /lines\.pop\(\)/.test(src));

    // The shipped .env template must not pin OLLAMA_HOST to localhost: an
    // explicit value overrides the candidate list and would re-create the
    // Windows failure on every fresh install.
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'src', 'env-example.txt'), 'utf8');
    const activeHost = tpl.split(/\r?\n/)
      .filter(l => /^\s*OLLAMA_HOST\s*=/.test(l));
    check('env template does not set OLLAMA_HOST at all', activeHost.length === 0,
      activeHost.join(' | '));
    check('env template does not steer users to localhost',
      !/^\s*OLLAMA_HOST\s*=.*localhost/m.test(tpl));
    check('env template still sets a model', /^\s*OLLAMA_MODEL\s*=\S+/m.test(tpl));
  }

  const passed = results.filter(r => r.ok).length;
  console.log('\n  ' + passed + '/' + results.length + ' passed\n');
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => {
  record('unexpected error', false, e.stack || e.message);
  console.log('\n  ' + results.filter(r => r.ok).length + '/' + results.length + ' passed\n');
  process.exit(1);
});
