import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeLetter,
  edgePct,
  isUnplayedWeek,
  rankAmong,
  buildPlayerIndex,
  isAtOrAfter,
  realizedForPlayer,
  realizedForSide,
  realizedSettledShare,
  materiality,
  dampenedEdge,
  isMinorTrade,
  isBefore,
  realizedForPlayerWindow,
  attributionShare,
  traceAssetForward,
  percentileRank,
  valueWeightedAge,
  strengthScore,
  timelineScore,
  classifyWindow,
  windowDirective,
  windowComplement,
  starterSlotCounts,
  replacementLevels,
  surplusValue,
  rosterCrunchCost
} from '../analytics.js';

test('grade bands are width-symmetric around B', () => {
  assert.equal(gradeLetter(40), 'A+');
  assert.equal(gradeLetter(25), 'A+');
  assert.equal(gradeLetter(20), 'A');
  assert.equal(gradeLetter(10), 'A-');
  assert.equal(gradeLetter(5), 'B+');
  assert.equal(gradeLetter(0), 'B');
  assert.equal(gradeLetter(-5), 'B-');
  assert.equal(gradeLetter(-10), 'C');
  assert.equal(gradeLetter(-20), 'D');
  assert.equal(gradeLetter(-40), 'F');
});

test('an unknown edge never renders as a letter', () => {
  assert.equal(gradeLetter(null), '—');
  assert.equal(gradeLetter(undefined), '—');
  assert.equal(gradeLetter(NaN), '—');
});

test('edgePct returns null rather than a fake even split when both sides are zero', () => {
  assert.equal(edgePct(0, 0), null);
  assert.equal(edgePct(100, 100), 0);
  assert.equal(Math.round(edgePct(120, 80)), 40);
  assert.equal(edgePct(80, 120), -edgePct(120, 80));
});

test('a scheduled but unscored week is rejected', () => {
  assert.equal(isUnplayedWeek([{ points: 0 }, { points: 0 }]), true);
  assert.equal(isUnplayedWeek([{ points: 0 }, { points: 88.4 }]), false);
  assert.equal(isUnplayedWeek([]), true);
  assert.equal(isUnplayedWeek(null), true);
});

test('rankAmong is 1-based and handles values outside the set', () => {
  assert.equal(rankAmong([50, 40, 30], 50), 1);
  assert.equal(rankAmong([50, 40, 30], 40), 2);
  assert.equal(rankAmong([50, 40, 30], 30), 3);
  assert.equal(rankAmong([50, 40, 30], 10), 3);
  assert.equal(rankAmong([50, 40, 30], 99), 1);
});

const games = [
  { playerId: '1', ownerId: 'alice', seasonNum: 2024, week: 3, points: 10, started: true },
  { playerId: '1', ownerId: 'alice', seasonNum: 2024, week: 4, points: 20, started: false },
  { playerId: '1', ownerId: 'bob', seasonNum: 2024, week: 8, points: 30, started: true },
  { playerId: '1', ownerId: 'alice', seasonNum: 2025, week: 1, points: 5, started: true },
  { playerId: '2', ownerId: 'alice', seasonNum: 2024, week: 5, points: 7, started: true }
];
const index = buildPlayerIndex(games);

test('isAtOrAfter compares season then week', () => {
  assert.equal(isAtOrAfter({ seasonNum: 2025, week: 1 }, 2024, 10), true);
  assert.equal(isAtOrAfter({ seasonNum: 2023, week: 17 }, 2024, 1), false);
  assert.equal(isAtOrAfter({ seasonNum: 2024, week: 3 }, 2024, 4), false);
  assert.equal(isAtOrAfter({ seasonNum: 2024, week: 4 }, 2024, 4), true);
  assert.equal(isAtOrAfter({ seasonNum: 2024, week: 1 }, 2024, null), true);
});

test('realized points only count weeks that manager actually rostered the player', () => {
  const alice = realizedForPlayer(index, '1', 'alice', 2024, 3);
  assert.equal(alice.rostered, 35, 'weeks 3 and 4 of 2024 plus week 1 of 2025');
  assert.equal(alice.started, 15, 'week 4 was a bench week and must not count');
  assert.equal(alice.startedWeeks, 2);
});

