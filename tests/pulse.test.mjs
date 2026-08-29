import test from 'node:test';
import assert from 'node:assert/strict';
import {
  powerScore,
  powerSnapshot,
  powerRankings,
  managerActivity,
  countEmptySlots,
  countZeroStarters,
  DEFAULT_WEIGHTS
} from '../pulse.js';

test('power score is a weighted blend of its components', () => {
  const score = powerScore({ allPlay: 100, recent: 100, roster: 100, efficiency: 100 });
  assert.equal(score, 100);
  assert.equal(powerScore({ allPlay: 0, recent: 0, roster: 0, efficiency: 0 }), 0);
});

test('all-play carries more weight than lineup efficiency', () => {
  const goodTeam = powerScore({ allPlay: 100, recent: 100, roster: 50, efficiency: 0 });
  const goodManager = powerScore({ allPlay: 0, recent: 0, roster: 50, efficiency: 100 });
  assert.ok(goodTeam > goodManager);
  assert.ok(DEFAULT_WEIGHTS.allPlay > DEFAULT_WEIGHTS.efficiency);
});

test('missing components renormalise instead of scoring zero', () => {
  const withRoster = powerScore({ allPlay: 80, recent: 80, roster: 80, efficiency: 80 });
  const withoutRoster = powerScore({ allPlay: 80, recent: 80, roster: null, efficiency: 80 });
  assert.equal(withoutRoster, withRoster, 'a league with no market data still ranks sensibly');
  assert.equal(powerScore({}), null);
});

const weeks = [
  [{ ownerId: 'a', points: 120 }, { ownerId: 'b', points: 100 }, { ownerId: 'c', points: 80 }],
  [{ ownerId: 'a', points: 130 }, { ownerId: 'b', points: 90 }, { ownerId: 'c', points: 70 }],
  [{ ownerId: 'a', points: 60 }, { ownerId: 'b', points: 140 }, { ownerId: 'c', points: 135 }],
  [{ ownerId: 'a', points: 55 }, { ownerId: 'b', points: 150 }, { ownerId: 'c', points: 130 }]
];

test('rankings reflect all-play, not raw record', () => {
  const rows = powerSnapshot(weeks, { recentWindow: 2 });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].rank, 1);
  assert.ok(rows.every(r => r.score != null));
});

test('recent form pulls a collapsing team down', () => {
  const seasonOnly = powerSnapshot(weeks, { recentWindow: 4 });
  const recentHeavy = powerSnapshot(weeks, { recentWindow: 2 });
  const aSeasonRank = seasonOnly.find(r => r.ownerId === 'a').rank;
  const aRecentRank = recentHeavy.find(r => r.ownerId === 'a').rank;
  assert.ok(aRecentRank >= aSeasonRank, 'team A fell apart in the last two weeks');
});

test('roster strength is scaled within the league', () => {
  const rows = powerSnapshot(weeks, {
    rosterStrength: new Map([['a', 10000], ['b', 5000], ['c', 5000]])
  });
  assert.equal(rows.find(r => r.ownerId === 'a').components.roster, 100);
  assert.equal(rows.find(r => r.ownerId === 'c').components.roster, 0);
});

test('movement compares against the same ranking one week earlier', () => {
  const rows = powerRankings(weeks, { recentWindow: 2 });
  assert.ok(rows.every(r => r.previousRank != null));
  const sum = rows.reduce((n, r) => n + r.movement, 0);
  assert.equal(sum, 0, 'every place gained is a place lost by someone else');
});

test('a single week of data has no movement to report', () => {
  const rows = powerRankings([weeks[0]]);
  assert.equal(rows[0].movement, null);
  assert.equal(rows[0].previousRank, null);
});

test('an empty season produces no rankings rather than throwing', () => {
  assert.deepEqual(powerSnapshot([]), []);
});

test('empty lineup slots are counted from Sleeper zero markers', () => {
  assert.equal(countEmptySlots(['123', '0', '456', '', null]), 3);
  assert.equal(countEmptySlots([]), 0);
});

test('zero-scoring starters are counted but empty slots are not double counted', () => {
  const points = { '123': 18.4, '456': 0, '789': 0 };
  assert.equal(countZeroStarters(['123', '456', '789', '0'], points), 2);
  assert.equal(countZeroStarters(['123'], points), 0);
});

const engaged = [
  { ownerId: 'active', manager: 'Active', week: 5, efficiency: 0.97, emptySlots: 0, zeroStarters: 0 },
  { ownerId: 'active', manager: 'Active', week: 6, efficiency: 0.95, emptySlots: 0, zeroStarters: 0 },
  { ownerId: 'gone', manager: 'Ghost', week: 5, efficiency: 0.62, emptySlots: 2, zeroStarters: 2 },
  { ownerId: 'gone', manager: 'Ghost', week: 6, efficiency: 0.58, emptySlots: 1, zeroStarters: 3 },
  { ownerId: 'setandforget', manager: 'Steady', week: 5, efficiency: 0.94, emptySlots: 0, zeroStarters: 0 },
  { ownerId: 'setandforget', manager: 'Steady', week: 6, efficiency: 0.93, emptySlots: 0, zeroStarters: 0 }
];

test('an abandoned roster surfaces with its evidence', () => {
  const rows = managerActivity(engaged, { currentWeek: 6, lastTransactionWeek: new Map([['gone', 1], ['active', 6], ['setandforget', 1]]) });
  const ghost = rows.find(r => r.ownerId === 'gone');
  assert.equal(ghost.concern, true);
  assert.ok(ghost.signals.some(s => s.key === 'empty'), 'empty slots are the strongest signal');
  assert.ok(ghost.signals.length >= 3);
  assert.equal(rows[0].ownerId, 'gone', 'sorted by weight of evidence');
});

test('a quiet manager with a good lineup is not accused of anything', () => {
  const rows = managerActivity(engaged, { currentWeek: 6, lastTransactionWeek: new Map([['setandforget', 1]]) });
  const steady = rows.find(r => r.ownerId === 'setandforget');
  assert.equal(steady.concern, false, 'making no moves is a style, not neglect');
  assert.deepEqual(steady.signals.map(s => s.key), ['quiet']);
});

test('an engaged manager raises no signals at all', () => {
  const rows = managerActivity(engaged, { currentWeek: 6, lastTransactionWeek: new Map([['active', 6]]) });
  const active = rows.find(r => r.ownerId === 'active');
  assert.equal(active.signals.length, 0);
  assert.equal(active.concern, false);
  assert.ok(active.efficiency > 0.9);
});

test('a single empty slot is enough on its own', () => {
  const rows = managerActivity(
    [{ ownerId: 'x', manager: 'X', week: 6, efficiency: 0.99, emptySlots: 1, zeroStarters: 0 }],
    { currentWeek: 6 }
  );
  assert.equal(rows[0].concern, true, 'an unfilled slot is unambiguous');
});

test('no transaction history means no quiet signal rather than a false one', () => {
  const rows = managerActivity(engaged, { currentWeek: 6, lastTransactionWeek: new Map() });
  assert.ok(!rows.some(r => r.signals.some(s => s.key === 'quiet')));
});
