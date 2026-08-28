// Pure analytics helpers for Dynasty of Legends.
// No DOM, no network, no module-level state: everything here is testable in Node.

/**
 * Letter grade for a market-value edge percentage.
 * Bands are width-symmetric around B: A+/F, A/D, A-/C and B+/B- are mirror pairs.
 */
export function gradeLetter(edgePct) {
  if (!Number.isFinite(edgePct)) return '—';
  if (edgePct >= 25) return 'A+';
  if (edgePct >= 15) return 'A';
  if (edgePct >= 8) return 'A-';
  if (edgePct >= 3) return 'B+';
  if (edgePct >= -3) return 'B';
  if (edgePct >= -8) return 'B-';
  if (edgePct >= -15) return 'C';
  if (edgePct >= -25) return 'D';
  return 'F';
}

/** Percentage edge of a over b, relative to the average of the two sides. */
export function edgePct(a, b) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  const avg = (x + y) / 2;
  if (!avg) return null;
  return ((x - y) / avg) * 100;
}

/**
 * A week Sleeper has scheduled but not yet scored comes back with every roster
 * on zero. Those rows must never reach the archive: they create phantom 0.00
 * "closest finishes" and count as nail-biters in the rivalry index.
 */
export function isUnplayedWeek(rows) {
  if (!Array.isArray(rows) || !rows.length) return true;
  return rows.every(m => !(Number(m?.points) > 0));
}

/** Rank of target within values, highest first. 1-based. */
export function rankAmong(values, target) {
  const sorted = [...values].sort((a, b) => b - a);
  const idx = sorted.findIndex(v => v <= target);
  return idx < 0 ? sorted.length : idx + 1;
}

/**
 * Index playerGames by player id so realized-points lookups are O(games for
 * that player) instead of a full scan of the archive per trade side.
 */
export function buildPlayerIndex(playerGames = []) {
  const index = new Map();
  for (const game of playerGames) {
    const key = String(game.playerId);
    let bucket = index.get(key);
    if (!bucket) { bucket = []; index.set(key, bucket); }
    bucket.push(game);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => a.seasonNum - b.seasonNum || a.week - b.week);
  }
  return index;
}

/** True when a game happened at or after (season, week). Null week means "any week that season". */
export function isAtOrAfter(game, season, week) {
  const gs = Number(game?.seasonNum);
  const target = Number(season);
  if (!Number.isFinite(gs) || !Number.isFinite(target)) return false;
  if (gs > target) return true;
  if (gs < target) return false;
  if (week == null) return true;
  return Number(game.week) >= Number(week);
}

const emptyRealized = () => ({ started: 0, rostered: 0, startedWeeks: 0, rosteredWeeks: 0 });

/** True when a game happened strictly before (season, week). */
export function isBefore(game, season, week) {
  const gs = Number(game?.seasonNum);
  const target = Number(season);
  if (!Number.isFinite(gs) || !Number.isFinite(target)) return false;
  if (gs < target) return true;
  if (gs > target) return false;
  if (week == null) return false;
  return Number(game.week) < Number(week);
}

/**
 * Points a player produced for one manager inside a window.
 *
 * `until` is exclusive and may be null for "through today". Bounding the top
 * end matters for chain following: without it, a player who is traded away and
 * later reacquired would have the second stint counted twice, once against the
 * original acquisition and once again through the chain.
 */
export function realizedForPlayerWindow(index, playerId, ownerId, from, until = null) {
  const out = emptyRealized();
  const games = index?.get(String(playerId)) || [];
  for (const game of games) {
    if (game.ownerId !== ownerId) continue;
    if (!isAtOrAfter(game, from?.season, from?.week)) continue;
    if (until && !isBefore(game, until.season, until.week)) continue;
    const points = Number(game.points) || 0;
    out.rostered += points;
    out.rosteredWeeks += 1;
    if (game.started) {
      out.started += points;
      out.startedWeeks += 1;
    }
  }
  return out;
}

/**
 * Points a player produced for one specific manager from a point in time
 * onward. Ownership comes from the weekly matchup snapshot, so a player who is
 * later traded away simply stops accruing here.
 */
