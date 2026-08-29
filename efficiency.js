// Lineup efficiency, all-play and luck.
//
// Everything here runs on the weekly matchup archive the app already downloads:
// each team-week's rostered players, their points, and who was actually
// started. No DOM, no network, no module-level state.

/**
 * Best legal lineup from a set of scored players.
 *
 * Slots are filled most-restrictive first, which is optimal for the nested slot
 * families fantasy leagues actually use (QB ⊂ SUPERFLEX, TE ⊂ REC_FLEX ⊂ FLEX).
 * A swap pass afterwards catches anything a non-nested configuration would have
 * left on the table.
 */
export function optimalLineup(players = [], slots = []) {
  const pool = players.filter(p => p && p.pos && Number.isFinite(Number(p.points)));
  const assigned = new Array(slots.length).fill(null);
  const used = new Set();

  const order = slots
    .map((eligible, index) => ({ eligible, index }))
    .sort((a, b) => a.eligible.length - b.eligible.length);

  for (const slot of order) {
    let best = null;
    for (const p of pool) {
      if (used.has(p.id) || !slot.eligible.includes(p.pos)) continue;
      if (!best || Number(p.points) > Number(best.points)) best = p;
    }
    if (best) { used.add(best.id); assigned[slot.index] = best; }
  }

  let improved = true;
  let guard = 0;
  while (improved && guard++ < 20) {
    improved = false;
    for (let i = 0; i < slots.length; i++) {
      const current = assigned[i];
      const currentPoints = current ? Number(current.points) : -Infinity;
      for (const p of pool) {
        if (used.has(p.id) || !slots[i].includes(p.pos)) continue;
        if (Number(p.points) > currentPoints) {
          if (current) used.delete(current.id);
          used.add(p.id);
          assigned[i] = p;
          improved = true;
          break;
        }
      }
    }
  }

  const chosen = assigned.filter(Boolean);
  return {
    total: chosen.reduce((n, p) => n + Number(p.points), 0),
    chosen,
    chosenIds: new Set(chosen.map(p => String(p.id)))
  };
}

/**
 * Legal start/sit swaps: pairs of players who could actually have traded places.
 *
 * Comparing "best scorer benched" against "worst starter" independently produces
 * nonsense like benching a quarterback for a receiver, because the two never
 * shared a slot. A swap is only offered when some slot in this league admits
 * both players, which is what makes it a move the manager could have made.
 */
export function lineupSwaps(players = [], startedIds = [], slots = []) {
  const byId = new Map(players.map(p => [String(p.id), p]));
  const started = (startedIds || []).map(String).filter(id => id && id !== '0');
  const startedSet = new Set(started);
  const best = optimalLineup(players, slots);

  const missed = players
    .filter(p => !startedSet.has(String(p.id)) && best.chosenIds.has(String(p.id)))
    .sort((a, b) => Number(b.points) - Number(a.points));
  const benched = started
    .map(id => byId.get(id))
    .filter(p => p && !best.chosenIds.has(String(p.id)))
    .sort((a, b) => Number(a.points) - Number(b.points));

  const admits = (slot, player) => player?.pos && slot.includes(player.pos);
  const used = new Set();
  const swaps = [];

  for (const incoming of missed) {
    for (const outgoing of benched) {
      if (used.has(String(outgoing.id))) continue;
      if (Number(incoming.points) <= Number(outgoing.points)) continue;
      // The swap has to be legal: one slot that would take either player.
      const slot = slots.find(s => admits(s, incoming) && admits(s, outgoing));
      if (!slot) continue;
      used.add(String(outgoing.id));
      swaps.push({
        in: incoming,
        out: outgoing,
        slot,
        gain: Number(incoming.points) - Number(outgoing.points)
      });
      break;
    }
  }
  return swaps.sort((a, b) => b.gain - a.gain);
}

/**
 * What one manager actually got versus what was sitting on the roster.
 * `benched` is the single most painful start/sit call: the best scorer left out
 * of the lineup, paired with the starter who should have made way.
 */
export function weekEfficiency({ players = [], startedIds = [], slots = [] } = {}) {
  const started = new Set((startedIds || []).map(String));
  const actual = players
    .filter(p => started.has(String(p.id)))
    .reduce((n, p) => n + (Number(p.points) || 0), 0);

  const best = optimalLineup(players, slots);
  const missed = players
    .filter(p => !started.has(String(p.id)) && best.chosenIds.has(String(p.id)))
    .sort((a, b) => Number(b.points) - Number(a.points));
  const benchedFor = players
    .filter(p => started.has(String(p.id)) && !best.chosenIds.has(String(p.id)))
    .sort((a, b) => Number(a.points) - Number(b.points));

  // If a started player fills a slot the caller did not describe, actual can
  // exceed optimal. That means the slot map is incomplete, not that the manager
  // beat a perfect lineup, so it is flagged rather than silently reported.
  const modeled = best.total + 0.01 >= actual;

  const swaps = lineupSwaps(players, startedIds, slots);

  return {
    actual,
    optimal: best.total,
    modeled,
    swaps,
    topSwap: swaps[0] || null,
    left: Math.max(0, best.total - actual),
    efficiency: best.total > 0 ? Math.min(1, actual / best.total) : null,
    topMiss: missed[0] || null,
    topMissReplaced: benchedFor[0] || null
  };
}

