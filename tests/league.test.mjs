import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLeagueInput,
  isValidLeagueId,
  normalizeUsername,
  upsertRecentLeague,
  removeRecentLeague,
  summarizeLeagueForUser,
  sortLeagueSummaries,
  aggregateLeagueSummaries
} from '../league.js';
import { countEmptySlots } from '../pulse.js';

test('a bare league id is accepted', () => {
  assert.equal(parseLeagueInput('1326583431680761856'), '1326583431680761856');
  assert.equal(parseLeagueInput('  1326583431680761856  '), '1326583431680761856');
});

test('a pasted Sleeper url works, which is what people actually copy', () => {
  assert.equal(parseLeagueInput('https://sleeper.com/leagues/1326583431680761856/team'), '1326583431680761856');
  assert.equal(parseLeagueInput('sleeper.app/leagues/1326583431680761856'), '1326583431680761856');
  assert.equal(parseLeagueInput('https://sleeper.com/leagues/1326583431680761856/matchup?week=3'), '1326583431680761856');
});

test('junk returns nothing rather than a bad id', () => {
  assert.equal(parseLeagueInput('not a league'), null);
  assert.equal(parseLeagueInput(''), null);
  assert.equal(parseLeagueInput('12345'), null, 'too short to be a Sleeper id');
});

test('id validation is strict', () => {
  assert.equal(isValidLeagueId('1326583431680761856'), true);
  assert.equal(isValidLeagueId('abc'), false);
  assert.equal(isValidLeagueId(null), false);
});

test('usernames normalise the way people type them', () => {
  assert.equal(normalizeUsername('@ChrisM '), 'chrism');
  assert.equal(normalizeUsername('ChrisM'), 'chrism');
});

test('reopening a league moves it up rather than duplicating', () => {
  let list = upsertRecentLeague([], { leagueId: 'a', name: 'A' });
  list = upsertRecentLeague(list, { leagueId: 'b', name: 'B' });
  list = upsertRecentLeague(list, { leagueId: 'a', name: 'A' });
  assert.deepEqual(list.map(l => l.leagueId), ['a', 'b']);
});

test('the recents list is capped', () => {
  let list = [];
  for (let i = 0; i < 20; i++) list = upsertRecentLeague(list, { leagueId: `l${i}` }, 5);
  assert.equal(list.length, 5);
  assert.equal(list[0].leagueId, 'l19');
});

test('a league can be removed from recents', () => {
  const list = [{ leagueId: 'a' }, { leagueId: 'b' }];
  assert.deepEqual(removeRecentLeague(list, 'a').map(l => l.leagueId), ['b']);
});

const league = { league_id: '99', name: 'Dynasty of Legends', season: '2026', total_rosters: 4 };
const users = [
  { user_id: 'me', display_name: 'Me', metadata: { team_name: 'My Team' } },
  { user_id: 'them', display_name: 'Them', metadata: { team_name: 'Their Team' } }
];
const rosters = [
  { roster_id: 1, owner_id: 'me', settings: { wins: 5, losses: 2, fpts: 900, fpts_decimal: 50 } },
  { roster_id: 2, owner_id: 'them', settings: { wins: 6, losses: 1, fpts: 950 } },
  { roster_id: 3, owner_id: 'other', settings: { wins: 2, losses: 5, fpts: 700 } },
  { roster_id: 4, owner_id: 'fourth', settings: { wins: 1, losses: 6, fpts: 600 } }
];

test('a league summarises to standing, opponent and lineup health', () => {
  const summary = summarizeLeagueForUser({
    league, rosters, users, userId: 'me', countEmptySlots,
    matchups: [
      { roster_id: 1, matchup_id: 1, points: 88.5, starters: ['1', '2', '3'] },
      { roster_id: 2, matchup_id: 1, points: 102.2, starters: ['4', '5', '6'] }
    ]
  });
  assert.equal(summary.inLeague, true);
  assert.equal(summary.wins, 5);
  assert.equal(summary.pointsFor, 900.5, 'decimal points are folded in');
  assert.equal(summary.rank, 2, 'behind the 6-1 team');
  assert.equal(summary.opponent, 'Their Team');
  assert.equal(summary.myScore, 88.5);
  assert.equal(summary.opponentScore, 102.2);
  assert.equal(summary.needsAttention, false);
});

test('an unfilled lineup slot flags the league for attention', () => {
  const summary = summarizeLeagueForUser({
    league, rosters, users, userId: 'me', countEmptySlots,
    matchups: [{ roster_id: 1, matchup_id: 1, points: 40, starters: ['1', '0', '0'] }]
  });
  assert.equal(summary.emptySlots, 2);
  assert.equal(summary.needsAttention, true);
});

test('a league the user is not in still summarises', () => {
  const summary = summarizeLeagueForUser({ league, rosters, users, userId: 'stranger', countEmptySlots });
  assert.equal(summary.inLeague, false);
  assert.equal(summary.rank, null);
  assert.equal(summary.wins, null);
  assert.equal(summary.teams, 4);
});

test('a missing league returns nothing rather than a broken card', () => {
  assert.equal(summarizeLeagueForUser({ league: null }), null);
  assert.equal(summarizeLeagueForUser({}), null);
});

test('a bye week with no opponent does not invent one', () => {
  const summary = summarizeLeagueForUser({
    league, rosters, users, userId: 'me', countEmptySlots,
    matchups: [{ roster_id: 1, matchup_id: null, points: 0, starters: ['1'] }]
  });
  assert.equal(summary.opponent, null);
  assert.equal(summary.opponentScore, null);
});

test('leagues needing attention sort to the top', () => {
  const rows = sortLeagueSummaries([
    { name: 'Winning', inLeague: true, rank: 1, needsAttention: false },
    { name: 'Broken lineup', inLeague: true, rank: 8, needsAttention: true },
    { name: 'Spectating', inLeague: false, rank: null, needsAttention: false }
  ]);
  assert.deepEqual(rows.map(r => r.name), ['Broken lineup', 'Winning', 'Spectating']);
});

test('totals summarise every league at once', () => {
  const totals = aggregateLeagueSummaries([
    { inLeague: true, wins: 5, losses: 2, rank: 1, needsAttention: false },
    { inLeague: true, wins: 3, losses: 4, rank: 6, needsAttention: true },
    { inLeague: false, needsAttention: false }
  ]);
  assert.equal(totals.leagues, 3);
  assert.equal(totals.playing, 2);
  assert.equal(totals.wins, 8);
  assert.equal(totals.losses, 6);
  assert.equal(totals.attention, 1);
  assert.equal(totals.firstPlace, 1);
});

test('no leagues yields zeroes rather than dividing by nothing', () => {
  const totals = aggregateLeagueSummaries([]);
  assert.equal(totals.leagues, 0);
  assert.equal(totals.winPct, null);
});
