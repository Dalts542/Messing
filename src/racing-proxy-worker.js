// Cloudflare Worker — CORS proxy for The Racing API
// Deploy: https://workers.cloudflare.com → Create Worker → paste this → Deploy
//
// Once deployed, copy your worker URL (e.g. https://racing-proxy.your-name.workers.dev)
// and paste it into Paddock Intelligence Settings → Proxy URL

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const target = url.searchParams.get('url');
    if (!target || !target.startsWith('https://api.theracingapi.com/')) {
      return new Response('Pass ?url=https://api.theracingapi.com/...', { status: 400 });
    }

    const auth = request.headers.get('Authorization');
    const headers = { 'Accept': 'application/json' };
    if (auth) headers['Authorization'] = auth;

    const res = await fetch(target, { headers });
    const body = await res.text();

    return new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type'
      }
    });
  }
};
