import test from 'node:test';
import assert from 'node:assert/strict';
import {
  optimalLineup,
  weekEfficiency,
  allPlayForWeek,
  accumulateAllPlay,
  luckIndex,
  scheduleSwap,
  coachingRecord,
  slotSignature,
  summarizeSlotChanges
} from '../efficiency.js';

const SLOTS = [['QB'], ['RB'], ['RB'], ['WR'], ['WR'], ['TE'], ['RB', 'WR', 'TE']];

const roster = [
  { id: 'qb1', pos: 'QB', points: 24 },
  { id: 'qb2', pos: 'QB', points: 30 },
  { id: 'rb1', pos: 'RB', points: 18 },
  { id: 'rb2', pos: 'RB', points: 12 },
  { id: 'rb3', pos: 'RB', points: 9 },
  { id: 'wr1', pos: 'WR', points: 22 },
  { id: 'wr2', pos: 'WR', points: 15 },
  { id: 'wr3', pos: 'WR', points: 14 },
  { id: 'te1', pos: 'TE', points: 8 }
];

test('the optimal lineup takes the best eligible player for every slot', () => {
  const best = optimalLineup(roster, SLOTS);
  assert.equal(best.total, 30 + 18 + 12 + 22 + 15 + 8 + 14, 'wr3 fills the flex');
  assert.ok(best.chosenIds.has('qb2'), 'the higher-scoring QB starts');
  assert.ok(!best.chosenIds.has('rb3'), 'the flex goes to the better WR, not the third RB');
});

test('a restrictive slot is not starved by a flex taking its player first', () => {
  const thin = [
    { id: 'te1', pos: 'TE', points: 20 },
    { id: 'wr1', pos: 'WR', points: 5 }
  ];
  const best = optimalLineup(thin, [['TE'], ['RB', 'WR', 'TE']]);
  assert.equal(best.total, 25, 'the TE fills the TE slot and the WR takes the flex');
});

test('superflex prefers the second quarterback when he outscores the flex options', () => {
  const best = optimalLineup(roster, [['QB'], ['QB', 'RB', 'WR', 'TE']]);
  assert.equal(best.total, 30 + 24, 'both quarterbacks start');
});

test('players without a known position are skipped rather than breaking the lineup', () => {
  const best = optimalLineup([{ id: 'x', points: 40 }, { id: 'qb1', pos: 'QB', points: 10 }], [['QB']]);
  assert.equal(best.total, 10);
});

test('an empty roster produces an empty lineup, not a crash', () => {
  assert.equal(optimalLineup([], SLOTS).total, 0);
  assert.equal(optimalLineup(roster, []).total, 0);
});

test('efficiency measures what was started against what was available', () => {
  // Started the worse QB and the third RB over the second WR.
  const started = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb3'];
  const week = weekEfficiency({ players: roster, startedIds: started, slots: SLOTS });
  assert.equal(week.actual, 24 + 18 + 12 + 22 + 15 + 8 + 9);
  assert.equal(week.optimal, 30 + 18 + 12 + 22 + 15 + 8 + 14);
  assert.equal(week.left, 11, 'six points at QB and five at flex');
  assert.ok(week.efficiency < 1 && week.efficiency > 0.9);
});

test('the worst start/sit call is identified with who it was benched for', () => {
  const started = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb3'];
  const week = weekEfficiency({ players: roster, startedIds: started, slots: SLOTS });
  assert.equal(week.topMiss.id, 'qb2', 'the biggest scorer left out');
  assert.equal(week.topMissReplaced.id, 'rb3', 'the weakest starter who should have made way');
});

test('a perfect lineup scores 100% efficiency and leaves nothing behind', () => {
  const started = ['qb2', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'wr3'];
  const week = weekEfficiency({ players: roster, startedIds: started, slots: SLOTS });
  assert.equal(week.left, 0);
  assert.equal(week.efficiency, 1);
  assert.equal(week.topMiss, null);
});

