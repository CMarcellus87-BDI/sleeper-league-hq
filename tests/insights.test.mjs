import test from 'node:test';
import assert from 'node:assert/strict';
import {
  waiverLeaderboard,
  waiverExtremes,
  draftSlotBaselines,
  gradeDraftPicks,
  draftLeaderboard,
  normalizeScores,
  reportCard,
  summarizeStints
} from '../insights.js';

const claims = [
  { ownerId: 'alice', manager: 'Alice', name: 'Cheap Gem', bid: 3, points: 180, season: 2025, week: 4 },
  { ownerId: 'alice', manager: 'Alice', name: 'Dud', bid: 40, points: 6, season: 2025, week: 6 },
  { ownerId: 'bob', manager: 'Bob', name: 'Overpay', bid: 90, points: 120, season: 2025, week: 2 },
  { ownerId: 'bob', manager: 'Bob', name: 'Free Add', bid: 0, points: 45, season: 2025, week: 9 }
];

test('waiver returns are measured in points per dollar', () => {
  const rows = waiverLeaderboard(claims);
  const alice = rows.find(r => r.ownerId === 'alice');
  const bob = rows.find(r => r.ownerId === 'bob');
  assert.equal(alice.spend, 43);
  assert.equal(alice.points, 186);
  assert.ok(Math.abs(alice.pointsPerDollar - 186 / 43) < 1e-9);
  assert.ok(alice.pointsPerDollar > bob.pointsPerDollar, 'Alice got more per dollar spent');
  assert.equal(rows[0].ownerId, 'alice', 'leaderboard sorts by return');
});

test('free claims are counted but kept out of the per-dollar figure', () => {
  const bob = waiverLeaderboard(claims).find(r => r.ownerId === 'bob');
  assert.equal(bob.freeClaims, 1);
  assert.equal(bob.paidPoints, 120, 'the free add is excluded from paid return');
  assert.equal(bob.points, 165, 'but still counts toward total points');
});

test('a manager who never spent has no per-dollar figure rather than infinity', () => {
  const rows = waiverLeaderboard([{ ownerId: 'c', bid: 0, points: 30 }]);
  assert.equal(rows[0].pointsPerDollar, null);
});

test('the best and worst individual claims are identified', () => {
  const alice = waiverLeaderboard(claims).find(r => r.ownerId === 'alice');
  assert.equal(alice.best.name, 'Cheap Gem');
  assert.equal(alice.worst.name, 'Dud', 'expensive and useless');
});

test('extremes surface hits and money-burning busts', () => {
  const { hits, busts } = waiverExtremes(claims);
  assert.equal(hits[0].name, 'Cheap Gem');
  assert.ok(busts.some(b => b.name === 'Dud'));
  assert.ok(!busts.some(b => b.bid === 0), 'a free add cannot be a bust');
});

const picks = [
  { ownerId: 'alice', manager: 'Alice', round: 1, name: 'Stud', points: 300 },
  { ownerId: 'bob', manager: 'Bob', round: 1, name: 'Reach', points: 100 },
  { ownerId: 'alice', manager: 'Alice', round: 4, name: 'Steal', points: 220 },
  { ownerId: 'bob', manager: 'Bob', round: 4, name: 'Miss', points: 20 }
];

test('draft baselines come from what each round actually returns', () => {
  const baselines = draftSlotBaselines(picks);
  assert.equal(baselines.get(1), 200);
  assert.equal(baselines.get(4), 120);
});

test('picks are graded against their own round, not the whole draft', () => {
  const graded = gradeDraftPicks(picks, draftSlotBaselines(picks));
  const steal = graded.find(p => p.name === 'Steal');
  const stud = graded.find(p => p.name === 'Stud');
  assert.equal(steal.delta, 100);
  assert.equal(stud.delta, 100);
  assert.ok(steal.delta === stud.delta, 'a fourth-rounder returning 220 matches a first returning 300');
});

test('draft leaderboard ranks managers by value added per pick', () => {
  const rows = draftLeaderboard(gradeDraftPicks(picks, draftSlotBaselines(picks)));
  assert.equal(rows[0].ownerId, 'alice');
  assert.equal(rows[0].deltaPerPick, 100);
  assert.equal(rows[1].deltaPerPick, -100);
  assert.equal(rows[0].best.name, 'Stud');
});

test('normalising puts different units on one scale', () => {
  assert.deepEqual(normalizeScores([0, 50, 100]), [0, 50, 100]);
  assert.deepEqual(normalizeScores([0, 50, 100], false), [100, 50, 0]);
  assert.deepEqual(normalizeScores([5, 5, 5]), [50, 50, 50], 'no spread means no signal');
});

test('a missing value scores neutral rather than worst', () => {
  const scores = normalizeScores([100, null, 0]);
  assert.equal(scores[1], 50);
});

test('the report card weights normalised categories', () => {
  const rows = reportCard(['alice', 'bob'], [
    { key: 'eff', label: 'Efficiency', weight: 2, values: new Map([['alice', 0.95], ['bob', 0.85]]) },
    { key: 'left', label: 'Points Left', weight: 1, higherIsBetter: false, values: new Map([['alice', 400], ['bob', 100]]) }
  ]);
  assert.equal(rows[0].ownerId, 'alice', 'efficiency is weighted double');
  assert.equal(rows[0].breakdown.length, 2);
  assert.equal(rows[0].breakdown.find(b => b.key === 'eff').score, 100);
  assert.equal(rows[0].breakdown.find(b => b.key === 'left').score, 0, 'inverted: more points left is worse');
});

test('a manager missing a category is not punished for it', () => {
  const rows = reportCard(['alice', 'bob'], [
    { key: 'waivers', label: 'Waivers', values: new Map([['alice', 10]]) }
  ]);
  const bob = rows.find(r => r.ownerId === 'bob');
  assert.equal(bob.overall, 50);
  assert.equal(bob.breakdown[0].missing, true);
});

test('ownership weeks collapse into readable stints', () => {
  const stints = summarizeStints([
    { ownerId: 'alice', manager: 'Alice', season: '2024', seasonNum: 2024, week: 1, points: 10, started: true },
    { ownerId: 'alice', manager: 'Alice', season: '2024', seasonNum: 2024, week: 2, points: 20, started: false },
    { ownerId: 'bob', manager: 'Bob', season: '2024', seasonNum: 2024, week: 3, points: 30, started: true },
    { ownerId: 'alice', manager: 'Alice', season: '2025', seasonNum: 2025, week: 1, points: 5, started: true }
  ]);
  assert.equal(stints.length, 3, 'a reacquisition is a separate stint');
  assert.equal(stints[0].weeks, 2);
  assert.equal(stints[0].points, 30);
  assert.equal(stints[0].startedPoints, 10, 'benched weeks do not count as started');
  assert.equal(stints[1].manager, 'Bob');
  assert.equal(stints[2].from.season, '2025');
});

test('an unowned player has no stints', () => {
  assert.deepEqual(summarizeStints([]), []);
});
