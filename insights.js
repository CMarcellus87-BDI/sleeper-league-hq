// Waiver returns, draft retrospectives and the composite manager report card.
//
// All of these take rows the app has already assembled from the archive and
// reduce them to rankings. Pure and testable.

/**
 * Waiver and FAAB returns.
 *
 * Rows carry what was spent and what the player produced afterwards, so the
 * headline metric is points per dollar. Free claims are counted separately
 * because dividing by zero dollars is not a return, it is a different question.
 */
export function waiverLeaderboard(rows = []) {
  const managers = new Map();
  for (const row of rows) {
    if (!row?.ownerId) continue;
    const acc = managers.get(row.ownerId) || {
      ownerId: row.ownerId,
      manager: row.manager || row.ownerId,
      claims: 0, spend: 0, points: 0, paidClaims: 0, paidPoints: 0, freeClaims: 0,
      best: null, worst: null
    };
    const bid = Number(row.bid) || 0;
    const points = Number(row.points) || 0;
    acc.claims += 1;
    acc.spend += bid;
    acc.points += points;
    if (bid > 0) { acc.paidClaims += 1; acc.paidPoints += points; }
    else acc.freeClaims += 1;

    if (!acc.best || points > acc.best.points) acc.best = row;
    // The worst claim is the one that cost real money and produced least.
    if (bid > 0 && (!acc.worst || points - bid * 2 < acc.worst.points - (Number(acc.worst.bid) || 0) * 2)) acc.worst = row;
    managers.set(row.ownerId, acc);
  }
  return [...managers.values()]
    .map(acc => ({
      ...acc,
      pointsPerDollar: acc.spend > 0 ? acc.paidPoints / acc.spend : null,
      pointsPerClaim: acc.claims ? acc.points / acc.claims : 0
    }))
    .sort((a, b) => (b.pointsPerDollar ?? -1) - (a.pointsPerDollar ?? -1));
}

/** Biggest individual hits and misses across the league. */
export function waiverExtremes(rows = [], limit = 5) {
  const paid = rows.filter(r => (Number(r.bid) || 0) > 0);
  const byValue = [...rows].sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0));
  const byWaste = [...paid].sort((a, b) => (Number(b.bid) || 0) - (Number(a.bid) || 0));
  return {
    hits: byValue.slice(0, limit),
    busts: byWaste.filter(r => (Number(r.points) || 0) < 20).slice(0, limit)
  };
}

/**
 * What an average pick at each draft slot has produced historically.
 *
 * Grading a pick against the league's own history is fairer than grading it
 * against the field: it accounts for how this league scores and how deep it is.
 * Slots are bucketed by round so that early samples are not one pick wide.
 */
export function draftSlotBaselines(picks = []) {
  const buckets = new Map();
  for (const pick of picks) {
    const round = Number(pick?.round);
    if (!Number.isFinite(round)) continue;
    const points = Number(pick.points) || 0;
    const bucket = buckets.get(round) || { round, total: 0, count: 0 };
    bucket.total += points;
    bucket.count += 1;
    buckets.set(round, bucket);
  }
  const baselines = new Map();
  for (const [round, bucket] of buckets) {
    baselines.set(round, bucket.count ? bucket.total / bucket.count : 0);
  }
  return baselines;
}

/** Score each pick against what its round usually returns. */
export function gradeDraftPicks(picks = [], baselines = new Map()) {
  return picks
    .map(pick => {
      const baseline = Number(baselines.get(Number(pick.round))) || 0;
      const points = Number(pick.points) || 0;
      return { ...pick, baseline, delta: points - baseline };
    })
    .sort((a, b) => b.delta - a.delta);
}

