import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  matchKey,
  buildNameIndex,
  matchRankings,
  parsePositionRank,
  marketPositionRanks,
  arbitrage,
  coverageSummary,
  arbitrageThresholds,
  extractProjectedPoints,
  projectionPointsField,
  normalizeRow,
  matchProjections,
  startSitAdvice
} from '../fantasypros.js';

test('names normalise across the two services', () => {
  assert.equal(normalizeName('Marvin Harrison Jr.'), 'marvin harrison');
  assert.equal(normalizeName('MARVIN HARRISON JR'), 'marvin harrison');
  assert.equal(normalizeName("Ja'Marr Chase"), 'jamarr chase');
  assert.equal(normalizeName('Amon-Ra St. Brown'), 'amon-ra st brown');
  assert.equal(normalizeName('Michael Pittman III'), 'michael pittman');
  assert.equal(normalizeName(''), '');
});

test('team defenses normalise to a common form', () => {
  assert.equal(normalizeName('San Francisco 49ers DST'), normalizeName('San Francisco 49ers D/ST'));
});

test('the match key separates two players who share a name', () => {
  assert.notEqual(matchKey('Michael Thomas', 'WR'), matchKey('Michael Thomas', 'S'));
});

const playerMap = {
  '100': { full_name: 'Marvin Harrison Jr.', position: 'WR', team: 'ARI' },
  '200': { first_name: "Ja'Marr", last_name: 'Chase', position: 'WR', team: 'CIN' },
  '300': { full_name: 'Michael Thomas', position: 'WR', team: 'NO' },
  '301': { full_name: 'Michael Thomas', position: 'LB', team: 'FA' },
  '400': { full_name: 'No Position Guy' }
};

test('the name index drops ambiguous entries rather than guessing', () => {
  const index = buildNameIndex(playerMap);
  assert.equal(index.get(matchKey('Marvin Harrison Jr', 'WR')), '100');
  assert.equal(index.get(matchKey("Ja'Marr Chase", 'WR')), '200');
  assert.equal(index.has(matchKey('No Position Guy', '')), false, 'no position means no key');
});

test('rankings match onto Sleeper ids', () => {
  const index = buildNameIndex(playerMap);
  const { matched, unmatched } = matchRankings([
    { player_name: 'Marvin Harrison Jr.', player_position_id: 'WR', rank_ecr: 4, pos_rank: 'WR3', tier: 1, rank_std: 2.1 },
    { player_name: "Ja'Marr Chase", player_position_id: 'WR', rank_ecr: 1, pos_rank: 'WR1', tier: 1 },
    { player_name: 'Nobody At All', player_position_id: 'RB', rank_ecr: 90, pos_rank: 'RB40' }
  ], index);

  assert.equal(matched.get('100').positionRank, 3);
  assert.equal(matched.get('100').ecr, 4);
  assert.equal(matched.get('100').stdDev, 2.1);
  assert.equal(matched.get('200').positionRank, 1);
  assert.deepEqual(unmatched, ['Nobody At All']);
});

test('a position disagreement still matches when the name is unique', () => {
  const index = buildNameIndex({ '500': { full_name: 'Taysom Hill', position: 'TE' } });
  const { matched } = matchRankings([{ player_name: 'Taysom Hill', player_position_id: 'QB', rank_ecr: 150, pos_rank: 'QB30' }], index);
  assert.equal(matched.get('500').positionRank, 30, 'fell back to the unique name');
});

test('an ambiguous name is left unmatched rather than mismatched', () => {
  const index = buildNameIndex(playerMap);
  const { matched, unmatched } = matchRankings([
    { player_name: 'Michael Thomas', player_position_id: 'RB', rank_ecr: 200, pos_rank: 'RB70' }
  ], index);
  assert.equal(matched.size, 0);
  assert.deepEqual(unmatched, ['Michael Thomas']);
});

test('position ranks parse from either format', () => {
  assert.equal(parsePositionRank('WR12'), 12);
  assert.equal(parsePositionRank(12), 12);
  assert.equal(parsePositionRank(null), null);
  assert.equal(parsePositionRank('—'), null);
});