export function realizedForPlayer(index, playerId, ownerId, season, week) {
  return realizedForPlayerWindow(index, playerId, ownerId, { season, week }, null);
}

/**
 * When an asset is flipped as part of a package, the return has to be split
 * across everything that went out. Share is by value where values exist, and an
 * even split otherwise, which is the honest fallback for eras where no market
 * data is available.
 */
export function attributionShare(outgoing = [], targetId) {
  if (!outgoing.length) return 1;
  const total = outgoing.reduce((n, a) => n + (Number(a?.value) || 0), 0);
  const mine = outgoing.find(a => String(a?.id) === String(targetId));
  if (!mine || total <= 0) return 1 / outgoing.length;
  const value = Number(mine.value) || 0;
  if (value <= 0) return 1 / outgoing.length;
  return value / total;
}

/** Same, aggregated over every player one side received. */
export function realizedForSide(index, playerIds = [], ownerId, season, week) {
  const out = { ...emptyRealized(), counted: 0 };
  for (const id of playerIds) {
    const row = realizedForPlayer(index, id, ownerId, season, week);
    out.started += row.started;
    out.rostered += row.rostered;
    out.startedWeeks += row.startedWeeks;
    out.rosteredWeeks += row.rosteredWeeks;
    if (row.rosteredWeeks) out.counted += 1;
  }
  return out;
}

/**
 * Share of a trade that has actually turned into something countable.
 * A 2025 deal built on 2027 picks is barely settled, and saying so is more
 * honest than printing a confident letter.
 */
export function realizedSettledShare(assets = []) {
  const gradeable = assets.filter(a => a?.kind !== 'faab');
  if (!gradeable.length) return null;
  const settled = gradeable.filter(a => a.kind === 'player' || a.kind === 'resolvedPick').length;
  return settled / gradeable.length;
}

// --- chain following -------------------------------------------------------

export const LINEAGE_DEFAULTS = { maxDepth: 6, minWeight: 0.03 };

/**
 * Walk one received asset forward through every subsequent trade by the same
 * manager, splitting credit whenever the asset leaves as part of a package.
 *
 * All league-specific lookups arrive through `ctx` so this stays pure:
 *   playerIndex                              index from buildPlayerIndex
 *   describe(playerId)        -> {name,meta}
 *   nextFlip(playerId, ownerId, afterCreated) -> trade | null
 *   rosterFor(trade, ownerId) -> rosterId | null
 *   outgoing(trade, rosterId) -> [{id, value, label}]
 *   received(trade, rosterId) -> [playerId]
 *   chrono(trade)             -> {season, week}
 *   createdOf/idOf/seasonOf/dateOf(trade)
 *
 * Returns { node, total, hops }, where `total` is already weight-adjusted.
 */
export function traceAssetForward(ctx, playerId, ownerId, from, createdAt, weight = 1, depth = 0, seen = new Set(), limits = LINEAGE_DEFAULTS) {
  const info = ctx.describe(playerId) || {};
  const node = {
    playerId: String(playerId),
    name: info.name || `Player ${playerId}`,
    meta: info.meta || '',
    weight,
    held: 0,
    startedWeeks: 0,
    flip: null,
    children: []
  };

  const canRecurse = depth < limits.maxDepth && weight >= limits.minWeight;
  const flipTrade = canRecurse ? ctx.nextFlip(playerId, ownerId, createdAt) : null;

  // The stint is bounded by the flip, so a player who is traded away and later
  // reacquired is not counted twice against the same acquisition.
  const stint = realizedForPlayerWindow(ctx.playerIndex, playerId, ownerId, from, flipTrade ? ctx.chrono(flipTrade) : null);
  node.held = stint.started;
  node.startedWeeks = stint.startedWeeks;
  let total = stint.started * weight;

  if (!flipTrade) return { node, total, hops: 0 };

  const key = `${ctx.idOf(flipTrade)}|${playerId}`;
  if (seen.has(key)) return { node, total, hops: 0 };
  seen.add(key);

  const rosterId = ctx.rosterFor(flipTrade, ownerId);
  const outgoing = ctx.outgoing(flipTrade, rosterId) || [];
  const share = attributionShare(outgoing, String(playerId));
  const received = ctx.received(flipTrade, rosterId) || [];

  node.flip = {
    transactionId: ctx.idOf(flipTrade),
    season: ctx.seasonOf(flipTrade),
    date: ctx.dateOf(flipTrade),
    share,
    packaged: outgoing.length > 1,
    returned: received.length
  };

  let hops = 1;
  for (const nextId of received) {
    const child = traceAssetForward(
      ctx, nextId, ownerId, ctx.chrono(flipTrade), ctx.createdOf(flipTrade),
      weight * share, depth + 1, seen, limits
    );
    node.children.push(child.node);
    total += child.total;
    hops += child.hops;
  }
  return { node, total, hops };
}

