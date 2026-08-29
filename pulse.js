// Power rankings and manager engagement.
//
// Two related questions: who is actually good right now, and who is still
// paying attention. Both are computed from the archive rather than asserted.

import { accumulateAllPlay } from './efficiency.js';

// --- power rankings --------------------------------------------------------

export const DEFAULT_WEIGHTS = {
  allPlay: 0.4,      // least luck-contaminated measure of quality
  recent: 0.25,      // who is good *now*, not in September
  roster: 0.25,      // dynasty value still on the roster
  efficiency: 0.1    // managing the roster well is worth something, but little
};

/**
 * Record is a poor power ranking: it folds in schedule luck. All-play strips
 * that out by scoring every team against every other team each week, which is
 * why it carries the most weight here.
 *
 * Every component arrives as a 0-100 score. Missing components are dropped and
 * the remaining weights renormalised, so a league with no market data still
 * gets sensible rankings instead of everyone scoring zero on roster strength.
 */
export function powerScore(components = {}, weights = DEFAULT_WEIGHTS) {
  let total = 0;
  let used = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const value = components[key];
    if (value == null || !Number.isFinite(Number(value))) continue;
    total += Number(value) * weight;
    used += weight;
  }
  return used > 0 ? total / used : null;
}

const winPctFrom = row => {
  if (!row) return null;
  const games = row.wins + row.losses + row.ties;
  return games ? (row.wins + row.ties / 2) / games : null;
};

/**
 * Rank the league using only weeks up to a point in time.
 *
 * `weekScores` is chronological: [[{ ownerId, points }, ...], ...].
 * Slicing it is what makes week-over-week movement possible without storing
 * any snapshots: last week's ranking is just this function with one fewer week.
 */