test('a player traded away stops accruing to the original acquirer', () => {
  const alice = realizedForPlayer(index, '1', 'alice', 2024, 3);
  const bob = realizedForPlayer(index, '1', 'bob', 2024, 8);
  assert.equal(bob.started, 30);
  assert.ok(!alice.rostered.toString().includes('65'), 'week 8 under bob is excluded from alice');
});

test('points before the trade date are excluded', () => {
  const late = realizedForPlayer(index, '1', 'alice', 2025, 1);
  assert.equal(late.rostered, 5);
  assert.equal(late.startedWeeks, 1);
});

test('a side aggregates every asset it received', () => {
  const side = realizedForSide(index, ['1', '2'], 'alice', 2024, 3);
  assert.equal(side.started, 22);
  assert.equal(side.counted, 2);
});

test('unknown players contribute nothing rather than throwing', () => {
  const side = realizedForSide(index, ['999'], 'alice', 2024, 1);
  assert.equal(side.started, 0);
  assert.equal(side.counted, 0);
});

test('settled share reflects how much of a deal has resolved', () => {
  assert.equal(realizedSettledShare([{ kind: 'player' }, { kind: 'player' }]), 1);
  assert.equal(realizedSettledShare([{ kind: 'player' }, { kind: 'unresolvedPick' }]), 0.5);
  assert.equal(realizedSettledShare([{ kind: 'resolvedPick' }, { kind: 'unresolvedPick' }]), 0.5);
  assert.equal(realizedSettledShare([{ kind: 'player' }, { kind: 'faab' }]), 1, 'FAAB is not gradeable either way');
  assert.equal(realizedSettledShare([]), null);
});

// --- chain following -------------------------------------------------------

test('isBefore is the strict complement of isAtOrAfter', () => {
  assert.equal(isBefore({ seasonNum: 2024, week: 3 }, 2024, 5), true);
  assert.equal(isBefore({ seasonNum: 2024, week: 5 }, 2024, 5), false);
  assert.equal(isBefore({ seasonNum: 2023, week: 17 }, 2024, 1), true);
  assert.equal(isBefore({ seasonNum: 2025, week: 1 }, 2024, 1), false);
});

test('a windowed stint excludes points after the player is flipped away', () => {
  const held = realizedForPlayerWindow(index, '1', 'alice', { season: 2024, week: 3 }, { season: 2024, week: 8 });
  assert.equal(held.started, 10, 'only week 3; week 4 was benched and week 8 is past the window');
  assert.equal(held.rostered, 30);
});

test('reacquisition is not double counted when the window is bounded', () => {
  const unbounded = realizedForPlayer(index, '1', 'alice', 2024, 3);
  const firstStint = realizedForPlayerWindow(index, '1', 'alice', { season: 2024, week: 3 }, { season: 2024, week: 8 });
  const secondStint = realizedForPlayerWindow(index, '1', 'alice', { season: 2025, week: 1 }, null);
  assert.equal(firstStint.started + secondStint.started, unbounded.started);
});

test('attribution splits a package return by value', () => {
  const outgoing = [{ id: 'a', value: 75 }, { id: 'b', value: 25 }];
  assert.equal(attributionShare(outgoing, 'a'), 0.75);
  assert.equal(attributionShare(outgoing, 'b'), 0.25);
});

test('attribution falls back to an even split without usable values', () => {
  const outgoing = [{ id: 'a', value: 0 }, { id: 'b', value: 0 }];
  assert.equal(attributionShare(outgoing, 'a'), 0.5);
  assert.equal(attributionShare([{ id: 'a', value: 10 }, { id: 'b', value: 10 }], 'missing'), 0.5);
  assert.equal(attributionShare([], 'a'), 1);
});

test('a solo asset keeps its whole return', () => {
  assert.equal(attributionShare([{ id: 'a', value: 500 }], 'a'), 1);
});

// --- chain walker ----------------------------------------------------------