/**
 * All-play: score every team against every other team, every week. This is the
 * cleanest separation of "are you good" from "did you draw the right opponent".
 */
export function allPlayForWeek(scores = []) {
  const rows = new Map();
  for (const entry of scores) {
    let wins = 0, losses = 0, ties = 0;
    for (const other of scores) {
      if (other === entry) continue;
      const a = Number(entry.points) || 0;
      const b = Number(other.points) || 0;
      if (a > b) wins++;
      else if (a < b) losses++;
      else ties++;
    }
    rows.set(entry.ownerId, { ownerId: entry.ownerId, wins, losses, ties });
  }
  return rows;
}

/** Aggregate all-play across many weeks into a single record per owner. */
export function accumulateAllPlay(weeks = []) {
  const totals = new Map();
  for (const week of weeks) {
    for (const [ownerId, row] of allPlayForWeek(week)) {
      const acc = totals.get(ownerId) || { ownerId, wins: 0, losses: 0, ties: 0, weeks: 0 };
      acc.wins += row.wins;
      acc.losses += row.losses;
      acc.ties += row.ties;
      acc.weeks += 1;
      totals.set(ownerId, acc);
    }
  }
  for (const acc of totals.values()) {
    const games = acc.wins + acc.losses + acc.ties;
    acc.winPct = games ? (acc.wins + acc.ties / 2) / games : 0;
    acc.expectedWins = acc.winPct * acc.weeks;
  }
  return totals;
}

/**
 * Luck is actual wins minus the wins an all-play record says you earned.
 * Positive means the schedule was kind.
 */
export function luckIndex(actualWins, expectedWins) {
  return (Number(actualWins) || 0) - (Number(expectedWins) || 0);
}

/**
 * Replay one manager's season against a different manager's schedule.
 * When the borrowed schedule would have them face themselves, they inherit the
 * schedule's owner as the opponent instead.
 */
export function scheduleSwap(weeks = [], ownerId, scheduleOwnerId) {
  let wins = 0, losses = 0, ties = 0;
  for (const week of weeks) {
    const mine = week.scores?.get(ownerId);
    if (mine == null) continue;
    let opponent = week.opponents?.get(scheduleOwnerId);
    if (opponent === ownerId) opponent = scheduleOwnerId;
    if (opponent == null) continue;
    const theirs = week.scores?.get(opponent);
    if (theirs == null) continue;
    if (mine > theirs) wins++;
    else if (mine < theirs) losses++;
    else ties++;
  }
  return { ownerId, scheduleOwnerId, wins, losses, ties };
}

/**
 * Replay a set of matchups as if both managers had started their best lineup.
 * The gap between this and the real record is the coaching record.
 */
export function coachingRecord(games = []) {
  const rows = new Map();
  const touch = id => {
    if (!rows.has(id)) rows.set(id, { ownerId: id, actualWins: 0, actualLosses: 0, optimalWins: 0, optimalLosses: 0, flipped: [] });
    return rows.get(id);
  };
  for (const game of games) {
    const a = touch(game.a);
    const b = touch(game.b);
    if (game.aActual > game.bActual) { a.actualWins++; b.actualLosses++; }
    else if (game.aActual < game.bActual) { a.actualLosses++; b.actualWins++; }

    if (game.aOptimal > game.bOptimal) { a.optimalWins++; b.optimalLosses++; }
    else if (game.aOptimal < game.bOptimal) { a.optimalLosses++; b.optimalWins++; }

    const actualWinner = game.aActual === game.bActual ? null : (game.aActual > game.bActual ? game.a : game.b);
    const optimalWinner = game.aOptimal === game.bOptimal ? null : (game.aOptimal > game.bOptimal ? game.a : game.b);
    if (actualWinner && optimalWinner && actualWinner !== optimalWinner) {
      touch(optimalWinner).flipped.push({ season: game.season, week: game.week, opponent: actualWinner });
    }
  }
  return rows;
}

/**
 * A short label for a season's starting lineup, e.g. "1QB 2RB 2WR 1TE 1FLEX 1K".
 * Bench, IR and taxi slots are excluded because they are not started.
 */
export function slotSignature(rawPositions = []) {
  const counts = new Map();
  for (const slot of rawPositions) {
    if (!slot || ['BN', 'IR', 'TAXI'].includes(slot)) continue;
    counts.set(slot, (counts.get(slot) || 0) + 1);
  }
  return [...counts.entries()].map(([slot, n]) => `${n}${slot}`).join(' ');
}

/**
 * Group seasons by their lineup configuration.
 *
 * Leagues change their starting lineup. Scoring an old season against today's
 * slots is simply wrong: a year that started a kicker and a defense had two
 * more slots contributing points, and comparing its efficiency to a year
 * without them is comparing different tests.
 */
export function summarizeSlotChanges(bySeason = {}) {
  const groups = new Map();
  for (const [season, positions] of Object.entries(bySeason)) {
    const signature = slotSignature(positions);
    const group = groups.get(signature) || { signature, seasons: [] };
    group.seasons.push(String(season));
    groups.set(signature, group);
  }
  const ordered = [...groups.values()].map(group => ({
    ...group,
    seasons: group.seasons.sort((a, b) => Number(a) - Number(b))
  })).sort((a, b) => Number(a.seasons[0]) - Number(b.seasons[0]));

  return { stable: ordered.length <= 1, groups: ordered };
}