export function powerSnapshot(weekScores = [], {
  rosterStrength = new Map(),
  efficiency = new Map(),
  recentWindow = 3,
  weights = DEFAULT_WEIGHTS
} = {}) {
  if (!weekScores.length) return [];
  const all = accumulateAllPlay(weekScores);
  const recent = accumulateAllPlay(weekScores.slice(-recentWindow));

  const owners = [...all.keys()];
  const strengths = owners.map(id => Number(rosterStrength.get(id))).filter(Number.isFinite);
  const maxStrength = strengths.length ? Math.max(...strengths) : 0;
  const minStrength = strengths.length ? Math.min(...strengths) : 0;

  const rows = owners.map(ownerId => {
    const allPct = winPctFrom(all.get(ownerId));
    const recentPct = winPctFrom(recent.get(ownerId));
    const strengthRaw = Number(rosterStrength.get(ownerId));
    const strength = Number.isFinite(strengthRaw) && maxStrength > minStrength
      ? ((strengthRaw - minStrength) / (maxStrength - minStrength)) * 100
      : null;
    const eff = Number(efficiency.get(ownerId));

    const components = {
      allPlay: allPct == null ? null : allPct * 100,
      recent: recentPct == null ? null : recentPct * 100,
      roster: strength,
      efficiency: Number.isFinite(eff) ? eff * 100 : null
    };
    return {
      ownerId,
      score: powerScore(components, weights),
      components,
      allPlay: all.get(ownerId),
      recentAllPlay: recent.get(ownerId),
      rosterValue: Number.isFinite(strengthRaw) ? strengthRaw : null
    };
  });

  return rows
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

/**
 * Current rankings plus movement against the previous week.
 * A team that has not appeared before is marked new rather than credited with
 * an enormous jump from nowhere.
 */
export function powerRankings(weekScores = [], options = {}) {
  const current = powerSnapshot(weekScores, options);
  if (weekScores.length < 2) return current.map(row => ({ ...row, movement: null, previousRank: null }));

  const previous = powerSnapshot(weekScores.slice(0, -1), options);
  const previousRank = new Map(previous.map(row => [row.ownerId, row.rank]));
  return current.map(row => {
    const before = previousRank.get(row.ownerId) ?? null;
    return { ...row, previousRank: before, movement: before == null ? null : before - row.rank };
  });
}

// --- manager engagement ----------------------------------------------------

/**
 * Engagement signals, deliberately evidence-based.
 *
 * This describes what the data shows, not what a manager intends. Someone with
 * a strong roster who makes no moves is not disengaged, they are set. So a
 * manager is only surfaced as a concern when several independent signals agree,
 * and the reasons are always shown alongside the conclusion so it can be
 * argued with.
 */
export function managerActivity(teamWeeks = [], {
  lastTransactionWeek = new Map(),
  currentWeek = null,
  recentWindow = 4
} = {}) {
  const managers = new Map();

  for (const week of teamWeeks) {
    if (!week?.ownerId) continue;
    const acc = managers.get(week.ownerId) || {
      ownerId: week.ownerId,
      manager: week.manager || week.ownerId,
      weeks: 0, emptySlotWeeks: 0, emptySlots: 0, zeroStarterWeeks: 0, zeroStarters: 0,
      efficiencySum: 0, efficiencyWeeks: 0,
      recentEfficiencySum: 0, recentEfficiencyWeeks: 0, recentEmptySlots: 0
    };
    acc.weeks += 1;
    const empty = Number(week.emptySlots) || 0;
    const zero = Number(week.zeroStarters) || 0;
    if (empty > 0) { acc.emptySlotWeeks += 1; acc.emptySlots += empty; }
    if (zero > 0) { acc.zeroStarterWeeks += 1; acc.zeroStarters += zero; }
    if (week.efficiency != null) { acc.efficiencySum += week.efficiency; acc.efficiencyWeeks += 1; }

    const isRecent = currentWeek == null || Number(week.week) > Number(currentWeek) - recentWindow;
    if (isRecent) {
      if (week.efficiency != null) { acc.recentEfficiencySum += week.efficiency; acc.recentEfficiencyWeeks += 1; }
      acc.recentEmptySlots += empty;
    }
    managers.set(week.ownerId, acc);
  }

  const rows = [...managers.values()].map(acc => {
    const efficiency = acc.efficiencyWeeks ? acc.efficiencySum / acc.efficiencyWeeks : null;
    const recentEfficiency = acc.recentEfficiencyWeeks ? acc.recentEfficiencySum / acc.recentEfficiencyWeeks : null;
    const lastMove = lastTransactionWeek.get(acc.ownerId) ?? null;
    const weeksSinceMove = lastMove != null && currentWeek != null ? Number(currentWeek) - Number(lastMove) : null;

    const signals = [];
    if (acc.recentEmptySlots > 0) {
      signals.push({ key: 'empty', severity: 3, text: `${acc.recentEmptySlots} empty lineup slot${acc.recentEmptySlots === 1 ? '' : 's'} in the last ${recentWindow} weeks` });
    }
    if (acc.zeroStarterWeeks >= 2) {
      signals.push({ key: 'zeros', severity: 2, text: `Started a player who scored nothing in ${acc.zeroStarterWeeks} weeks` });
    }
    if (recentEfficiency != null && recentEfficiency < 0.8) {
      signals.push({ key: 'efficiency', severity: 2, text: `Recent lineup efficiency ${(recentEfficiency * 100).toFixed(0)}%` });
    }
    if (weeksSinceMove != null && weeksSinceMove >= 4) {
      signals.push({ key: 'quiet', severity: 1, text: `No add, drop or trade in ${weeksSinceMove} weeks` });
    }

    const severity = signals.reduce((n, s) => n + s.severity, 0);
    // One quiet signal is a style. Several together are a pattern worth raising.
    const concern = severity >= 4 || signals.some(s => s.key === 'empty');

    return {
      ...acc,
      efficiency,
      recentEfficiency,
      lastTransactionWeek: lastMove,
      weeksSinceMove,
      signals,
      severity,
      concern
    };
  });

  return rows.sort((a, b) => b.severity - a.severity || (a.recentEfficiency ?? 1) - (b.recentEfficiency ?? 1));
}

/** Count lineup slots left unfilled. Sleeper writes an empty slot as "0". */
export function countEmptySlots(starters = []) {
  return starters.filter(id => !id || String(id) === '0').length;
}

/** Starters who scored nothing: the clearest sign a lineup was never touched. */
export function countZeroStarters(starters = [], pointsById = {}) {
  return starters.filter(id => {
    if (!id || String(id) === '0') return false;
    const points = Number(pointsById[String(id)]);
    return Number.isFinite(points) && points === 0;
  }).length;
}