// alice acquires player 10 in a trade at 2024 week 1, flips him at week 6 for
// players 20 and 30, then flips 20 again at week 10 as half of a package.
const chainGames = [
  { playerId: '10', ownerId: 'alice', seasonNum: 2024, week: 2, points: 12, started: true },
  { playerId: '10', ownerId: 'alice', seasonNum: 2024, week: 8, points: 99, started: true },
  { playerId: '20', ownerId: 'alice', seasonNum: 2024, week: 7, points: 8, started: true },
  { playerId: '30', ownerId: 'alice', seasonNum: 2024, week: 7, points: 6, started: true },
  { playerId: '40', ownerId: 'alice', seasonNum: 2024, week: 12, points: 20, started: true }
];
const flipA = { id: 'T2', season: 2024, week: 6, created: 200, out: [{ id: '10', value: 100 }], back: ['20', '30'] };
const flipB = { id: 'T3', season: 2024, week: 10, created: 300, out: [{ id: '20', value: 50 }, { id: '99', value: 50 }], back: ['40'] };

function chainCtx(trades) {
  return {
    playerIndex: buildPlayerIndex(chainGames),
    describe: id => ({ name: `P${id}`, meta: '' }),
    nextFlip: (playerId, ownerId, after) =>
      trades.find(t => t.out.some(o => o.id === String(playerId)) && t.created > after) || null,
    rosterFor: () => 1,
    outgoing: t => t.out,
    received: t => t.back,
    chrono: t => ({ season: t.season, week: t.week }),
    createdOf: t => t.created,
    idOf: t => t.id,
    seasonOf: t => t.season,
    dateOf: t => `${t.season}-W${t.week}`
  };
}

test('credit follows an asset into what it was flipped for', () => {
  const ctx = chainCtx([flipA]);
  const { node, total, hops } = traceAssetForward(ctx, '10', 'alice', { season: 2024, week: 1 }, 100);
  assert.equal(node.held, 12, 'week 2 counts, week 8 is after the flip');
  assert.equal(hops, 1);
  assert.equal(total, 12 + 8 + 6, 'the two players received carry full credit');
  assert.equal(node.children.length, 2);
});

test('a packaged flip splits credit by value', () => {
  const ctx = chainCtx([flipA, flipB]);
  const { node, total } = traceAssetForward(ctx, '10', 'alice', { season: 2024, week: 1 }, 100);
  const twenty = node.children.find(c => c.playerId === '20');
  assert.equal(twenty.flip.packaged, true);
  assert.equal(twenty.flip.share, 0.5, 'player 20 was half the outgoing value');
  assert.equal(total, 12 + 8 + 6 + 20 * 0.5, 'player 40 is credited at 50%');
});

test('points after a flip belong to the chain, never to the original holder', () => {
  const ctx = chainCtx([flipA]);
  const { node } = traceAssetForward(ctx, '10', 'alice', { season: 2024, week: 1 }, 100);
  assert.equal(node.held, 12);
  assert.ok(node.held < 99, 'week 8 output under a later owner is excluded');
});

test('the walker stops at the depth limit', () => {
  const loopFlip = { id: 'L', season: 2024, week: 2, created: 150, out: [{ id: '10', value: 10 }], back: ['10'] };
  const ctx = chainCtx([loopFlip]);
  const { hops } = traceAssetForward(ctx, '10', 'alice', { season: 2024, week: 1 }, 100, 1, 0, new Set(), { maxDepth: 3, minWeight: 0 });
  assert.ok(hops <= 3, `expected the depth cap to bound recursion, got ${hops} hops`);
});

test('a revisited trade does not loop forever', () => {
  const ctx = chainCtx([flipA]);
  const seen = new Set(['T2|10']);
  const { hops, node } = traceAssetForward(ctx, '10', 'alice', { season: 2024, week: 1 }, 100, 1, 0, seen);
  assert.equal(hops, 0);
  assert.equal(node.children.length, 0);
});

test('an asset that is never traded again terminates cleanly', () => {
  const ctx = chainCtx([]);
  const { node, total, hops } = traceAssetForward(ctx, '10', 'alice', { season: 2024, week: 1 }, 100);
  assert.equal(node.flip, null);
  assert.equal(hops, 0);
  assert.equal(total, 111, 'both weeks count when nothing bounds the stint');
});

// --- competitive window ----------------------------------------------------

test('percentiles are used instead of noisy ordinal ranks', () => {
  const vals = [10, 20, 30, 40];
  assert.equal(percentileRank(vals, 40), 87.5);
  assert.equal(percentileRank(vals, 10), 12.5);
  assert.equal(percentileRank(vals, 25), 50);
  assert.equal(percentileRank([5], 5), 50, 'a one-team league has no signal');
});

