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

// Which upstream resources this proxy will serve. Adding one here is the only
// change needed to expose it; everything else is parameter validation.
const ENDPOINTS = ['consensus-rankings', 'projections'];

// nflverse publishes open weekly data as CSV on GitHub releases. It is routed
// through here rather than fetched directly for three reasons: CORS on release
// assets is not guaranteed, the files are several megabytes, and the edge cache
// means a whole league costs one upstream fetch a day.
const NFLVERSE_BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const NFLVERSE_DATASETS = {
  player_stats: {
    path: season => `player_stats/player_stats_${season}.csv`,
    columns: ['player_id', 'player_display_name', 'position', 'recent_team', 'season', 'week',
      'targets', 'receptions', 'carries', 'receiving_air_yards', 'target_share', 'air_yards_share',
      'wopr', 'fantasy_points', 'fantasy_points_ppr']
  },
  snap_counts: {
    path: season => `snap_counts/snap_counts_${season}.csv`,
    columns: ['player', 'position', 'team', 'season', 'week', 'offense_snaps', 'offense_pct']
  }
};
const NFLVERSE_CACHE_SECONDS = 60 * 60 * 12;

// Minimal CSV reader. Mirrors parseCsv in usage.js, which is the tested copy;
// this one exists only so the worker can strip columns before sending.
function readCsv(text) {
  const rows = [];
  let field = '', row = [], quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function handleNflverse(incoming, cors, ctx) {
  const dataset = incoming.searchParams.get('dataset') || 'player_stats';
  const season = incoming.searchParams.get('season') || String(new Date().getFullYear());
  const spec = NFLVERSE_DATASETS[dataset];
  if (!spec || !/^\d{4}$/.test(season)) {
    return new Response(JSON.stringify({ error: 'Unknown dataset or season', allowed: Object.keys(NFLVERSE_DATASETS) }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  const url = `${NFLVERSE_BASE}/${spec.path(season)}`;
  const cacheKey = new Request(url, { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    for (const [k, v] of Object.entries(cors)) hit.headers.set(k, v);
    return hit;
  }

  const upstream = await fetch(url, { headers: { Accept: 'text/csv' } });
  if (!upstream.ok) {
    return new Response(JSON.stringify({ error: `nflverse returned HTTP ${upstream.status}`, dataset, season }), {
      status: 502, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  const rows = readCsv(await upstream.text());
  if (!rows.length) {
    return new Response(JSON.stringify({ error: 'Empty dataset' }), {
      status: 502, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
  const header = rows[0].map(h => h.trim());
  const keep = spec.columns.map(col => header.indexOf(col)).filter(i => i >= 0);
  const keptNames = keep.map(i => header[i]);
  const out = rows.slice(1)
    .filter(r => r.length > 1)
    .map(r => Object.fromEntries(keptNames.map((name, n) => [name, r[keep[n]] ?? ''])));

  const body = JSON.stringify({ dataset, season, columns: keptNames, count: out.length, rows: out });
  const response = new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${NFLVERSE_CACHE_SECONDS}` }
  });
  ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  const result = new Response(response.body, response);
  for (const [k, v] of Object.entries(cors)) result.headers.set(k, v);
  return result;
}
const CACHE_SECONDS = 60 * 60 * 6;

// Only these may be forwarded, and only with these values. An open proxy with
// your key attached is a liability.
const ALLOWED = {
  type: ['dynasty', 'draft', 'weekly', 'ros'],
  scoring: ['STD', 'HALF', 'PPR'],
  position: ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST', 'FLEX', 'OP'],
  week: /^\d{1,2}$/,
  season: /^\d{4}$/,
  limit: /^\d{1,4}$/
};

// The free public tier caps every response at 10 players regardless of any
// limit parameter, but the cap is per REQUEST, not per key. Asking for each
// position separately returns the top 10 at each, which is where positional
// disagreement actually lives. `positions=QB,RB,WR,TE` fans out and merges.
const MAX_FANOUT = 6;

async function fetchRanking(upstreamUrl, apiKey) {
  const response = await fetch(upstreamUrl, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' }
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, status: response.status, text };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: 502, text };
  }
}

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
    const incoming = new URL(request.url);
    const season = incoming.searchParams.get('season') || String(new Date().getFullYear());
    if (!ALLOWED.season.test(season)) {
      return new Response(JSON.stringify({ error: 'Bad season' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const endpoint = incoming.searchParams.get('endpoint') || 'consensus-rankings';

    // nflverse is open data and needs no key, so it bypasses the key check.
    if (endpoint === 'nflverse') return handleNflverse(incoming, cors, ctx);

    if (!env.FANTASYPROS_API_KEY) {
      return new Response(JSON.stringify({ error: 'Proxy is missing FANTASYPROS_API_KEY' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    if (!ENDPOINTS.includes(endpoint)) {
      return new Response(JSON.stringify({ error: 'Unknown endpoint', allowed: ENDPOINTS }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const upstream = new URL(`${UPSTREAM}/${season}/${endpoint}`);
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

    // Fan-out mode: one browser request becomes several upstream ones, merged.
    const positionsParam = incoming.searchParams.get('positions');
    if (positionsParam) {
      const positions = positionsParam.split(',').map(p => p.trim().toUpperCase()).filter(Boolean);
      if (!positions.length || positions.length > MAX_FANOUT || positions.some(p => !ALLOWED.position.includes(p))) {
        return new Response(JSON.stringify({ error: 'Bad positions list' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      const fanKey = new Request(`${upstream.toString()}&__fan=${endpoint}:${positions.join(',')}`, { method: 'GET' });
      const cachedFan = await caches.default.match(fanKey);
      if (cachedFan) {
        const hit = new Response(cachedFan.body, cachedFan);
        for (const [k, v] of Object.entries(cors)) hit.headers.set(k, v);
        return hit;
      }

      const results = await Promise.all(positions.map(position => {
        const url = new URL(upstream.toString());
        url.searchParams.set('position', position);
        return fetchRanking(url.toString(), env.FANTASYPROS_API_KEY).then(r => ({ position, ...r }));
      }));

      const failed = results.filter(r => !r.ok);
      if (failed.length === results.length) {
        return new Response(JSON.stringify({ error: 'All upstream requests failed', status: failed[0].status }), {
          status: 502, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      const seen = new Set();
      const players = [];
      const coverage = {};
      let limited = false;
      let tier = null;
      let lastUpdated = null;
      for (const result of results) {
        if (!result.ok) { coverage[result.position] = { error: result.status }; continue; }
        const rows = result.data.players || [];
        coverage[result.position] = { returned: rows.length, total: Number(result.data.count) || null };
        limited = limited || result.data.public_api_limited === true;
        tier = tier || result.data.tier || null;
        lastUpdated = lastUpdated || result.data.last_updated || null;
        for (const row of rows) {
          const id = String(row.player_id ?? `${row.player_name}|${row.player_position_id}`);
          if (seen.has(id)) continue;
          seen.add(id);
          players.push(row);
        }
      }

      const body = JSON.stringify({
        merged: true,
        positions,
        coverage,
        public_api_limited: limited,
        tier,
        last_updated: lastUpdated,
        count: players.length,
        players
      });
      const merged = new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` }
      });
      ctx.waitUntil(caches.default.put(fanKey, merged.clone()));
      const out = new Response(merged.body, merged);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
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
