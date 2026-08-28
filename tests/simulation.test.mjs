import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRng,
  normalSample,
  scoringProfile,
  leagueScoringProfile,
  sortStandings,
  simulateBracket,
  simulatePlayoffOdds
} from '../simulation.js';

test('the rng is deterministic for a given seed', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  assert.equal(a(), b());
  assert.notEqual(makeRng(1)(), makeRng(2)());
});

test('normal samples centre on the mean and never go negative', () => {
  const rng = makeRng(7);
  const draws = Array.from({ length: 4000 }, () => normalSample(rng, 110, 20));
  const mean = draws.reduce((n, v) => n + v, 0) / draws.length;
  assert.ok(Math.abs(mean - 110) < 3, `expected near 110, got ${mean.toFixed(1)}`);
  assert.ok(draws.every(v => v >= 0));
});

test('a thin sample is shrunk toward the league average', () => {
  const league = { mean: 100, sd: 20 };
  const hot = scoringProfile([150, 150], league);
  const settled = scoringProfile(new Array(8).fill(150), league);
  assert.ok(hot.mean < settled.mean, 'two hot weeks should not be taken at face value');
  assert.ok(hot.mean > 100, 'but they should still move the estimate');
  assert.equal(settled.weight, 1);
});

test('no games at all falls back entirely to the league profile', () => {
  const profile = scoringProfile([], { mean: 100, sd: 18 });
  assert.equal(profile.mean, 100);
  assert.equal(profile.sd, 18);
  assert.equal(profile.games, 0);
});

test('league profile summarises every score', () => {
  const profile = leagueScoringProfile([90, 100, 110]);
  assert.equal(profile.mean, 100);
  assert.ok(profile.sd > 0);
});

test('standings break ties on points for', () => {
  const sorted = sortStandings([
    { ownerId: 'a', wins: 5, pointsFor: 900 },
    { ownerId: 'b', wins: 5, pointsFor: 1000 },
    { ownerId: 'c', wins: 6, pointsFor: 800 }
  ]);
  assert.deepEqual(sorted.map(r => r.ownerId), ['c', 'b', 'a']);
});

test('a bracket with byes advances the rested seeds directly', () => {
  const seeds = [1, 2, 3, 4, 5, 6].map(seed => ({ ownerId: `t${seed}`, seed }));
  // Higher seed always wins: the sample is just the inverse of the seed.
  const champion = simulateBracket(seeds, entry => 100 - entry.seed, 2);
  assert.equal(champion.ownerId, 't1');
});

test('the bottom seed can win when it always outscores', () => {
  const seeds = [1, 2, 3, 4].map(seed => ({ ownerId: `t${seed}`, seed }));
  const champion = simulateBracket(seeds, entry => (entry.seed === 4 ? 500 : 100), 0);
  assert.equal(champion.ownerId, 't4');
});

// A genuinely undecided race. With a wide record gap the top seeds clinch and
// every probability pins to 1, which tests nothing.
const teams = [
  { ownerId: 'strong', wins: 4, losses: 2, pointsFor: 780, mean: 125, sd: 18 },
  { ownerId: 'good', wins: 3, losses: 3, pointsFor: 730, mean: 115, sd: 18 },
  { ownerId: 'weak', wins: 3, losses: 3, pointsFor: 690, mean: 105, sd: 18 },
  { ownerId: 'worst', wins: 2, losses: 4, pointsFor: 640, mean: 95, sd: 18 }
];
const schedule = [
  { week: 7, a: 'strong', b: 'good' },
  { week: 7, a: 'weak', b: 'worst' },
  { week: 8, a: 'strong', b: 'weak' },
  { week: 8, a: 'good', b: 'worst' },
  { week: 9, a: 'strong', b: 'worst' },
  { week: 9, a: 'good', b: 'weak' },
  { week: 10, a: 'strong', b: 'good' },
  { week: 10, a: 'weak', b: 'worst' }
];

test('odds order matches team strength', () => {
  const odds = simulatePlayoffOdds({ teams, schedule, iterations: 2000, playoffTeams: 2, byes: 0, rng: makeRng(5) });
  assert.ok(odds.get('strong').playoffPct > odds.get('good').playoffPct);
  assert.ok(odds.get('good').playoffPct > odds.get('weak').playoffPct);
  assert.ok(odds.get('weak').playoffPct > odds.get('worst').playoffPct);
  assert.ok(odds.get('strong').playoffPct < 1, 'nothing is clinched in this scenario');
});

test('probabilities across the field sum to the number of playoff spots', () => {
  const odds = simulatePlayoffOdds({ teams, schedule, iterations: 2000, playoffTeams: 2, byes: 0, rng: makeRng(9) });
  const total = [...odds.values()].reduce((n, row) => n + row.playoffPct, 0);
  assert.ok(Math.abs(total - 2) < 0.01, `expected 2 spots filled, got ${total.toFixed(3)}`);
});

test('title odds sum to one', () => {
  const odds = simulatePlayoffOdds({ teams, schedule, iterations: 2000, playoffTeams: 4, byes: 0, rng: makeRng(11) });
  const total = [...odds.values()].reduce((n, row) => n + row.titlePct, 0);
  assert.ok(Math.abs(total - 1) < 0.01);
});

test('a clinched team stays at one hundred percent', () => {
  const locked = [
    { ownerId: 'clinched', wins: 10, losses: 0, pointsFor: 1400, mean: 130, sd: 10 },
    { ownerId: 'a', wins: 1, losses: 9, pointsFor: 700, mean: 90, sd: 10 },
    { ownerId: 'b', wins: 1, losses: 9, pointsFor: 690, mean: 90, sd: 10 }
  ];
  const odds = simulatePlayoffOdds({ teams: locked, schedule: [], iterations: 500, playoffTeams: 1, byes: 0, rng: makeRng(3) });
  assert.equal(odds.get('clinched').playoffPct, 1);
});

test('an empty league returns empty odds rather than throwing', () => {
  assert.equal(simulatePlayoffOdds({ teams: [], schedule: [] }).size, 0);
});

test('the same seed reproduces the same odds', () => {
  const a = simulatePlayoffOdds({ teams, schedule, iterations: 500, playoffTeams: 2, rng: makeRng(21) });
  const b = simulatePlayoffOdds({ teams, schedule, iterations: 500, playoffTeams: 2, rng: makeRng(21) });
  assert.equal(a.get('strong').playoffPct, b.get('strong').playoffPct);
});
