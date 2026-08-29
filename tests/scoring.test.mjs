import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectScoringFormat,
  describeScoring,
  nflversePoints,
  formatMatchesSource
} from '../scoring.js';

test('the three common formats are detected from points per reception', () => {
  assert.equal(detectScoringFormat({ rec: 1 }).key, 'PPR');
  assert.equal(detectScoringFormat({ rec: 0.5 }).key, 'HALF');
  assert.equal(detectScoringFormat({ rec: 0 }).key, 'STD');
});

test('a league with no reception scoring at all is standard', () => {
  assert.equal(detectScoringFormat({}).key, 'STD');
  assert.equal(detectScoringFormat().key, 'STD');
  assert.equal(detectScoringFormat({ rec: null }).key, 'STD');
});

test('an unusual reception value maps to the nearest published variant', () => {
  const odd = detectScoringFormat({ rec: 0.75 });
  assert.equal(odd.key, 'HALF', 'closest thing any source publishes');
  assert.equal(odd.exact, false, 'but flagged as not an exact match');
  assert.equal(detectScoringFormat({ rec: 1.5 }).key, 'PPR');
});

test('TE premium is detected because no external source publishes it', () => {
  const format = detectScoringFormat({ rec: 1, bonus_rec_te: 0.5 });
  assert.equal(format.key, 'PPR');
  assert.equal(format.teBonus, 0.5);
  assert.equal(formatMatchesSource(format), false, 'projections will be slightly off for tight ends');
});

test('a plain format matches external sources cleanly', () => {
  assert.equal(formatMatchesSource(detectScoringFormat({ rec: 0.5 })), true);
  assert.equal(formatMatchesSource(detectScoringFormat({ rec: 0.4 })), false);
});

test('the standard label reads as words, not an api code', () => {
  assert.equal(describeScoring(detectScoringFormat({})), 'Standard');
});

test('the label says what was detected', () => {
  assert.equal(describeScoring(detectScoringFormat({ rec: 0.5 })), '0.5 PPR');
  assert.equal(describeScoring(detectScoringFormat({ rec: 1, bonus_rec_te: 0.5 })), 'PPR · TE premium +0.5');
  assert.equal(describeScoring(detectScoringFormat({ rec: 0.75 })), '0.75 per reception');
  assert.equal(describeScoring(null), '');
});

// nflverse publishes standard and PPR but not half.
const row = { pointsStd: 10, pointsPpr: 16, receptions: 6 };

test('nflverse points are served in the league format', () => {
  assert.equal(nflversePoints(row, 'PPR'), 16);
  assert.equal(nflversePoints(row, 'STD'), 10);
  assert.equal(nflversePoints(row, 'HALF'), 13, 'standard plus half a point per reception');
});

test('half is derived rather than approximated when receptions are known', () => {
  const half = nflversePoints({ pointsStd: 8.4, pointsPpr: 12.4, receptions: 4 }, 'HALF');
  assert.equal(half, 10.4);
});

test('half still resolves from the two totals when receptions are missing', () => {
  assert.equal(nflversePoints({ pointsStd: 10, pointsPpr: 16 }, 'HALF'), 13);
});

test('standard is recovered from PPR when the standard column is missing', () => {
  assert.equal(nflversePoints({ pointsPpr: 16, receptions: 6 }, 'STD'), 10);
});

test('a row with nothing usable returns null rather than zero', () => {
  assert.equal(nflversePoints({}, 'PPR'), null);
  assert.equal(nflversePoints({}, 'HALF'), null);
});