// --- competitive window ----------------------------------------------------

/**
 * Percentile of target within values, 0-100, where 100 is the top of the
 * league. Percentiles rather than ordinal ranks: the gap between #1 and #2 is
 * often nothing, and in a 12-team league ordinals are mostly noise.
 */
export function percentileRank(values, target) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length <= 1) return 50;
  const below = nums.filter(v => v < target).length;
  const equal = nums.filter(v => v === target).length;
  return ((below + equal / 2) / nums.length) * 100;
}

/** Value-weighted average age, so a roster is judged by where its value sits, not its headcount. */
export function valueWeightedAge(assets = [], fallbackAge = 26) {
  let weight = 0;
  let total = 0;
  for (const a of assets) {
    const value = Number(a?.value) || 0;
    if (value <= 0) continue;
    const age = Number.isFinite(Number(a?.age)) ? Number(a.age) : fallbackAge;
    total += age * value;
    weight += value;
  }
  return weight ? total / weight : fallbackAge;
}

/**
 * Can this roster win now? Roster strength dominates early, then results earn
 * weight as the sample grows. Before roughly six games, W-L is close to noise.
 */
export function strengthScore({ lineupPct = 50, recordPct = 50, pfPct = 50, gamesPlayed = 0 } = {}) {
  const seasonWeight = Math.min(1, Math.max(0, gamesPlayed) / 6) * 0.45;
  const results = recordPct * 0.6 + pfPct * 0.4;
  return lineupPct * (1 - seasonWeight) + results * seasonWeight;
}

/** Are this roster's assets appreciating or depreciating? Higher means more future-leaning. */
export function timelineScore({ youthPct = 50, pickPct = 50 } = {}) {
  return youthPct * 0.65 + pickPct * 0.35;
}

/**
 * Two axes beat one scalar here. "Strong but old" and "strong and young" call
 * for opposite behaviour, and a single contend/rebuild number cannot say that.
 */
export function classifyWindow(strength, timeline) {
  const strong = strength >= 50;
  const future = timeline >= 50;
  if (strong && future) return {
    key: 'contend',
    label: 'Contender',
    blurb: 'Strong roster with assets that are still appreciating. You can win now without mortgaging the future.'
  };
  if (strong && !future) return {
    key: 'push',
    label: 'Window closing',
    blurb: 'Strong roster, but the value is concentrated in older assets. Push while it lasts or the window shuts on its own.'
  };
  if (!strong && future) return {
    key: 'rebuild',
    label: 'Rebuilding',
    blurb: 'Young assets and picks without the lineup to win yet. Keep accumulating and let it mature.'
  };
  return {
    key: 'reset',
    label: 'Hard reset',
    blurb: 'Older assets and a lineup that is not winning. This is the most urgent sell position in the league.'
  };
}

/** What the quadrant implies about which direction to trade. */
export function windowDirective(key) {
  switch (key) {
    case 'contend':
      return { acquire: 'production', preferPicks: false, preferYouth: false, sellAgeFloor: null, buyAgeCeiling: 30, urgency: 'medium' };
    case 'push':
      return { acquire: 'production', preferPicks: false, preferYouth: false, sellAgeFloor: null, buyAgeCeiling: 32, urgency: 'high' };
    case 'rebuild':
      return { acquire: 'youth', preferPicks: true, preferYouth: true, sellAgeFloor: 27, buyAgeCeiling: 25, urgency: 'medium' };
    default:
      return { acquire: 'youth', preferPicks: true, preferYouth: true, sellAgeFloor: 26, buyAgeCeiling: 24, urgency: 'high' };
  }
}