test('roster age is weighted by value, not headcount', () => {
  const stars = [{ age: 30, value: 9000 }, { age: 22, value: 100 }];
  assert.ok(valueWeightedAge(stars) > 29, 'value concentrated in a 30-year-old reads as old');
  const spread = [{ age: 30, value: 100 }, { age: 22, value: 9000 }];
  assert.ok(valueWeightedAge(spread) < 23);
  assert.equal(valueWeightedAge([], 26), 26);
  assert.equal(valueWeightedAge([{ value: 100 }], 27), 27, 'missing ages fall back');
});

test('record barely counts before the sample exists', () => {
  const preseason = strengthScore({ lineupPct: 90, recordPct: 0, pfPct: 0, gamesPlayed: 0 });
  assert.equal(preseason, 90, 'week zero is pure roster strength');
  const midseason = strengthScore({ lineupPct: 90, recordPct: 0, pfPct: 0, gamesPlayed: 8 });
  assert.ok(midseason < preseason, 'a bad record eventually drags the score down');
  assert.ok(midseason > 45, 'but roster strength still dominates');
});

test('the four quadrants separate strong-old from strong-young', () => {
  assert.equal(classifyWindow(80, 80).key, 'contend');
  assert.equal(classifyWindow(80, 20).key, 'push');
  assert.equal(classifyWindow(20, 80).key, 'rebuild');
  assert.equal(classifyWindow(20, 20).key, 'reset');
});

test('directives point opposite ways for contenders and rebuilders', () => {
  assert.equal(windowDirective('push').preferPicks, false);
  assert.equal(windowDirective('push').preferYouth, false);
  assert.equal(windowDirective('reset').preferPicks, true);
  assert.equal(windowDirective('reset').preferYouth, true);
  assert.ok(windowDirective('reset').sellAgeFloor < windowDirective('rebuild').sellAgeFloor,
    'a hard reset sells younger than a normal rebuild');
});

test('opposite windows make better trade partners than matching ones', () => {
  const contender = { strength: 85, timeline: 25 };
  const rebuilder = { strength: 20, timeline: 85 };
  const twin = { strength: 84, timeline: 26 };
  assert.ok(windowComplement(contender, rebuilder) > windowComplement(contender, twin));
  assert.ok(windowComplement(contender, twin) < 0.2, 'two teams in the same position want the same assets');
  assert.equal(windowComplement(null, rebuilder), 0);
});

test('composed the way the app composes it, the quadrants come out right', () => {
  // Mirrors leagueWindows(): percentile each axis, invert age, then classify.
  const teams = [
    { name: 'old and good', lineup: 9000, picks: 200, age: 29.5, winPct: 0.8, pf: 1500, gp: 10 },
    { name: 'young and good', lineup: 8800, picks: 1800, age: 23.2, winPct: 0.7, pf: 1450, gp: 10 },
    { name: 'young and bad', lineup: 3000, picks: 2200, age: 22.8, winPct: 0.2, pf: 900, gp: 10 },
    { name: 'old and bad', lineup: 3200, picks: 150, age: 29.9, winPct: 0.1, pf: 850, gp: 10 }
  ];
  const lineups = teams.map(t => t.lineup);
  const picks = teams.map(t => t.picks);
  const ages = teams.map(t => t.age);
  const wins = teams.map(t => t.winPct);
  const pfs = teams.map(t => t.pf);

  const classify = t => {
    const strength = strengthScore({
      lineupPct: percentileRank(lineups, t.lineup),
      recordPct: percentileRank(wins, t.winPct),
      pfPct: percentileRank(pfs, t.pf),
      gamesPlayed: t.gp
    });
    const timeline = timelineScore({
      youthPct: 100 - percentileRank(ages, t.age),
      pickPct: percentileRank(picks, t.picks)
    });
    return classifyWindow(strength, timeline).key;
  };

  assert.equal(classify(teams[0]), 'push', 'strong but aging means the window is closing');
  assert.equal(classify(teams[1]), 'contend');
  assert.equal(classify(teams[2]), 'rebuild');
  assert.equal(classify(teams[3]), 'reset', 'old and losing is the urgent sell');
});

// --- value over replacement ------------------------------------------------

