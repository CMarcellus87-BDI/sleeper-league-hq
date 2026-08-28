import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  matchKey,
  buildNameIndex,
  matchRankings,
  parsePositionRank,
  marketPositionRanks,
  arbitrage
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
