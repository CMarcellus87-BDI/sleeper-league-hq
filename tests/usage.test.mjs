import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  normalizeUsageRow,
  aggregateUsage,
  mergeSnapCounts,
  usageTrend,
  risingUsage,
  fadingUsage,
  crossReferenceTrending
} from '../usage.js';

test('csv parses into objects keyed by header', () => {
  const rows = parseCsv('player_id,week,targets\n00-001,1,7\n00-002,1,3\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { player_id: '00-001', week: '1', targets: '7' });
});

test('quoted fields containing commas survive parsing', () => {
  const rows = parseCsv('name,team\n"Smith, Jr., Steve",DET\n');
  assert.equal(rows[0].name, 'Smith, Jr., Steve');
  assert.equal(rows[0].team, 'DET');
});

test('escaped quotes and trailing newlines are handled', () => {
  assert.equal(parseCsv('a\n"say ""hi"""\n')[0].a, 'say "hi"');
  assert.equal(parseCsv('a,b\n1,2').length, 1, 'a missing trailing newline still yields the row');
});

test("nflverse's NA marker becomes null, not zero", () => {
  const row = normalizeUsageRow({ player_id: '00-1', target_share: 'NA', offense_pct: '0.75', targets: '0' });
  assert.equal(row.targetShare, null, 'NA must not be read as a real zero share');
  assert.equal(row.snapPct, 0.75);
  assert.equal(row.targets, 0, 'a genuine zero is preserved');
});

test('scoring format decides which points column is used', () => {
  const rows = [{ player_id: '00-1', player_display_name: 'A Back', position: 'RB', season: '2025', week: '1',
    fantasy_points: '10', fantasy_points_ppr: '16', receptions: '6' }];
  assert.equal(aggregateUsage(rows).get('00-1').weeks[0].points, 16, 'PPR by default');
  const half = aggregateUsage(rows, r => r.pointsStd + r.receptions * 0.5);
  assert.equal(half.get('00-1').weeks[0].points, 13);
});

test('rows group per player in week order', () => {
  const usage = aggregateUsage([
    { player_id: '00-1', player_display_name: 'A Back', position: 'RB', recent_team: 'DET', season: '2025', week: '3', targets: '4' },
    { player_id: '00-1', player_display_name: 'A Back', position: 'RB', recent_team: 'DET', season: '2025', week: '1', targets: '2' }
  ]);
  const entry = usage.get('00-1');
  assert.equal(entry.weeks.length, 2);
  assert.deepEqual(entry.weeks.map(w => w.week), [1, 3]);
});

test('snap counts merge in on name and week', () => {
  const usage = aggregateUsage([
    { player_id: '00-1', player_display_name: 'A Back', position: 'RB', season: '2025', week: '1', targets: '5' }
  ]);
  mergeSnapCounts(usage, [{ player: 'A Back', team: 'DET', season: '2025', week: '1', offense_pct: '0.62', offense_snaps: '40' }]);
  assert.equal(usage.get('00-1').weeks[0].snapPct, 0.62);
  assert.equal(usage.get('00-1').weeks[0].snaps, 40);
});

const weeks = n => n.map((snap, i) => ({ week: i + 1, snapPct: snap, targetShare: snap / 4, points: snap * 20 }));

test('trend compares recent form against everything before it', () => {
  const trend = usageTrend(weeks([0.3, 0.35, 0.4, 0.75, 0.8, 0.85]));
  assert.equal(trend.games, 6);
  assert.ok(Math.abs(trend.snapPct.recent - 0.8) < 1e-9);
  assert.ok(Math.abs(trend.snapPct.prior - 0.35) < 1e-9);
  assert.ok(Math.abs(trend.snapPct.delta - 0.45) < 1e-9);
});

test('a trend needs a prior period to compare against', () => {
  const trend = usageTrend(weeks([0.5, 0.6]));
  assert.equal(trend.snapPct.delta, null, 'two games is all recent, so there is no baseline');
  assert.equal(usageTrend([]), null);
});

test('a player with no usable usage data yields no trend', () => {
  assert.equal(usageTrend([{ week: 1, snapPct: null, targetShare: null }]), null);
});

test('rising usage finds real role changes and ignores noise', () => {
  const usage = new Map([
    ['breakout', { key: 'breakout', name: 'Breakout Guy', position: 'WR', weeks: weeks([0.3, 0.3, 0.35, 0.8, 0.85, 0.85]) }],
    ['steady', { key: 'steady', name: 'Steady Guy', position: 'WR', weeks: weeks([0.7, 0.7, 0.72, 0.71, 0.7, 0.7]) }],
    ['deep', { key: 'deep', name: 'Deep Bench', position: 'WR', weeks: weeks([0.03, 0.04, 0.05, 0.14, 0.15, 0.16]) }]
  ]);
  const rows = risingUsage(usage);
  assert.equal(rows[0].name, 'Breakout Guy');
  assert.ok(!rows.some(r => r.name === 'Steady Guy'), 'no change means no signal');
  assert.ok(!rows.some(r => r.name === 'Deep Bench'), '5% to 15% of snaps is still nobody');
});

test('fading usage finds players losing their role', () => {
  const usage = new Map([
    ['fading', { key: 'fading', name: 'Benched Guy', position: 'RB', weeks: weeks([0.8, 0.85, 0.8, 0.3, 0.25, 0.2]) }],
    ['steady', { key: 'steady', name: 'Steady Guy', position: 'RB', weeks: weeks([0.7, 0.7, 0.72, 0.71, 0.7, 0.7]) }]
  ]);
  const rows = fadingUsage(usage);
  assert.equal(rows[0].name, 'Benched Guy');
  assert.equal(rows.length, 1);
});

test('trending players split into available and already rostered', () => {
  const { available, rostered } = crossReferenceTrending(
    [{ player_id: '1', count: 5000 }, { player_id: '2', count: 3000 }],
    {
      rosteredIds: new Set(['2']),
      ownerByPlayer: new Map([['2', 'alice']]),
      describe: id => ({ name: `Player ${id}` })
    }
  );
  assert.deepEqual(available.map(r => r.playerId), ['1']);
  assert.equal(available[0].count, 5000);
  assert.equal(available[0].name, 'Player 1');
  assert.equal(rostered[0].ownerId, 'alice');
});

test('malformed trending entries are skipped', () => {
  const { available } = crossReferenceTrending([{ count: 10 }, null, { player_id: '9', count: 1 }], {});
  assert.deepEqual(available.map(r => r.playerId), ['9']);
});