/** Aggregate draft performance per manager. */
export function draftLeaderboard(gradedPicks = []) {
  const managers = new Map();
  for (const pick of gradedPicks) {
    if (!pick?.ownerId) continue;
    const acc = managers.get(pick.ownerId) || {
      ownerId: pick.ownerId, manager: pick.manager || pick.ownerId,
      picks: 0, points: 0, delta: 0, best: null, worst: null
    };
    acc.picks += 1;
    acc.points += Number(pick.points) || 0;
    acc.delta += Number(pick.delta) || 0;
    if (!acc.best || pick.delta > acc.best.delta) acc.best = pick;
    if (!acc.worst || pick.delta < acc.worst.delta) acc.worst = pick;
    managers.set(pick.ownerId, acc);
  }
  return [...managers.values()]
    .map(acc => ({ ...acc, deltaPerPick: acc.picks ? acc.delta / acc.picks : 0 }))
    .sort((a, b) => b.deltaPerPick - a.deltaPerPick);
}

/**
 * Convert raw values to a 0-100 score within the league.
 * `higherIsBetter: false` inverts, so a metric like points left on the bench
 * scores well when it is low.
 */
export function normalizeScores(values = [], higherIsBetter = true) {
  // Number(null) is 0, which is finite, so nulls must be rejected before the
  // conversion or a missing metric scores as the worst possible value.
  const nums = values.map(v => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });
  const present = nums.filter(v => v != null);
  if (!present.length) return nums.map(() => 50);
  const min = Math.min(...present);
  const max = Math.max(...present);
  if (max === min) return nums.map(v => (v == null ? 50 : 50));
  return nums.map(v => {
    if (v == null) return 50;
    const scaled = ((v - min) / (max - min)) * 100;
    return higherIsBetter ? scaled : 100 - scaled;
  });
}

/**
 * Composite manager grade.
 *
 * `categories` is [{ key, label, values: Map<ownerId, number>, weight, higherIsBetter }].
 * Every category is normalised within the league before weighting, so a metric
 * measured in fantasy points and one measured in percent can sit side by side.
 * Managers missing a category score 50 in it rather than being penalised.
 */
export function reportCard(ownerIds = [], categories = []) {
  const perCategory = new Map();
  for (const category of categories) {
    const raw = ownerIds.map(id => category.values?.get?.(id) ?? null);
    const scores = normalizeScores(raw, category.higherIsBetter !== false);
    perCategory.set(category.key, { category, raw, scores });
  }

  const rows = ownerIds.map((ownerId, index) => {
    const breakdown = [];
    let weighted = 0;
    let weightSum = 0;
    for (const [key, entry] of perCategory) {
      const weight = Number(entry.category.weight) || 1;
      const score = entry.scores[index];
      breakdown.push({
        key,
        label: entry.category.label || key,
        raw: entry.raw[index],
        score,
        weight,
        missing: entry.raw[index] == null
      });
      weighted += score * weight;
      weightSum += weight;
    }
    return {
      ownerId,
      overall: weightSum ? weighted / weightSum : 50,
      breakdown
    };
  });

  return rows.sort((a, b) => b.overall - a.overall);
}

/**
 * Collapse a player's week-by-week ownership into continuous stints.
 * This is what turns the weekly index into a readable career timeline on a
 * player page: who had him, when, and what he produced for them.
 */
export function summarizeStints(games = []) {
  const ordered = [...games].sort((a, b) => a.seasonNum - b.seasonNum || a.week - b.week);
  const stints = [];
  let current = null;
  for (const game of ordered) {
    if (!current || current.ownerId !== game.ownerId) {
      current = {
        ownerId: game.ownerId,
        manager: game.manager || game.ownerId,
        from: { season: game.season ?? game.seasonNum, week: game.week },
        to: { season: game.season ?? game.seasonNum, week: game.week },
        weeks: 0, started: 0, points: 0, startedPoints: 0
      };
      stints.push(current);
    }
    current.to = { season: game.season ?? game.seasonNum, week: game.week };
    current.weeks += 1;
    current.points += Number(game.points) || 0;
    if (game.started) {
      current.started += 1;
      current.startedPoints += Number(game.points) || 0;
    }
  }
  return stints;
}