test('flex slots are allocated by observed usage, not split evenly', () => {
  const slots = [['QB'], ['RB'], ['WR'], ['RB', 'WR', 'TE']];
  const counts = starterSlotCounts(slots, { RB: 10, WR: 30, TE: 0 });
  assert.equal(counts.QB, 1);
  assert.equal(counts.RB, 1.25, 'a quarter of the flex went to RB');
  assert.equal(counts.WR, 1.75);
  assert.equal(counts.TE ?? 0, 0, 'a position that never fills flex gets none of it');
});

test('with no usage data the flex splits evenly', () => {
  const counts = starterSlotCounts([['RB', 'WR', 'TE']], {});
  assert.ok(Math.abs(counts.RB - 1 / 3) < 1e-9);
  assert.ok(Math.abs(counts.TE - 1 / 3) < 1e-9);
});

test('superflex pulls QB replacement up the board', () => {
  const oneQb = starterSlotCounts([['QB']], {});
  const superflex = starterSlotCounts([['QB'], ['QB', 'RB', 'WR', 'TE']], { QB: 20, RB: 0, WR: 0, TE: 0 });
  assert.equal(oneQb.QB, 1);
  assert.equal(superflex.QB, 2, 'a superflex filled by QBs is a second QB slot');
});

test('replacement level is the best player who would not be starting', () => {
  const pools = { RB: [100, 90, 80, 70, 60] };
  assert.equal(replacementLevels(pools, { RB: 2 }).RB, 80, 'RB3 is the first non-starter');
  assert.equal(replacementLevels(pools, { RB: 0 }).RB, 0);
  assert.equal(replacementLevels({ RB: [] }, { RB: 2 }).RB, 0);
});

test('a fractional starter count interpolates between the bracketing players', () => {
  const pools = { WR: [100, 90, 80, 70] };
  assert.equal(replacementLevels(pools, { WR: 2.5 }).WR, 75, 'halfway between WR3 and WR4');
});

test('replacement runs off the end of a shallow pool without throwing', () => {
  assert.equal(replacementLevels({ TE: [50] }, { TE: 12 }).TE, 0);
});

test('surplus is floored at zero so depth pieces do not add up to a stud', () => {
  assert.equal(surplusValue(5000, 1200), 3800);
  assert.equal(surplusValue(900, 1200), 0);
  const threeDepth = [1300, 1250, 1200].reduce((n, v) => n + surplusValue(v, 1200), 0);
  const oneStud = surplusValue(5000, 1200);
  assert.ok(oneStud > threeDepth, 'consolidation wins on surplus even when raw sums are close');
});

test('roster crunch charges for the players a lopsided trade forces out', () => {
  const players = [
    { id: 'a', value: 5000, surplus: 3800 },
    { id: 'b', value: 1300, surplus: 100 },
    { id: 'c', value: 900, surplus: 0 },
    { id: 'd', value: 400, surplus: 0 }
  ];
  const crunch = rosterCrunchCost(players, 2);
  assert.equal(crunch.overBy, 2);
  assert.deepEqual(crunch.cuts.map(c => c.id), ['d', 'c'], 'lowest surplus goes first, value breaks the tie');
  assert.equal(crunch.cost, 1300);
});

test('a roster inside the limit is charged nothing', () => {
  assert.deepEqual(rosterCrunchCost([{ id: 'a', value: 1 }], 10), { overBy: 0, cuts: [], cost: 0 });
  assert.equal(rosterCrunchCost([{ id: 'a', value: 1 }], null).overBy, 0);
});

