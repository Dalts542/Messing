const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3000', 10);

const RACING_USER = process.env.RACING_USER || '';
const RACING_PASS = process.env.RACING_PASS || '';

const ALLOWED_DOMAINS = [
  'api.theracingapi.com',
  'www.racingpost.com',
  'www.sportinglife.com',
  'www.timeform.com'
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function isDomainAllowed(targetUrl) {
  try {
    return ALLOWED_DOMAINS.includes(new URL(targetUrl).hostname);
  } catch { return false; }
}

function proxyRequest(target, user, pass, res) {
  const parsed = new URL(target);
  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'PaddockIntelligence/1.0'
  };
  if (user && pass) {
    headers['Authorization'] = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
  }

  const opts = {
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers
  };

  const proxyReq = https.request(opts, (proxyRes) => {
    let body = '';
    proxyRes.on('data', (chunk) => { body += chunk; });
    proxyRes.on('end', () => {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(body);
    });
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Proxy error: ' + err.message);
  });

  proxyReq.setTimeout(15000, () => {
    proxyReq.destroy();
    res.writeHead(504, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Proxy timeout');
  });

  proxyReq.end();
}

function serveStatic(filePath, res) {
  const safePath = path.resolve(__dirname, filePath);
  if (!safePath.startsWith(path.resolve(__dirname))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    });
    res.end();
    return;
  }

  if (pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target || !isDomainAllowed(target)) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Missing or disallowed target URL. Allowed: ' + ALLOWED_DOMAINS.join(', '));
      return;
    }
    const user = parsed.query.user || RACING_USER;
    const pass = parsed.query.pass || RACING_PASS;
    proxyRequest(target, user, pass, res);
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', racing_configured: !!(RACING_USER && RACING_PASS) }));
    return;
  }

  let file = pathname === '/' ? 'paddock.html' : pathname.slice(1);
  if (!path.extname(file)) file += '.html';
  serveStatic(file, res);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Paddock Intelligence — Local Server');
  console.log('  ====================================');
  console.log('  http://' + HOST + ':' + PORT + '/');
  console.log('  http://' + HOST + ':' + PORT + '/paddock.html');
  console.log('  http://' + HOST + ':' + PORT + '/bet-tracker.html');
  console.log('  http://' + HOST + ':' + PORT + '/nexus-standalone.html');
  console.log('');
  console.log('  Racing API: ' + (RACING_USER ? 'configured' : 'NOT configured — set RACING_USER and RACING_PASS in .env'));
  console.log('  Proxy endpoint: http://' + HOST + ':' + PORT + '/proxy?url=...');
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