test('all-play scores every team against every other team', () => {
  const rows = allPlayForWeek([
    { ownerId: 'a', points: 120 },
    { ownerId: 'b', points: 100 },
    { ownerId: 'c', points: 80 },
    { ownerId: 'd', points: 60 }
  ]);
  assert.deepEqual(rows.get('a'), { ownerId: 'a', wins: 3, losses: 0, ties: 0 });
  assert.deepEqual(rows.get('c'), { ownerId: 'c', wins: 1, losses: 2, ties: 0 });
  assert.deepEqual(rows.get('d'), { ownerId: 'd', wins: 0, losses: 3, ties: 0 });
});

test('tied scores count as ties on both sides', () => {
  const rows = allPlayForWeek([
    { ownerId: 'a', points: 100 },
    { ownerId: 'b', points: 100 },
    { ownerId: 'c', points: 50 }
  ]);
  assert.equal(rows.get('a').ties, 1);
  assert.equal(rows.get('a').wins, 1);
});

test('expected wins come from the all-play win rate', () => {
  const totals = accumulateAllPlay([
    [{ ownerId: 'a', points: 120 }, { ownerId: 'b', points: 100 }, { ownerId: 'c', points: 80 }],
    [{ ownerId: 'a', points: 130 }, { ownerId: 'b', points: 90 }, { ownerId: 'c', points: 70 }]
  ]);
  const a = totals.get('a');
  assert.equal(a.wins, 4);
  assert.equal(a.winPct, 1);
  assert.equal(a.expectedWins, 2, 'undefeated on all-play means both wins were earned');
  assert.equal(totals.get('c').expectedWins, 0);
});

test('luck is the gap between the record and the all-play record', () => {
  assert.equal(luckIndex(9, 6.2).toFixed(1), '2.8');
  assert.ok(luckIndex(4, 7.5) < 0, 'a losing record against a strong all-play is bad luck');
});

test('a borrowed schedule replays the same scores against different opponents', () => {
  const weeks = [
    { scores: new Map([['a', 100], ['b', 90], ['c', 80], ['d', 70]]), opponents: new Map([['a', 'b'], ['b', 'a'], ['c', 'd'], ['d', 'c']]) },
    { scores: new Map([['a', 60], ['b', 95], ['c', 85], ['d', 75]]), opponents: new Map([['a', 'c'], ['c', 'a'], ['b', 'd'], ['d', 'b']]) }
  ];
  assert.deepEqual(scheduleSwap(weeks, 'a', 'a'), { ownerId: 'a', scheduleOwnerId: 'a', wins: 1, losses: 1, ties: 0 });
  const borrowed = scheduleSwap(weeks, 'a', 'd');
  assert.equal(borrowed.wins + borrowed.losses, 2);
});

test('borrowing a schedule that faces yourself substitutes its owner', () => {
  const weeks = [{ scores: new Map([['a', 100], ['b', 50]]), opponents: new Map([['a', 'b'], ['b', 'a']]) }];
  const swap = scheduleSwap(weeks, 'a', 'b');
  assert.equal(swap.wins, 1, 'a plays b rather than playing itself');
});

test('the coaching record finds games lost with a better lineup available', () => {
  const rows = coachingRecord([
    { season: 2025, week: 3, a: 'alice', b: 'bob', aActual: 100, bActual: 110, aOptimal: 130, bOptimal: 115 }
  ]);
  const alice = rows.get('alice');
  assert.equal(alice.actualLosses, 1);
  assert.equal(alice.optimalWins, 1);
  assert.equal(alice.flipped.length, 1, 'this loss was self-inflicted');
  assert.equal(alice.flipped[0].opponent, 'bob');
});

test('a game won on the field and on paper is not flagged', () => {
  const rows = coachingRecord([
    { season: 2025, week: 4, a: 'alice', b: 'bob', aActual: 120, bActual: 90, aOptimal: 140, bOptimal: 100 }
  ]);
  assert.equal(rows.get('alice').flipped.length, 0);
  assert.equal(rows.get('bob').flipped.length, 0);
});

