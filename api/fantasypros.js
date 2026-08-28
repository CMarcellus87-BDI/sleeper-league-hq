/**
 * Vercel / Netlify serverless equivalent of worker/fantasypros-proxy.js.
 * Use this one if you deploy the site to Vercel or Netlify instead of pairing
 * GitHub Pages with a Cloudflare Worker. Set FANTASYPROS_API_KEY in the host's
 * environment variables, never in the repo.
 */

const UPSTREAM = 'https://api.fantasypros.com/public/v2/json/nfl';
const ALLOWED = {
  type: ['dynasty', 'draft', 'weekly', 'ros'],
  scoring: ['STD', 'HALF', 'PPR'],
  position: ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST', 'FLEX', 'OP'],
  week: /^\d{1,2}$/
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.FANTASYPROS_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FANTASYPROS_API_KEY' });
  }

  const season = String(req.query.season || new Date().getFullYear());
  if (!/^\d{4}$/.test(season)) return res.status(400).json({ error: 'Bad season' });

  const url = new URL(`${UPSTREAM}/${season}/consensus-rankings`);
  for (const [key, rule] of Object.entries(ALLOWED)) {
    const value = req.query[key];
    if (value == null) continue;
    const ok = Array.isArray(rule) ? rule.includes(value) : rule.test(String(value));
    if (!ok) return res.status(400).json({ error: `Bad value for ${key}` });
    url.searchParams.set(key, String(value));
  }

  try {
    const upstream = await fetch(url.toString(), {
      headers: { 'x-api-key': process.env.FANTASYPROS_API_KEY, 'Accept': 'application/json' }
    });
    const body = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    return res.status(upstream.status).send(body);
  } catch (e) {
    return res.status(502).json({ error: 'Upstream request failed' });
  }
}
