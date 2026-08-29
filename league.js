// League selection, recents, and the cross-league dashboard.
//
// Everything the app knew was hardcoded to one league. This is the layer that
// makes it work for any Sleeper league, and for several at once.
//
// Pure: no DOM, no network.

import { detectScoringFormat, describeScoring } from './scoring.js';

const ID_PATTERN = /^\d{6,25}$/;

/**
 * Accept whatever someone pastes.
 *
 * People copy the URL from the Sleeper app far more often than they dig out the
 * raw id, so both work, along with a bare id and a URL with extra path segments
 * or query strings hanging off it.
 */
export function parseLeagueInput(text = '') {
  const raw = String(text).trim();
  if (!raw) return null;
  if (ID_PATTERN.test(raw)) return raw;

  const fromUrl = raw.match(/leagues?\/(\d{6,25})/i);
  if (fromUrl) return fromUrl[1];

  // A bare number with stray characters around it, e.g. a pasted quote.
  const loose = raw.match(/(\d{6,25})/);
  return loose ? loose[1] : null;
}

export function isValidLeagueId(id) {
  return ID_PATTERN.test(String(id || ''));
}

/** Sleeper usernames are case-insensitive and people paste them with @ or spaces. */
export function normalizeUsername(text = '') {
  return String(text).trim().replace(/^@/, '').toLowerCase();
}

/**
 * Recently opened leagues, newest first, deduplicated by id.
 * Re-opening a league moves it to the top rather than adding a second entry.
 */
export function upsertRecentLeague(list = [], entry, max = 12) {
  if (!entry?.leagueId) return Array.isArray(list) ? list.slice(0, max) : [];
  const rest = (Array.isArray(list) ? list : []).filter(item => item?.leagueId !== entry.leagueId);
  return [{ ...entry, openedAt: entry.openedAt || Date.now() }, ...rest].slice(0, max);
}

export function removeRecentLeague(list = [], leagueId) {
  return (Array.isArray(list) ? list : []).filter(item => item?.leagueId !== leagueId);
}

const scoreOf = (settings, key) => {
  const whole = Number(settings?.[key]) || 0;
  const decimal = Number(settings?.[`${key}_decimal`]) || 0;
  return whole + decimal / 100;
};

/**
 * One league reduced to what matters at a glance: where this manager stands,
 * who they are playing, and whether anything needs attention right now.
 *
 * `emptySlots` is the actionable one. Everything else is context; an unfilled
 * lineup slot is a problem you can fix from the summary.
 */
export function summarizeLeagueForUser({
  league,
  rosters = [],
  users = [],
  matchups = [],
  userId,
  countEmptySlots = () => 0
} = {}) {
  if (!league) return null;

  const mine = rosters.find(r => r.owner_id === userId) || null;
  const userById = new Map(users.map(u => [u.user_id, u]));
  const ownerByRoster = new Map(rosters.map(r => [Number(r.roster_id), r.owner_id]));

  const standings = [...rosters]
    .map(r => ({
      rosterId: Number(r.roster_id),
      ownerId: r.owner_id,
      wins: Number(r.settings?.wins) || 0,
      losses: Number(r.settings?.losses) || 0,
      pointsFor: scoreOf(r.settings, 'fpts')
    }))
    .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);

  const rank = mine ? standings.findIndex(s => s.rosterId === Number(mine.roster_id)) + 1 : null;

  let opponent = null;
  let myScore = null;
  let opponentScore = null;
  let emptySlots = 0;

  if (mine) {
    const myEntry = matchups.find(m => Number(m.roster_id) === Number(mine.roster_id));
    if (myEntry) {
      myScore = Number(myEntry.points) || 0;
      emptySlots = countEmptySlots(myEntry.starters || []);
      if (myEntry.matchup_id != null) {
        const theirs = matchups.find(m => m.matchup_id === myEntry.matchup_id && Number(m.roster_id) !== Number(mine.roster_id));
        if (theirs) {
          opponentScore = Number(theirs.points) || 0;
          const ownerId = ownerByRoster.get(Number(theirs.roster_id));
          const user = ownerId ? userById.get(ownerId) : null;
          opponent = user?.metadata?.team_name || user?.display_name || 'Opponent';
        }
      }
    }
  }

  const pointsOrder = [...standings].sort((a, b) => b.pointsFor - a.pointsFor);
  const pointsForRank = mine ? pointsOrder.findIndex(s => s.rosterId === Number(mine.roster_id)) + 1 : null;
  const me = mine ? userById.get(mine.owner_id) : null;

  return {
    leagueId: league.league_id,
    name: league.name || 'Untitled league',
    season: league.season,
    avatar: league.avatar || null,
    teamName: me?.metadata?.team_name || me?.display_name || null,
    teamAvatar: me?.metadata?.avatar || (me?.avatar ? avatarUrl(me.avatar) : null),
    badges: leagueFormatBadges(league),
    playoffTeams: Number(league.settings?.playoff_teams) || null,
    pointsForRank,
    teams: rosters.length || Number(league.total_rosters) || 0,
    status: league.status || null,
    inLeague: Boolean(mine),
    rosterId: mine ? Number(mine.roster_id) : null,
    wins: mine ? Number(mine.settings?.wins) || 0 : null,
    losses: mine ? Number(mine.settings?.losses) || 0 : null,
    ties: mine ? Number(mine.settings?.ties) || 0 : null,
    pointsFor: mine ? scoreOf(mine.settings, 'fpts') : null,
    rank,
    opponent,
    myScore,
    opponentScore,
    emptySlots,
    needsAttention: emptySlots > 0
  };
}