test('an unmapped lineup slot is flagged rather than scoring above perfect', () => {
  const players = [
    { id: 'qb', pos: 'QB', points: 22 },
    { id: 'k', pos: 'K', points: 11 }
  ];
  const broken = weekEfficiency({ players, startedIds: ['qb', 'k'], slots: [['QB']] });
  assert.equal(broken.modeled, false, 'the kicker slot was not described');
  assert.ok(broken.efficiency <= 1, 'efficiency is never reported above 100%');

  const fixed = weekEfficiency({ players, startedIds: ['qb', 'k'], slots: [['QB'], ['K']] });
  assert.equal(fixed.modeled, true);
  assert.equal(fixed.actual, 33);
  assert.equal(fixed.optimal, 33);
  assert.equal(fixed.efficiency, 1);
});

test('kickers and defenses are optimised like any other slot', () => {
  const players = [
    { id: 'k1', pos: 'K', points: 4 },
    { id: 'k2', pos: 'K', points: 13 },
    { id: 'd1', pos: 'DEF', points: 2 },
    { id: 'd2', pos: 'DEF', points: 17 }
  ];
  const best = weekEfficiency({ players, startedIds: ['k1', 'd1'], slots: [['K'], ['DEF', 'DST']] });
  assert.equal(best.optimal, 30, 'the better kicker and defense start');
  assert.equal(best.left, 24);
  assert.equal(best.topMiss.id, 'd2');
});

test('a superflex slot takes a second quarterback over a flex option', () => {
  const players = [
    { id: 'qb1', pos: 'QB', points: 25 },
    { id: 'qb2', pos: 'QB', points: 19 },
    { id: 'rb1', pos: 'RB', points: 14 }
  ];
  const sf = weekEfficiency({
    players,
    startedIds: ['qb1', 'rb1'],
    slots: [['QB'], ['QB', 'RB', 'WR', 'TE']]
  });
  assert.equal(sf.optimal, 44, 'both quarterbacks beat the back');
  assert.equal(sf.topMiss.id, 'qb2');
  assert.equal(sf.modeled, true);
});

test('a season signature describes what was actually started', () => {
  assert.equal(
    slotSignature(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'IR']),
    '1QB 2RB 2WR 1TE 1FLEX 1K 1DEF'
  );
  assert.equal(slotSignature([]), '');
});

test('a league that never changed its lineup reads as stable', () => {
  const summary = summarizeSlotChanges({
    2023: ['QB', 'RB', 'WR', 'BN'],
    2024: ['QB', 'RB', 'WR', 'BN', 'BN']
  });
  assert.equal(summary.stable, true, 'bench slots are not part of the signature');
  assert.equal(summary.groups.length, 1);
});

test('dropping kicker and defense is detected as a configuration change', () => {
  const summary = summarizeSlotChanges({
    2022: ['QB', 'RB', 'WR', 'K', 'DEF'],
    2023: ['QB', 'RB', 'WR', 'K', 'DEF'],
    2024: ['QB', 'RB', 'WR'],
    2025: ['QB', 'RB', 'WR']
  });
  assert.equal(summary.stable, false);
  assert.equal(summary.groups.length, 2);
  assert.deepEqual(summary.groups[0].seasons, ['2022', '2023']);
  assert.deepEqual(summary.groups[1].seasons, ['2024', '2025']);
  assert.ok(summary.groups[0].signature.includes('1K'));
  assert.ok(!summary.groups[1].signature.includes('K'));
});

test('a league returning to an old configuration groups those seasons together', () => {
  const summary = summarizeSlotChanges({
    2022: ['QB', 'RB'],
    2023: ['QB', 'RB', 'WR'],
    2024: ['QB', 'RB']
  });
  assert.equal(summary.groups.length, 2);
  assert.deepEqual(summary.groups.find(g => g.seasons.includes('2024')).seasons, ['2022', '2024']);
});
