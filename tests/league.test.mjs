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
  aggregateLeagueSummaries,
  avatarUrl,
  leagueFormatBadges,
  playoffPicture,
  matchupState,
  luckRead
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

test('removing a league leaves the rest in order', () => {
  const list = [{ leagueId: 'a' }, { leagueId: 'b' }, { leagueId: 'c' }];
  assert.deepEqual(removeRecentLeague(list, 'b').map(l => l.leagueId), ['a', 'c']);
});

test('removing the only league leaves an empty list, not a broken one', () => {
  assert.deepEqual(removeRecentLeague([{ leagueId: 'a' }], 'a'), []);
  assert.deepEqual(removeRecentLeague([], 'a'), []);
  assert.deepEqual(removeRecentLeague(null, 'a'), []);
});

test('removing a league that was never in the list changes nothing', () => {
  const list = [{ leagueId: 'a' }];
  assert.deepEqual(removeRecentLeague(list, 'nope'), list);
});

test('the next league in the list is the natural handover target', () => {
  // forgetLeague hands over to remaining[0] when the open league is removed.
  const remaining = removeRecentLeague(
    [{ leagueId: 'open' }, { leagueId: 'next', name: 'Next Up' }, { leagueId: 'other' }],
    'open'
  );
  assert.equal(remaining[0].leagueId, 'next');
  assert.equal(remaining[0].name, 'Next Up');
});

// --- hero card metadata ----------------------------------------------------

test('avatar urls are built for Sleeper CDN', () => {
  assert.equal(avatarUrl('abc123'), 'https://sleepercdn.com/avatars/thumbs/abc123');
  assert.equal(avatarUrl('abc123', { thumb: false }), 'https://sleepercdn.com/avatars/abc123');
  assert.equal(avatarUrl(null), null);
});

test('format badges describe the league at a glance', () => {
  const badges = leagueFormatBadges({
    total_rosters: 12,
    roster_positions: ['QB', 'RB', 'WR', 'SUPER_FLEX', 'BN'],
    scoring_settings: { rec: 1 },
    settings: { type: 2 }
  });
  assert.deepEqual(badges, ['12 team', 'Superflex', 'PPR', 'Dynasty']);
});

test('a redraft standard league gets a minimal badge set', () => {
  const badges = leagueFormatBadges({
    total_rosters: 10,
    roster_positions: ['QB', 'RB', 'WR'],
    scoring_settings: {},
    settings: { type: 0 }
  });
  assert.deepEqual(badges, ['10 team', 'Standard']);
});

test('IDP is flagged from the lineup', () => {
  const badges = leagueFormatBadges({ total_rosters: 12, roster_positions: ['QB', 'LB', 'DB'], scoring_settings: { rec: 0.5 } });
  assert.ok(badges.includes('IDP'));
  assert.ok(badges.includes('0.5 PPR'));
});

test('a missing league produces no badges rather than throwing', () => {
  assert.deepEqual(leagueFormatBadges(null), []);
});

test('the playoff read says what the rank actually means', () => {
  assert.equal(playoffPicture(1, 6, 12).label, 'Top seed');
  assert.equal(playoffPicture(6, 6, 12).label, 'Last playoff spot');
  assert.equal(playoffPicture(3, 6, 12).in, true);
  assert.equal(playoffPicture(7, 6, 12).label, 'First team out');
  assert.equal(playoffPicture(9, 6, 12).label, '3 spots out', 'ninth with six spots is three out');
  assert.equal(playoffPicture(12, 6, 12).label, 'Bottom of the league');
});

test('an unknown rank or playoff size yields no read', () => {
  assert.equal(playoffPicture(null, 6, 12), null);
  assert.equal(playoffPicture(3, null, 12), null);
});

test('the matchup state reads the scoreboard', () => {
  assert.equal(matchupState({ myScore: 110, opponentScore: 90, opponent: 'Them' }).label, 'Up 20.0');
  assert.equal(matchupState({ myScore: 80, opponentScore: 95, opponent: 'Them' }).tone, 'bad');
  assert.equal(matchupState({ myScore: 0, opponentScore: 0, opponent: 'Them' }).label, 'Not started');
  assert.equal(matchupState({ myScore: 100, opponentScore: 100, opponent: 'Them' }).label, 'Dead even');
});

test('a bye week has no matchup state', () => {
  assert.equal(matchupState({ myScore: 90, opponentScore: null, opponent: null }), null);
  assert.equal(matchupState({}), null);
});

test('scoring well with a bad record reads as unlucky', () => {
  assert.equal(luckRead(9, 3).tone, 'bad');
  assert.match(luckRead(9, 3).label, /Unlucky/);
  assert.equal(luckRead(2, 8).tone, 'warn');
  assert.equal(luckRead(4, 5), null, 'a small gap is not a story');
});

test('the summary carries what a hero card needs', () => {
  const summary = summarizeLeagueForUser({
    league: { ...league, settings: { playoff_teams: 6, type: 2 }, roster_positions: ['QB', 'RB', 'WR'], scoring_settings: { rec: 1 } },
    rosters, users, userId: 'me', countEmptySlots,
    matchups: [{ roster_id: 1, matchup_id: 1, points: 88.5, starters: ['1'] }]
  });
  assert.equal(summary.teamName, 'My Team');
  assert.equal(summary.playoffTeams, 6);
  assert.equal(summary.pointsForRank, 2, 'second in scoring');
  assert.ok(summary.badges.includes('Dynasty'));
});
