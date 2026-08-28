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
    const name = row?.player_name || row?.name;
    const position = row?.player_position_id || row?.position;
    if (!name) continue;
    const exact = nameIndex.get(matchKey(name, position));
    const id = exact || nameOnly.get(normalizeName(name));
    if (!id) { unmatched.push(name); continue; }
    matched.set(id, {
      sleeperId: id,
      name,
      position: String(position || '').toUpperCase(),
      team: row.player_team_id || row.team || '',
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