test('market ranks are computed within each position', () => {
  const ranks = marketPositionRanks([
    { id: 'a', position: 'WR', value: 9000 },
    { id: 'b', position: 'WR', value: 4000 },
    { id: 'c', position: 'RB', value: 8000 },
    { id: 'd', position: 'WR', value: 0 }
  ]);
  assert.equal(ranks.get('a'), 1);
  assert.equal(ranks.get('b'), 2);
  assert.equal(ranks.get('c'), 1, 'ranks restart per position');
  assert.equal(ranks.has('d'), false, 'valueless players are not ranked');
});

function ecrPool(extra = []) {
  const rows = new Map();
  for (let i = 1; i <= 10; i++) {
    rows.set(`f${i}`, { sleeperId: `f${i}`, name: `Filler ${i}`, position: 'WR', positionRank: i, ecr: i, stdDev: 5 });
  }
  for (const row of extra) rows.set(row.sleeperId, row);
  return rows;
}

test('experts higher than the market reads as buy-low', () => {
  const ecr = ecrPool([{ sleeperId: 'x', name: 'Buy Guy', position: 'WR', positionRank: 6, ecr: 20, stdDev: 4 }]);
  const marketRanks = new Map([...ecr.keys()].map((id, i) => [id, i + 1]));
  marketRanks.set('x', 25);
  const rows = arbitrage({ ecr, marketRanks });
  const found = rows.find(r => r.sleeperId === 'x');
  assert.equal(found.signal, 'buy');
  assert.equal(found.delta, 19, 'market has him 19 spots worse than the experts do');
});

test('market higher than the experts reads as sell-high', () => {
  const ecr = ecrPool([{ sleeperId: 'y', name: 'Sell Guy', position: 'WR', positionRank: 30, ecr: 70, stdDev: 9 }]);
  const marketRanks = new Map([...ecr.keys()].map((id, i) => [id, i + 1]));
  marketRanks.set('y', 4);
  const rows = arbitrage({ ecr, marketRanks });
  assert.equal(rows.find(r => r.sleeperId === 'y').signal, 'sell');
});

test('small disagreements and thin position pools are filtered out', () => {
  const ecr = ecrPool([{ sleeperId: 'z', name: 'Close Enough', position: 'WR', positionRank: 9, ecr: 30 }]);
  const marketRanks = new Map([...ecr.keys()].map((id, i) => [id, i + 1]));
  marketRanks.set('z', 11);
  assert.equal(arbitrage({ ecr, marketRanks }).some(r => r.sleeperId === 'z'), false, 'a two-spot gap is noise');

  const thin = new Map([['t1', { sleeperId: 't1', name: 'Lonely K', position: 'K', positionRank: 1 }]]);
  assert.deepEqual(arbitrage({ ecr: thin, marketRanks: new Map([['t1', 20]]) }), [], 'four kickers is not a signal');
});

test('a player the market has not priced is skipped', () => {
  const ecr = ecrPool([{ sleeperId: 'unpriced', name: 'Deep Stash', position: 'WR', positionRank: 40, ecr: 200 }]);
  const marketRanks = new Map([...ecr.keys()].filter(k => k !== 'unpriced').map((id, i) => [id, i + 1]));
  assert.equal(arbitrage({ ecr, marketRanks }).some(r => r.sleeperId === 'unpriced'), false);
});

test('tight expert consensus reads as higher confidence than wide disagreement', () => {
  const tight = ecrPool([{ sleeperId: 'a1', name: 'Agreed', position: 'WR', positionRank: 5, ecr: 12, stdDev: 2 }]);
  const wide = ecrPool([{ sleeperId: 'a1', name: 'Contested', position: 'WR', positionRank: 5, ecr: 12, stdDev: 40 }]);
  const marketRanks = new Map([...tight.keys()].map((id, i) => [id, i + 1]));
  marketRanks.set('a1', 30);
  const tightRow = arbitrage({ ecr: tight, marketRanks }).find(r => r.sleeperId === 'a1');
  const wideRow = arbitrage({ ecr: wide, marketRanks }).find(r => r.sleeperId === 'a1');
  assert.ok(tightRow.confidence > wideRow.confidence);
});