/**
 * How well two franchises fit as counterparties. Contenders and rebuilders want
 * opposite things, which is what makes a trade close. Two teams in the same
 * position are competing for the same assets.
 */
export function windowComplement(a, b) {
  if (!a || !b) return 0;
  const timelineGap = Math.abs(a.timeline - b.timeline) / 100;
  const strengthGap = Math.abs(a.strength - b.strength) / 100;
  const opposed = (a.timeline - 50) * (b.timeline - 50) < 0 ? 0.25 : 0;
  return Math.min(1, timelineGap * 0.5 + strengthGap * 0.35 + opposed);
}

// --- value over replacement ------------------------------------------------

/**
 * How many starting slots each position really commands, flex included.
 *
 * Flex slots are allocated by observed usage rather than split evenly: if this
 * league's flex is filled by a WR four times out of five, the flex is four
 * fifths of a WR slot. With no usage data yet (preseason) it falls back to an
 * even split across eligible positions. Counts are fractional on purpose.
 */
export function starterSlotCounts(slots = [], flexUsage = {}) {
  const counts = {};
  for (const slot of slots) {
    if (!Array.isArray(slot) || !slot.length) continue;
    if (slot.length === 1) {
      counts[slot[0]] = (counts[slot[0]] || 0) + 1;
      continue;
    }
    const weights = slot.map(pos => Number(flexUsage[pos]) || 0);
    const total = weights.reduce((n, w) => n + w, 0);
    slot.forEach((pos, i) => {
      const share = total > 0 ? weights[i] / total : 1 / slot.length;
      counts[pos] = (counts[pos] || 0) + share;
    });
  }
  return counts;
}

/**
 * Replacement level per position, derived from this league's own rosters
 * rather than an external baseline: the value of the best player at that
 * position who would *not* be starting if every team started its best lineup.
 *
 * `starterCounts` is league-wide (slots per team times number of teams) and may
 * be fractional, so the level is interpolated between the two bracketing
 * players.
 */
export function replacementLevels(pools = {}, starterCounts = {}) {
  const levels = {};
  for (const [pos, values] of Object.entries(pools)) {
    const sorted = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
    const n = Number(starterCounts[pos]) || 0;
    if (!sorted.length || n <= 0) { levels[pos] = 0; continue; }
    const at = i => (i >= 0 && i < sorted.length ? sorted[i] : 0);
    const lo = Math.floor(n);
    const hi = Math.ceil(n);
    levels[pos] = lo === hi ? at(lo) : at(lo) + (at(hi) - at(lo)) * (n - lo);
  }
  return levels;
}

/**
 * Surplus over replacement. Floored at zero: a below-replacement player has no
 * starting-lineup surplus even though he still carries a market price. This is
 * what stops three depth pieces from adding up to a stud.
 */
export function surplusValue(value, replacement) {
  return Math.max(0, (Number(value) || 0) - (Number(replacement) || 0));
}

/**
 * A 3-for-1 means somebody drops two players. That cost is real, and pricing a
 * trade without it makes lopsided-count deals look better than they are.
 * Cuts come off the bottom by surplus, then by market value.
 */
export function rosterCrunchCost(players = [], limit) {
  const max = Number(limit);
  if (!Number.isFinite(max) || max <= 0 || players.length <= max) {
    return { overBy: 0, cuts: [], cost: 0 };
  }
  const overBy = players.length - max;
  const ordered = [...players].sort((a, b) =>
    (Number(a?.surplus) || 0) - (Number(b?.surplus) || 0) ||
    (Number(a?.value) || 0) - (Number(b?.value) || 0)
  );
  const cuts = ordered.slice(0, overBy);
  return { overBy, cuts, cost: cuts.reduce((n, c) => n + (Number(c?.value) || 0), 0) };
}
