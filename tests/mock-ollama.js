'use strict';
// A stand-in for the real Ollama HTTP API, so the whole AI pipeline can be
// tested without a 4.7 GB model download.
//
// It binds to 127.0.0.1 ONLY - exactly like the real Ollama - which is what
// makes the Windows "localhost resolves to ::1" failure reproducible here.

const http = require('http');

function ndjson(res, objects, { splitMidJson = false, delayMs = 0 } = {}) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  let i = 0;
  const writeNext = () => {
    if (i >= objects.length) return res.end();
    const line = JSON.stringify(objects[i]) + '\n';
    if (splitMidJson && line.length > 8) {
      // Deliberately cut a JSON object across two TCP chunks. The old client
      // split on '\n' per chunk and silently dropped tokens like this.
      const cut = Math.floor(line.length / 2);
      res.write(line.slice(0, cut));
      setTimeout(() => { res.write(line.slice(cut)); i++; setImmediate(writeNext); }, 5);
      return;
    }
    res.write(line);
    i++;
    if (delayMs) setTimeout(writeNext, delayMs); else setImmediate(writeNext);
  };
  writeNext();
}

/**
 * @param {object} opts
 *   models        array of model names to report from /api/tags
 *   reply         text the chat endpoint returns
 *   mode          'ok' | 'error500' | 'modelNotFound' | 'hang' | 'empty' | 'badJson'
 *   splitMidJson  split streaming JSON across chunk boundaries
 *   host          bind address (default 127.0.0.1 - IPv4 only, like Ollama)
 */
function startMockOllama(opts = {}) {
  const {
    models = ['llama3.1:8b'],
    reply = 'ready',
    mode = 'ok',
    splitMidJson = false,
    host = '127.0.0.1',
    port = 0
  } = opts;

  const calls = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { /* ignore */ }
      calls.push({ method: req.method, url: req.url, body: parsed });

      if (mode === 'hang') return; // never responds - exercises the timeout path

      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          models: models.map(n => ({
            name: n, model: n, size: 4661224676,
            digest: 'sha256:' + 'a'.repeat(12),
            details: { family: n.split(':')[0], parameter_size: '8B' }
          }))
        }));
      }

      if (req.url === '/api/chat') {
        if (mode === 'error500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'internal server error' }));
        }
        if (mode === 'modelNotFound') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'model "' + (parsed && parsed.model) + '" not found, try pulling it first' }));
        }
        const text = mode === 'empty' ? '' : reply;

        if (parsed && parsed.stream) {
          const words = text ? text.split(/(?<= )/) : [];
          const frames = words.map(w => ({
            model: parsed.model, message: { role: 'assistant', content: w }, done: false
          }));
          frames.push({ model: parsed.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' });
          return ndjson(res, frames, { splitMidJson });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          model: parsed && parsed.model,
          message: { role: 'assistant', content: text },
          done: true
        }));
      }

      if (req.url === '/api/pull') {
        const name = (parsed && (parsed.model || parsed.name)) || 'unknown';
        if (mode === 'error500') {
          return ndjson(res, [{ error: 'pull failed: manifest not found' }]);
        }
        return ndjson(res, [
          { status: 'pulling manifest' },
          { status: 'pulling ' + name, total: 1000, completed: 250 },
          { status: 'pulling ' + name, total: 1000, completed: 750 },
          { status: 'pulling ' + name, total: 1000, completed: 1000 },
          { status: 'verifying sha256 digest' },
          { status: 'success' }
        ], { delayMs: 5 });
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  return new Promise(resolve => {
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        host,
        url: 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + addr.port,
        calls,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

module.exports = { startMockOllama };
