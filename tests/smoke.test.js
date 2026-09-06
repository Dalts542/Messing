'use strict';
// End-to-end startup smoke test.
//
// Proves the failure the Windows user hit cannot recur silently:
//   - the server binds to 127.0.0.1:3000
//   - /health returns HTTP 200
//   - the existing pages still serve
//   - a missing Ollama and missing racing credentials do NOT crash the server
//   - a port conflict is reported as EADDRINUSE rather than a crash
//
// Runs with no npm dependencies.

const http = require('http');
const path = require('path');
const net = require('net');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.TEST_PORT || '3000', 10);

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path: pathname, timeout: 10000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function expectStatus(name, pathname, expected) {
  try {
    const r = await get(pathname);
    const ok = r.status === expected;
    record(name, ok, 'HTTP ' + r.status + (ok ? '' : ', expected ' + expected));
    return r;
  } catch (e) {
    record(name, false, e.message);
    return null;
  }
}

async function main() {
  console.log('\n  Paddock Intelligence startup smoke test');
  console.log('  ---------------------------------------');
  console.log('  Node ' + process.version + '  |  cwd ' + process.cwd());
  console.log('');

  // Deliberately run in the degraded configuration the user will hit first:
  // no racing credentials, no Ollama.
  delete process.env.RACING_USER;
  delete process.env.RACING_PASS;
  process.env.OLLAMA_HOST = 'http://127.0.0.1:59999'; // guaranteed absent
  process.env.PORT = String(PORT);

  let server;
  try {
    server = require(path.join(__dirname, '..', 'src', 'server.js'));
    record('server.js loads without throwing', true);
  } catch (e) {
    record('server.js loads without throwing', false, e.message);
    return finish();
  }

  try {
    await server.startup({ quiet: true });
    record('server binds to ' + HOST + ':' + PORT, true);
  } catch (e) {
    record('server binds to ' + HOST + ':' + PORT, false, e.code || e.message);
    return finish();
  }

  // --- health ---------------------------------------------------------------
  const health = await expectStatus('/health returns HTTP 200', '/health', 200);
  if (health) {
    let j = null;
    try { j = JSON.parse(health.body); } catch { /* handled below */ }
    record('/health returns valid JSON with status:ok', !!(j && j.status === 'ok'),
      j ? JSON.stringify(j) : 'unparseable');
    record('server reports AI offline without crashing', !!(j && j.ai === false));
    record('server reports racing data unconfigured without crashing',
      !!(j && j.racing_configured === false));
  }

  // --- Paddock V2 is the application ----------------------------------------
  const root = await expectStatus('/ serves Paddock V2', '/', 200);
  if (root) {
    record('/ serves the V2 interface (not the old Paddock)',
      /Paddock Intelligence v2/i.test(root.body) && /id="mainContent"/.test(root.body),
      root.body.length + ' bytes');
    record('/ includes the V2 navigation',
      /data-view="today"/.test(root.body) && /data-view="ai"/.test(root.body));
    record('/ has no link back to the old Paddock',
      !/href="\/paddock/.test(root.body));
  }
  await expectStatus('/index.html serves V2', '/index.html', 200);

  // The retired original Paddock must redirect to V2, never 404 and never
  // serve a second competing interface.
  for (const legacy of ['/paddock', '/paddock.html']) {
    const r = await get(legacy);
    record(legacy + ' redirects to Paddock V2',
      r.status === 302 && r.headers.location === '/', 'HTTP ' + r.status + ' -> ' + r.headers.location);
  }
  record('old paddock.html file has been removed from the project',
    !require('fs').existsSync(path.join(__dirname, '..', 'src', 'paddock.html')));

  // --- other pages must still serve -----------------------------------------
  await expectStatus('/nexus-standalone.html serves', '/nexus-standalone.html', 200);
  await expectStatus('/bet-tracker.html serves', '/bet-tracker.html', 200);
  const tracker = await get('/bet-tracker.html');
  record('/bet-tracker.html contains real content', tracker.body.length > 1000,
    tracker.body.length + ' bytes');

  // --- API must degrade, not 500 --------------------------------------------
  for (const [name, p] of [
    ['/api/today', '/api/today'],
    ['/api/meetings', '/api/meetings'],
    ['/api/status', '/api/status'],
    ['/api/ai-status', '/api/ai-status'],
    ['/api/search?q=a', '/api/search?q=a'],
    ['/api/ai/diagnose', '/api/ai/diagnose?autostart=0&test=0']
  ]) {
    const r = await expectStatus(name + ' returns 200 with no data configured', p, 200);
    if (r) {
      let ok = true;
      try { JSON.parse(r.body); } catch { ok = false; }
      record(name + ' returns valid JSON', ok);
    }
  }

  // A missing file should 404, not 500.
  await expectStatus('unknown page returns 404 (not 500)', '/definitely-not-here.html', 404);

  // --- port conflict must surface as EADDRINUSE, not a crash ----------------
  await new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', err => {
      record('second bind on busy port reports EADDRINUSE', err.code === 'EADDRINUSE', err.code);
      resolve();
    });
    probe.once('listening', () => {
      record('second bind on busy port reports EADDRINUSE', false, 'unexpectedly bound');
      probe.close(resolve);
    });
    probe.listen(PORT, HOST);
  });

  // --- clean shutdown, port released ----------------------------------------
  try {
    await server.shutdown();
    record('server shuts down cleanly', true);
  } catch (e) {
    record('server shuts down cleanly', false, e.message);
  }

  await new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', err => {
      record('port released after shutdown', false, err.code);
      resolve();
    });
    probe.once('listening', () => {
      record('port released after shutdown', true);
      probe.close(resolve);
    });
    probe.listen(PORT, HOST);
  });

  finish();
}

function finish() {
  const passed = results.filter(r => r.ok).length;
  console.log('');
  console.log('  ' + passed + '/' + results.length + ' passed');
  console.log('');
  process.exitCode = passed === results.length ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 50).unref();
}

main().catch(e => {
  record('unexpected test error', false, e.stack || e.message);
  finish();
});