// --- coverage --------------------------------------------------------------

test('coverage reports how thin a limited board is', () => {
  const summary = coverageSummary({
    public_api_limited: true,
    tier: 'free',
    coverage: { QB: { returned: 10, total: 80 }, RB: { returned: 10, total: 142 } },
    players: new Array(20)
  });
  assert.equal(summary.limited, true);
  assert.equal(summary.returned, 20);
  assert.equal(summary.total, 222);
  assert.ok(summary.share < 0.1, 'twenty of two hundred is a small slice');
  assert.deepEqual(summary.positions, ['QB', 'RB']);
});

test('coverage falls back to the payload when no per-position data exists', () => {
  const summary = coverageSummary({ players: new Array(441), count: 441 });
  assert.equal(summary.limited, false);
  assert.equal(summary.share, 1);
});

test('a failed position does not inflate the coverage count', () => {
  const summary = coverageSummary({
    coverage: { QB: { returned: 10, total: 80 }, TE: { error: 502 } }
  });
  assert.equal(summary.returned, 10);
  assert.equal(summary.total, 80);
});

test('thresholds loosen when the board is shallow', () => {
  const limited = arbitrageThresholds({ limited: true });
  const full = arbitrageThresholds({ limited: false });
  assert.ok(limited.minDelta < full.minDelta, 'a three-spot gap matters more in a ten-deep pool');
  assert.ok(limited.minPool < full.minPool);
});

test('a shallow pool still surfaces a real positional disagreement', () => {
  const ecr = new Map();
  for (let i = 1; i <= 10; i++) {
    ecr.set(`rb${i}`, { sleeperId: `rb${i}`, name: `RB ${i}`, position: 'RB', positionRank: i, ecr: i, stdDev: 3 });
  }
  const marketRanks = new Map([...ecr.keys()].map((id, i) => [id, i + 1]));
  marketRanks.set('rb8', 3);
  const { minPool, minDelta } = arbitrageThresholds({ limited: true });
  const rows = arbitrage({ ecr, marketRanks, minPool, minDelta });
  const found = rows.find(r => r.sleeperId === 'rb8');
  assert.equal(found.signal, 'sell', 'market RB3, experts RB8');
  assert.equal(found.delta, -5);
});


// --- projections -----------------------------------------------------------

test('both endpoint schemas normalise to the same shape', () => {
  const ranking = normalizeRow({ player_name: 'Bijan Robinson', player_position_id: 'RB', player_team_id: 'ATL', player_id: 23133 });
  const projection = normalizeRow({ name: 'Bijan Robinson', position_id: 'RB', team_id: 'ATL', fpid: 23133 });
  assert.deepEqual(ranking, projection);
});

test('the scoring variant is chosen by field, not by the query parameter', () => {
  assert.equal(projectionPointsField('PPR'), 'points_ppr');
  assert.equal(projectionPointsField('HALF'), 'points_half');
  assert.equal(projectionPointsField('STD'), 'points');
});

// Real payload shape from the projections endpoint.
const gibbs = {
  fpid: 22968,
  name: 'Jahmyr Gibbs',
  position_id: 'RB',
  team_id: 'DET',
  stats: { points: 17.47, points_ppr: 21.4, points_half: 19.43, rush_att: 16.82 }
};

test('PPR leagues get the PPR projection, not the standard one', () => {
  const ppr = extractProjectedPoints(gibbs, 'PPR');
  assert.equal(ppr.points, 21.4);
  assert.equal(ppr.sourceField, 'stats.points_ppr');
  assert.equal(ppr.exact, true);
});