/**
 * Leagues that need attention float to the top. Below that, sort by standing,
 * because the league you are winning is the one you want to look at.
 */
export function sortLeagueSummaries(rows = []) {
  return [...rows].filter(Boolean).sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    if (a.inLeague !== b.inLeague) return a.inLeague ? -1 : 1;
    return (a.rank ?? 99) - (b.rank ?? 99) || String(a.name).localeCompare(String(b.name));
  });
}

/** Totals across every league, for the dashboard header. */
export function aggregateLeagueSummaries(rows = []) {
  const mine = rows.filter(r => r?.inLeague);
  const wins = mine.reduce((n, r) => n + (r.wins || 0), 0);
  const losses = mine.reduce((n, r) => n + (r.losses || 0), 0);
  return {
    leagues: rows.length,
    playing: mine.length,
    wins,
    losses,
    winPct: wins + losses ? wins / (wins + losses) : null,
    attention: rows.filter(r => r?.needsAttention).length,
    firstPlace: mine.filter(r => r.rank === 1).length
  };
}

// --- hero card metadata ----------------------------------------------------

/** Sleeper's avatar CDN. Thumbnails are enough for a card. */
export function avatarUrl(avatar, { thumb = true } = {}) {
  if (!avatar) return null;
  return `https://sleepercdn.com/avatars/${thumb ? 'thumbs/' : ''}${avatar}`;
}

/**
 * The short format badges that tell you what kind of league this is at a
 * glance: size, superflex, scoring, and whether it keeps players year to year.
 */
export function leagueFormatBadges(league) {
  if (!league) return [];
  const badges = [];
  const teams = Number(league.total_rosters) || 0;
  if (teams) badges.push(`${teams} team`);

  const slots = league.roster_positions || [];
  const superflex = slots.includes('SUPER_FLEX') || slots.filter(s => s === 'QB').length > 1;
  if (superflex) badges.push('Superflex');

  const scoring = describeScoring(detectScoringFormat(league.scoring_settings || {}));
  if (scoring) badges.push(scoring);

  const type = Number(league.settings?.type);
  if (type === 2) badges.push('Dynasty');
  else if (type === 1) badges.push('Keeper');

  if (slots.some(s => ['DL', 'LB', 'DB', 'IDP_FLEX'].includes(s))) badges.push('IDP');
  return badges;
}

/**
 * Where this team sits relative to the playoff cut.
 *
 * "6th of 12" means nothing on its own; "last playoff spot" and "one out" are
 * the readings that actually matter in October.
 */
export function playoffPicture(rank, playoffTeams, totalTeams) {
  const spot = Number(rank);
  const cut = Number(playoffTeams);
  if (!Number.isFinite(spot) || !Number.isFinite(cut) || cut <= 0) return null;
  if (spot <= 0) return null;

  if (spot === 1) return { in: true, tone: 'good', label: 'Top seed' };
  if (spot <= cut) {
    const cushion = cut - spot;
    if (cushion === 0) return { in: true, tone: 'warn', label: 'Last playoff spot' };
    return { in: true, tone: 'good', label: `Playoff spot ${spot} of ${cut}` };
  }
  const outBy = spot - cut;
  if (outBy === 1) return { in: false, tone: 'warn', label: 'First team out' };
  const total = Number(totalTeams) || 0;
  if (total && spot === total) return { in: false, tone: 'bad', label: 'Bottom of the league' };
  return { in: false, tone: 'bad', label: `${outBy} spots out` };
}

/** How this week is actually going. */
export function matchupState({ myScore, opponentScore, opponent } = {}) {
  if (!opponent || myScore == null || opponentScore == null) return null;
  if (myScore === 0 && opponentScore === 0) return { tone: 'idle', label: 'Not started' };
  const margin = myScore - opponentScore;
  if (Math.abs(margin) < 0.05) return { tone: 'warn', label: 'Dead even' };
  return {
    tone: margin > 0 ? 'good' : 'bad',
    label: `${margin > 0 ? 'Up' : 'Down'} ${Math.abs(margin).toFixed(1)}`,
    margin
  };
}

/**
 * Whether the record matches the scoring.
 *
 * A team scoring well with a bad record has been unlucky, and saying so on the
 * card is more useful than another number.
 */
export function luckRead(rank, pointsForRank) {
  const standing = Number(rank);
  const scoring = Number(pointsForRank);
  if (!Number.isFinite(standing) || !Number.isFinite(scoring)) return null;
  const gap = standing - scoring;
  if (gap >= 3) return { tone: 'bad', label: `Unlucky: ${scoring} in scoring, ${standing} in the table` };
  if (gap <= -3) return { tone: 'warn', label: `Fortunate: ${standing} in the table, ${scoring} in scoring` };
  return null;
}
