/**
 * Cloudflare Worker: FantasyPros proxy.
 *
 * The FantasyPros API requires an x-api-key header. A static site cannot hold
 * that key — anything in app.js is readable by anyone who opens devtools — so
 * the browser calls this worker instead and the worker holds the secret.
 *
 * Deploy:
 *   npx wrangler deploy worker/fantasypros-proxy.js --name dol-fantasypros
 *   npx wrangler secret put FANTASYPROS_API_KEY
 *
 * Then set CONFIG.proxyBase in app.js to the deployed worker URL.
 *
 * NOTE: verify the upstream path and query parameters against your FantasyPros
 * API documentation. Their endpoint shapes have changed across versions and the
 * defaults below may need adjusting for your subscription tier.
 */

const UPSTREAM = 'https://api.fantasypros.com/public/v2/json/nfl';
const CACHE_SECONDS = 60 * 60 * 6;

// Only these may be forwarded, and only with these values. An open proxy with
// your key attached is a liability.
const ALLOWED = {
  type: ['dynasty', 'draft', 'weekly', 'ros'],
  scoring: ['STD', 'HALF', 'PPR'],
  position: ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST', 'FLEX', 'OP'],
  week: /^\d{1,2}$/,
  season: /^\d{4}$/
};

function corsHeaders(origin, allowedOrigins) {
  const allow = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

export default {
  async fetch(request, env, ctx) {
    const origins = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, origins);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    if (origins[0] !== '*' && origin && !origins.includes(origin)) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
    if (!env.FANTASYPROS_API_KEY) {
      return new Response(JSON.stringify({ error: 'Proxy is missing FANTASYPROS_API_KEY' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const incoming = new URL(request.url);
    const season = incoming.searchParams.get('season') || String(new Date().getFullYear());
    if (!ALLOWED.season.test(season)) {
      return new Response(JSON.stringify({ error: 'Bad season' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const upstream = new URL(`${UPSTREAM}/${season}/consensus-rankings`);
    for (const [key, rule] of Object.entries(ALLOWED)) {
      if (key === 'season') continue;
      const value = incoming.searchParams.get(key);
      if (value == null) continue;
      const ok = Array.isArray(rule) ? rule.includes(value) : rule.test(value);
      if (!ok) {
        return new Response(JSON.stringify({ error: `Bad value for ${key}` }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      upstream.searchParams.set(key, value);
    }

    // Cache at the edge so a twelve-person league is one upstream call, not twelve.
    const cacheKey = new Request(upstream.toString(), { method: 'GET' });
    const cache = caches.default;
    let response = await cache.match(cacheKey);

    if (!response) {
      const fetched = await fetch(upstream.toString(), {
        headers: { 'x-api-key': env.FANTASYPROS_API_KEY, 'Accept': 'application/json' }
      });
      const body = await fetched.text();
      response = new Response(body, {
        status: fetched.status,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_SECONDS}`
        }
      });
      if (fetched.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    const out = new Response(response.body, response);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  }
};