test('half and standard leagues get their own variants', () => {
  assert.equal(extractProjectedPoints(gibbs, 'HALF').points, 19.43);
  assert.equal(extractProjectedPoints(gibbs, 'STD').points, 17.47);
});

test('a missing preferred variant falls back and flags itself inexact', () => {
  const stdOnly = { name: 'Someone', position_id: 'RB', stats: { points: 12.5 } };
  const result = extractProjectedPoints(stdOnly, 'PPR');
  assert.equal(result.points, 12.5);
  assert.equal(result.exact, false, 'caller can report that scoring was approximated');
});

test('an unrecognised payload reports null rather than projecting zero', () => {
  assert.deepEqual(extractProjectedPoints({ stats: { rush_att: 12 } }, 'PPR'), { points: null, sourceField: null, exact: false });
  assert.deepEqual(extractProjectedPoints({}, 'PPR'), { points: null, sourceField: null, exact: false });
});

test('a genuine zero projection is distinguished from a missing field', () => {
  const result = extractProjectedPoints({ stats: { points_ppr: 0 } }, 'PPR');
  assert.equal(result.points, 0);
  assert.equal(result.sourceField, 'stats.points_ppr');
});

test('projections match onto Sleeper ids using the projection schema', () => {
  const index = buildNameIndex({
    '100': { full_name: 'Jahmyr Gibbs', position: 'RB' },
    '200': { full_name: 'Bijan Robinson', position: 'RB' }
  });
  const { projections, fields, missing, inexactScoring } = matchProjections([
    gibbs,
    { fpid: 23133, name: 'Bijan Robinson', position_id: 'RB', team_id: 'ATL', stats: { points: 15.87, points_ppr: 20.23, points_half: 18.05 } }
  ], index, 'PPR');
  assert.equal(projections.get('100').points, 21.4);
  assert.equal(projections.get('100').team, 'DET');
  assert.equal(projections.get('200').points, 20.23);
  assert.deepEqual(fields, ['stats.points_ppr']);
  assert.equal(missing, 0);
  assert.equal(inexactScoring, 0);
});

test('rows with no usable projection are counted, not silently dropped', () => {
  const index = buildNameIndex({ '100': { full_name: 'Jahmyr Gibbs', position: 'RB' } });
  const { projections, missing } = matchProjections([
    { name: 'Jahmyr Gibbs', position_id: 'RB', stats: { rush_att: 16 } }
  ], index, 'PPR');
  assert.equal(projections.size, 0);
  assert.equal(missing, 1);
});

test('start/sit advice names the swaps and the points at stake', () => {
  const byId = new Map([
    ['a', { sleeperId: 'a', name: 'Bench Star', points: 18 }],
    ['b', { sleeperId: 'b', name: 'Sitting Dud', points: 6 }],
    ['c', { sleeperId: 'c', name: 'Fine Where He Is', points: 14 }]
  ]);
  const advice = startSitAdvice({
    optimalIds: new Set(['a', 'c']),
    startedIds: ['b', 'c'],
    byId
  });
  assert.deepEqual(advice.start.map(p => p.name), ['Bench Star']);
  assert.deepEqual(advice.sit.map(p => p.name), ['Sitting Dud']);
  assert.equal(advice.delta, 12);
});

test('an already optimal lineup produces no advice', () => {
  const byId = new Map([['a', { sleeperId: 'a', name: 'Starter', points: 18 }]]);
  const advice = startSitAdvice({ optimalIds: new Set(['a']), startedIds: ['a'], byId });
  assert.equal(advice.start.length, 0);
  assert.equal(advice.sit.length, 0);
  assert.equal(advice.delta, 0);
});


test('a premium board is not treated as limited just because the flag says so', () => {
  // The premium tier returns the full board while still setting the flag.
  const summary = coverageSummary({
    public_api_limited: true,
    tier: 'premium',
    players: new Array(441),
    count: 441
  });
  assert.equal(summary.limited, false, 'the flag alone must not trigger fan-out');
  assert.equal(arbitrageThresholds(summary).minDelta, 5, 'full-depth thresholds apply');
});
