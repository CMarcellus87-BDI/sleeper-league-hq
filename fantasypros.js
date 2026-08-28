// FantasyPros expert consensus rankings.
//
// Two jobs here, both pure:
//   1. Match FantasyPros players onto Sleeper IDs, which has to be done by name
//      because the two services use different ID spaces.
//   2. Compare expert consensus against crowd market value to surface the
//      disagreements, which is where the actual edge is.
//
// The network call itself lives in app.js and goes through a proxy, because the
// FantasyPros API key must never reach the browser.

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/**
 * Normalise a player name for cross-service matching: case, punctuation,
 * generational suffixes and the many spellings of a team defense.
 */
export function normalizeName(name = '') {
  const raw = String(name).toLowerCase().trim();
  if (!raw) return '';
  const cleaned = raw
    .replace(/\bd\/?st\b|\bdefense\b|\bdst\b/g, '')
    .replace(/[.'’`]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = cleaned.split(' ').filter(p => p && !SUFFIXES.has(p));
  return parts.join(' ');
}

/** Matching key: name plus position, so two players sharing a name still separate. */
export function matchKey(name, position) {
  const pos = String(position || '').toUpperCase().replace('DEF', 'DST');
  return `${normalizeName(name)}|${pos}`;
}

/**
 * Build a lookup from a Sleeper-style player map.
 * Keys that collide (same normalised name and position) are dropped rather than
 * guessed at, because a wrong match is worse than a missing one.
 */
export function buildNameIndex(playerMap = {}) {
  const index = new Map();
  const collisions = new Set();
  for (const [id, card] of Object.entries(playerMap)) {
    if (!card) continue;
    const name = card.full_name || [card.first_name, card.last_name].filter(Boolean).join(' ');
    if (!name || !card.position) continue;
    const key = matchKey(name, card.position);
    if (index.has(key)) { collisions.add(key); continue; }
    index.set(key, String(id));
  }
  for (const key of collisions) index.delete(key);
  return index;
}

/**
 * Match FantasyPros rows onto Sleeper IDs. Falls back to a name-only match when
 * the position differs (FantasyPros and Sleeper disagree on some hybrid roles)
 * but only when that name is unique across the whole map.
 */
/**
 * FantasyPros uses different field names on different endpoints: the rankings
 * endpoint returns `player_name` / `player_position_id`, the projections
 * endpoint returns `name` / `position_id`. Normalise both here so callers never
 * have to care which one they are holding.
 */
export function normalizeRow(row = {}) {
  return {
    name: row.player_name || row.name || '',
    position: String(row.player_position_id || row.position_id || row.position || '').toUpperCase(),
    team: row.player_team_id || row.team_id || row.team || '',
    id: row.player_id ?? row.fpid ?? null
  };
}

export function matchRankings(rows = [], nameIndex = new Map()) {
  const nameOnly = new Map();
  const nameOnlyCollisions = new Set();
  for (const [key, id] of nameIndex) {
    const name = key.split('|')[0];
    if (nameOnly.has(name)) { nameOnlyCollisions.add(name); continue; }
    nameOnly.set(name, id);
  }
  for (const name of nameOnlyCollisions) nameOnly.delete(name);

  const matched = new Map();
  const unmatched = [];
  for (const row of rows) {
    const { name, position, team } = normalizeRow(row);
    if (!name) continue;
    const exact = nameIndex.get(matchKey(name, position));
    const id = exact || nameOnly.get(normalizeName(name));
    if (!id) { unmatched.push(name); continue; }
    matched.set(id, {
      sleeperId: id,
      name,
      position,
      team,
      ecr: Number(row.rank_ecr ?? row.ecr ?? row.rank) || null,
      positionRank: parsePositionRank(row.pos_rank ?? row.position_rank),
      tier: Number(row.tier) || null,
      stdDev: Number(row.rank_std ?? row.std_dev) || null
    });
  }
  return { matched, unmatched };
}

/** "RB7" or "7" both become 7. */
export function parsePositionRank(value) {
  if (value == null) return null;
  const match = String(value).match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Rank players within a position by market value, so expert rank and market
 * rank are on the same scale and can be compared directly.
 */
export function marketPositionRanks(players = []) {
  const byPosition = new Map();
  for (const p of players) {
    if (!p?.position || !(Number(p.value) > 0)) continue;
    if (!byPosition.has(p.position)) byPosition.set(p.position, []);
    byPosition.get(p.position).push(p);
  }
  const ranks = new Map();
  for (const [, group] of byPosition) {
    group.sort((a, b) => Number(b.value) - Number(a.value));
    group.forEach((p, i) => ranks.set(String(p.id), i + 1));
  }
  return ranks;
}

/**
 * Where the crowd and the experts disagree.
 *
 * A positive delta means the experts rank a player better than the market does,
 * which reads as buy-low. Negative reads as sell-high. Only players ranked by
 * both sources are compared, and thin positional pools are skipped because a
 * rank gap means nothing when only four players are ranked.
 */
export function arbitrage({ ecr = new Map(), marketRanks = new Map(), minPool = 8, minDelta = 5 } = {}) {
  const poolSize = new Map();
  for (const [id, row] of ecr) {
    if (!marketRanks.has(id) || !row.positionRank) continue;
    poolSize.set(row.position, (poolSize.get(row.position) || 0) + 1);
  }
  const rows = [];
  for (const [id, row] of ecr) {
    const marketRank = marketRanks.get(id);
    if (!marketRank || !row.positionRank) continue;
    if ((poolSize.get(row.position) || 0) < minPool) continue;
    const delta = marketRank - row.positionRank;
    if (Math.abs(delta) < minDelta) continue;
    rows.push({
      ...row,
      marketRank,
      delta,
      signal: delta > 0 ? 'buy' : 'sell',
      confidence: row.stdDev != null && row.stdDev > 0 ? Math.min(1, 12 / row.stdDev) : null
    });
  }
  return rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/**
 * Describe how much of the ranking universe we actually received.
 *
 * The free FantasyPros tier returns 10 players per request out of a few hundred
 * ranked. That is fine for tier badges and for disagreement at the top of each
 * position, but it is not a full board, and the UI should say so rather than
 * imply the arbitrage list is exhaustive.
 */
export function coverageSummary(payload = {}) {
  const coverage = payload.coverage || {};
  const positions = Object.keys(coverage);
  let returned = 0;
  let total = 0;
  for (const pos of positions) {
    returned += Number(coverage[pos]?.returned) || 0;
    total += Number(coverage[pos]?.total) || 0;
  }
  if (!positions.length) {
    returned = (payload.players || []).length;
    total = Number(payload.count) || returned;
  }
  // The premium tier still returns public_api_limited: true while serving the
  // full board, so the flag alone cannot be trusted. Treat a response as
  // limited only when it actually came back short of what it says exists.
  const short = total > 0 && returned > 0 && returned < total * 0.5;
  return {
    limited: payload.public_api_limited === true && short,
    tier: payload.tier || null,
    positions,
    returned,
    total,
    share: total > 0 ? returned / total : null,
    perPosition: coverage
  };
}

/**
 * Thresholds have to scale with how deep the board is. A five-spot gap means
 * something across 140 ranked backs and nothing across ten.
 */
export function arbitrageThresholds(coverage = {}) {
  if (coverage.limited) return { minPool: 5, minDelta: 3 };
  return { minPool: 8, minDelta: 5 };
}

// --- projections -----------------------------------------------------------

/**
 * FantasyPros has used several field names for projected points across API
 * versions and endpoints, so rather than hard-coding one, try the known
 * candidates and report which one hit. `sourceField` is exposed so the UI can
 * say plainly when no recognised field was found instead of silently
 * projecting every player at zero.
 */
/**
 * The projections endpoint nests everything under `stats` and carries all three
 * scoring variants side by side. It also echoes back `scoring: "STD"` no matter
 * what was requested, so the scoring choice has to be made here by picking the
 * right sub-field rather than trusting the query parameter.
 */
export function projectionPointsField(scoring = 'PPR') {
  const key = String(scoring).toUpperCase();
  if (key === 'PPR') return 'points_ppr';
  if (key === 'HALF') return 'points_half';
  return 'points';
}

export function extractProjectedPoints(row = {}, scoring = 'PPR') {
  const stats = row?.stats || row;
  const preferred = projectionPointsField(scoring);
  // Preferred variant first, then the other variants, then legacy flat fields.
  const candidates = [preferred, 'points_ppr', 'points_half', 'points', 'fpts', 'projected_points'];
  for (const field of candidates) {
    const value = Number(stats?.[field]);
    if (Number.isFinite(value)) {
      return { points: value, sourceField: stats === row ? field : `stats.${field}`, exact: field === preferred };
    }
  }
  return { points: null, sourceField: null, exact: false };
}

/** Match a projections payload onto Sleeper ids using the same name index as ECR. */
export function matchProjections(rows = [], nameIndex = new Map(), scoring = 'PPR') {
  const { matched } = matchRankings(rows, nameIndex);
  const bySleeperId = new Map();
  for (const [id, row] of matched) bySleeperId.set(`${normalizeName(row.name)}|${row.position}`, id);

  const projections = new Map();
  const fields = new Set();
  let missing = 0;
  let inexactScoring = 0;

  for (const row of rows) {
    const { name, position, team } = normalizeRow(row);
    if (!name) continue;
    const id = bySleeperId.get(`${normalizeName(name)}|${position}`);
    if (!id) continue;
    const { points, sourceField, exact } = extractProjectedPoints(row, scoring);
    if (points == null) { missing += 1; continue; }
    if (sourceField) fields.add(sourceField);
    if (!exact) inexactScoring += 1;
    projections.set(id, {
      sleeperId: id,
      name,
      position,
      team,
      points,
      injury: row.player_injury_status || row.injury_status || null
    });
  }
  return { projections, fields: [...fields], missing, inexactScoring, matchedCount: matched.size };
}

/**
 * Compare a set lineup against the best projected one.
 * Returns the swaps worth making, largest gain first.
 */
export function startSitAdvice({ optimalIds = new Set(), startedIds = [], byId = new Map() } = {}) {
  const started = new Set((startedIds || []).map(String));
  const benchStars = [...optimalIds].filter(id => !started.has(String(id)));
  const sitting = [...started].filter(id => !optimalIds.has(String(id)));
  const gain = id => Number(byId.get(String(id))?.points) || 0;
  return {
    start: benchStars.map(id => byId.get(String(id))).filter(Boolean).sort((a, b) => b.points - a.points),
    sit: sitting.map(id => byId.get(String(id))).filter(Boolean).sort((a, b) => a.points - b.points),
    delta: benchStars.reduce((n, id) => n + gain(id), 0) - sitting.reduce((n, id) => n + gain(id), 0)
  };
}
