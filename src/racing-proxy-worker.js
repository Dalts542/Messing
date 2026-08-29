// Cloudflare Worker — CORS proxy for racing data
// Deploy: https://workers.cloudflare.com → Create Worker → paste this → Deploy
//
// Once deployed, copy your worker URL (e.g. https://racing-proxy.your-name.workers.dev)
// and paste it into Paddock Intelligence Settings → Proxy URL
//
// Usage:
//   API mode:  ?url=https://api.theracingapi.com/...&user=USER&pass=PASS
//   Scrape mode: ?url=https://www.racingpost.com/racecards/...

const ALLOWED_DOMAINS = [
  'api.theracingapi.com',
  'www.racingpost.com',
  'www.sportinglife.com',
  'www.timeform.com'
];

function isDomainAllowed(targetUrl) {
  try {
    const host = new URL(targetUrl).hostname;
    return ALLOWED_DOMAINS.includes(host);
  } catch(e) { return false; }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const target = url.searchParams.get('url');
    if (!target || !isDomainAllowed(target)) {
      return new Response('Racing proxy. Allowed domains: ' + ALLOWED_DOMAINS.join(', '), {
        status: 200,
        headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const fetchHeaders = {
      'Accept': 'text/html,application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    const user = url.searchParams.get('user');
    const pass = url.searchParams.get('pass');
    if (user && pass) {
      fetchHeaders['Authorization'] = 'Basic ' + btoa(user + ':' + pass);
      fetchHeaders['Accept'] = 'application/json';
    }

    const res = await fetch(target, { headers: fetchHeaders, redirect: 'follow' });
    const body = await res.text();
    const contentType = res.headers.get('Content-Type') || 'text/html';

    return new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};
