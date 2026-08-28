// Playoff odds by Monte Carlo simulation.
//
// The remaining schedule is replayed thousands of times, sampling each team's
// weekly score from its own distribution, then standings and a bracket are
// resolved each run. Pure: the RNG is injected so results are reproducible.

/** Small deterministic PRNG. Seeded so tests and reruns agree. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal sample, floored at zero because a team cannot score negative. */
export function normalSample(rng, mean, sd) {
  const u = Math.max(rng(), 1e-12);
  const v = Math.max(rng(), 1e-12);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(0, mean + z * sd);
}

/**
 * A team's weekly scoring distribution, shrunk toward the league average when
 * the sample is thin. Four games is not enough to know a team's true mean, and
 * an unshrunk estimate makes early-season odds wildly overconfident.
 */
export function scoringProfile(scores = [], league = {}, fullConfidenceGames = 8) {
  const values = scores.map(Number).filter(Number.isFinite);
  const leagueMean = Number(league.mean) || 0;
  const leagueSd = Number(league.sd) || 1;
  if (!values.length) return { mean: leagueMean, sd: leagueSd, games: 0, weight: 0 };

  const mean = values.reduce((n, v) => n + v, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((n, v) => n + (v - mean) ** 2, 0) / (values.length - 1)
    : leagueSd ** 2;
  const sd = Math.sqrt(variance);

  const weight = Math.min(1, values.length / fullConfidenceGames);
  return {
    mean: mean * weight + leagueMean * (1 - weight),
    sd: (Number.isFinite(sd) && sd > 0 ? sd : leagueSd) * weight + leagueSd * (1 - weight),
    games: values.length,
    weight
  };
}

/** League-wide mean and standard deviation, used as the shrinkage target. */
export function leagueScoringProfile(allScores = []) {
  const values = allScores.map(Number).filter(Number.isFinite);
  if (!values.length) return { mean: 0, sd: 1 };
  const mean = values.reduce((n, v) => n + v, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((n, v) => n + (v - mean) ** 2, 0) / (values.length - 1)
    : 1;
  return { mean, sd: Math.sqrt(variance) || 1 };
}

/** Standings sort: wins, then points for. Matches how most Sleeper leagues break ties. */
export function sortStandings(rows) {
  return [...rows].sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);
}

/**
 * Single-elimination bracket with byes for the top seeds.
 * Seeds are re-paired highest against lowest each round, which is how Sleeper
 * reseeds by default.
 */
export function simulateBracket(seeds, sample, byes = 0) {
  let alive = seeds.slice();
  if (byes > 0 && alive.length > byes) {
    const resting = alive.slice(0, byes);
    let playing = alive.slice(byes);
    playing = playRound(playing, sample);
    alive = [...resting, ...playing].sort((a, b) => a.seed - b.seed);
  }
  while (alive.length > 1) alive = playRound(alive, sample);
  return alive[0] || null;
}

function playRound(teams, sample) {
  const ordered = [...teams].sort((a, b) => a.seed - b.seed);
  const winners = [];
  let low = 0;
  let high = ordered.length - 1;
  while (low < high) {
    const a = ordered[low];
    const b = ordered[high];
    winners.push(sample(a) >= sample(b) ? a : b);
    low++;
    high--;
  }
  if (low === high) winners.push(ordered[low]);
  return winners.sort((a, b) => a.seed - b.seed);
}

/**
 * Replay the remaining season many times.
 *
 * `teams`    [{ ownerId, wins, losses, pointsFor, mean, sd }]
 * `schedule` [{ week, a, b }] for weeks not yet played
 * Returns a Map of ownerId to odds and expected finish.
 */
export function simulatePlayoffOdds({
  teams = [],
  schedule = [],
  iterations = 10000,
  playoffTeams = 6,
  byes = 2,
  rng = makeRng(1)
} = {}) {
  const totals = new Map();
  for (const team of teams) {
    totals.set(team.ownerId, {
      ownerId: team.ownerId,
      playoffs: 0, bye: 0, title: 0, finals: 0,
      wins: 0, pointsFor: 0, seedSum: 0,
      firstSeed: 0, missed: 0
    });
  }
  if (!teams.length) return totals;

  const byId = new Map(teams.map(t => [t.ownerId, t]));
  const runs = Math.max(1, iterations);

  for (let i = 0; i < runs; i++) {
    const state = new Map(teams.map(t => [t.ownerId, { wins: t.wins, pointsFor: t.pointsFor }]));

    for (const game of schedule) {
      const a = byId.get(game.a);
      const b = byId.get(game.b);
      if (!a || !b) continue;
      const aScore = normalSample(rng, a.mean, a.sd);
      const bScore = normalSample(rng, b.mean, b.sd);
      const sa = state.get(game.a);
      const sb = state.get(game.b);
      sa.pointsFor += aScore;
      sb.pointsFor += bScore;
      if (aScore > bScore) sa.wins += 1;
      else if (bScore > aScore) sb.wins += 1;
      else { sa.wins += 0.5; sb.wins += 0.5; }
    }

    const standings = sortStandings(
      [...state.entries()].map(([ownerId, s]) => ({ ownerId, wins: s.wins, pointsFor: s.pointsFor }))
    );

    standings.forEach((row, index) => {
      const acc = totals.get(row.ownerId);
      acc.wins += row.wins;
      acc.pointsFor += row.pointsFor;
      acc.seedSum += index + 1;
      if (index === 0) acc.firstSeed += 1;
      if (index < playoffTeams) acc.playoffs += 1; else acc.missed += 1;
      if (index < byes) acc.bye += 1;
    });

    const field = standings.slice(0, playoffTeams).map((row, index) => ({ ...row, seed: index + 1 }));
    const sample = entry => {
      const team = byId.get(entry.ownerId);
      return team ? normalSample(rng, team.mean, team.sd) : 0;
    };
    const champion = simulateBracket(field, sample, byes);
    if (champion) totals.get(champion.ownerId).title += 1;
  }

  for (const acc of totals.values()) {
    acc.iterations = runs;
    acc.playoffPct = acc.playoffs / runs;
    acc.byePct = acc.bye / runs;
    acc.titlePct = acc.title / runs;
    acc.firstSeedPct = acc.firstSeed / runs;
    acc.avgWins = acc.wins / runs;
    acc.avgPointsFor = acc.pointsFor / runs;
    acc.avgSeed = acc.seedSum / runs;
  }
  return totals;
}