test('composed end to end, a 3-for-1 that looks even on market value is not', () => {
  // 12 teams, lineup QB/RB/RB/WR/WR/TE/FLEX/SUPERFLEX, flex filled mostly by WR.
  const slots = [['QB'], ['RB'], ['RB'], ['WR'], ['WR'], ['TE'], ['RB', 'WR', 'TE'], ['QB', 'RB', 'WR', 'TE']];
  const teams = 12;
  const perTeam = starterSlotCounts(slots, { QB: 9, RB: 4, WR: 8, TE: 1 });
  const leagueWide = Object.fromEntries(Object.entries(perTeam).map(([pos, n]) => [pos, n * teams]));

  // A realistic descending RB board across the league.
  const rbBoard = Array.from({ length: 70 }, (_, i) => 9000 - i * 180);
  const levels = replacementLevels({ RB: rbBoard }, leagueWide);
  assert.ok(levels.RB > 0, 'replacement level is real, not zero');

  const stud = { id: 'stud', value: 8000, pos: 'RB' };
  const depth = [1, 2, 3].map(i => ({ id: `d${i}`, value: 2700, pos: 'RB' }));

  const rawStud = stud.value;
  const rawDepth = depth.reduce((n, p) => n + p.value, 0);
  assert.ok(rawDepth > rawStud, 'on raw market value the three-piece side is ahead');

  const surplusStud = surplusValue(stud.value, levels.RB);
  const surplusDepth = depth.reduce((n, p) => n + surplusValue(p.value, levels.RB), 0);
  assert.ok(surplusStud > surplusDepth, 'on surplus the stud side wins');

  // And the side taking three players for one has to drop two.
  const before = Array.from({ length: 24 }, (_, i) => ({ id: `r${i}`, value: 500 + i * 40, surplus: 0 }));
  const after = [...before.slice(1), ...depth.map(p => ({ ...p, surplus: surplusValue(p.value, levels.RB) }))];
  const crunch = rosterCrunchCost(after, 25);
  assert.equal(crunch.overBy, 1, 'sending one and receiving three puts the roster over');
  assert.ok(crunch.cost > 0, 'the forced drop has a real cost');
});

// --- deal size -------------------------------------------------------------

const STARTABLE = 1200;

test('a tiny lopsided deal is damped, a real one is not', () => {
  // Both are a 200% edge on the raw ratio. Only one of them matters.
  const noise = dampenedEdge(200, 20, STARTABLE);
  const real = dampenedEdge(200, 9000, STARTABLE);
  assert.ok(Math.abs(noise) < 5, `two worthless players should not grade out, got ${noise.toFixed(1)}`);
  assert.equal(gradeLetter(noise), 'B');
  assert.equal(real, 200, 'a genuine blockbuster keeps its full edge');
  assert.equal(gradeLetter(real), 'A+');
});

test('materiality rises with deal size and tops out', () => {
  assert.equal(materiality(0, STARTABLE), 0);
  assert.equal(materiality(3600, STARTABLE), 1, 'three startable players is a full deal');
  assert.equal(materiality(50000, STARTABLE), 1, 'it never exceeds one');
  assert.ok(materiality(1800, STARTABLE) < 0.5, 'the curve is steeper than a straight ratio');
  assert.ok(materiality(2700, STARTABLE) > materiality(1800, STARTABLE));
});

test('a bench-depth swap does not grade like a blockbuster', () => {
  // 400 against 150 is a 91% edge on the raw ratio, which used to read A+.
  const depth = dampenedEdge(91, 550, STARTABLE);
  assert.ok(['B', 'B+'].includes(gradeLetter(depth)), `expected a modest grade, got ${gradeLetter(depth)}`);
});

test('a two-to-one swap of startable players still grades strongly', () => {
  const real = dampenedEdge(66, 1800, STARTABLE);
  assert.ok(['A', 'A-'].includes(gradeLetter(real)), `expected a strong grade, got ${gradeLetter(real)}`);
});

test('without a reference nothing is damped', () => {
  assert.equal(materiality(20, 0), 1);
  assert.equal(dampenedEdge(200, 20, null), 200, 'a league with no market data grades as before');
});

test('a deal below a quarter of a startable player is not worth grading', () => {
  assert.equal(isMinorTrade(20, STARTABLE), true);
  assert.equal(isMinorTrade(200, STARTABLE), true);
  assert.equal(isMinorTrade(400, STARTABLE), false);
  assert.equal(isMinorTrade(9000, STARTABLE), false);
  assert.equal(isMinorTrade(20, 0), false, 'no reference means no judgement');
});

test('an unknown edge stays unknown after damping', () => {
  assert.equal(dampenedEdge(null, 9000, STARTABLE), null);
  assert.equal(gradeLetter(dampenedEdge(null, 9000, STARTABLE)), '—');
});

test('damping preserves which side won', () => {
  const winner = dampenedEdge(60, 4000, STARTABLE);
  const loser = dampenedEdge(-60, 4000, STARTABLE);
  assert.ok(winner > 0 && loser < 0);
  assert.equal(winner, -loser);
});
