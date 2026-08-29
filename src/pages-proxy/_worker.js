// Cloudflare Pages Worker — CORS proxy for The Racing API
// Deploy: Cloudflare Dashboard → Pages → Upload this FOLDER (not just the file)
//
// Usage: ?url=https://api.theracingapi.com/...&user=USERNAME&pass=PASSWORD

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
    if (!target || !target.startsWith('https://api.theracingapi.com/')) {
      return new Response('Racing API proxy. Use ?url=https://api.theracingapi.com/...&user=USER&pass=PASS', {
        status: 200,
        headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const user = url.searchParams.get('user');
    const pass = url.searchParams.get('pass');
    const headers = { 'Accept': 'application/json' };
    if (user && pass) {
      headers['Authorization'] = 'Basic ' + btoa(user + ':' + pass);
    }

    const res = await fetch(target, { headers });
    const body = await res.text();

    return new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};
