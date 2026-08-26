const CONFIG = {
  primaryLeagueId: '1326583431680761856',
  apiBase: 'https://api.sleeper.app/v1',
  maxHistorySeasons: 20,
  maxWeeksPerSeason: 18,
  matchupConcurrency: 3,
  version: '3.0.0'
};

const state = {
  league: null,
  users: [],
  rosters: [],
  history: [],
  matchupsLoaded: false,
  matchupsPromise: null,
  playerMap: null,
  playerMapPromise: null,
  recordsLimit: 10
};

const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];

async function api(path) {
  const response = await fetch(`${CONFIG.apiBase}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

function setApiState(type, text) {
  $('api-status').textContent = text;
  $('api-dot').className = `status-dot${type ? ` ${type}` : ''}`;
}

function showError(message) {
  $('error-banner').textContent = message;
  $('error-banner').classList.remove('hidden');
  setApiState('error', 'Sleeper data error');
}

function clearError() {
  $('error-banner').classList.add('hidden');
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

function scoring(settings, key = 'fpts') {
  if (!settings) return 0;
  return Number(settings[key] || 0) + Number(settings[`${key}_decimal`] || 0) / 100;
}

function managerName(user) {
  return user?.display_name || user?.username || 'Orphan';
}

function franchiseName(user, roster) {
  return user?.metadata?.team_name || user?.display_name || user?.username || `Roster ${roster?.roster_id ?? '?'}`;
}

function rosterRecord(roster) {
  const settings = roster?.settings || {};
  const ties = Number(settings.ties || 0);
  return `${Number(settings.wins || 0)}-${Number(settings.losses || 0)}${ties ? `-${ties}` : ''}`;
}

function rosterTable(item) {
  const users = Object.fromEntries(item.users.map(user => [user.user_id, user]));
  return item.rosters.map(roster => {
    const user = users[roster.owner_id];
    const settings = roster.settings || {};
    return {
      rosterId: Number(roster.roster_id),
      ownerId: roster.owner_id,
      franchise: franchiseName(user, roster),
      manager: managerName(user),
      wins: Number(settings.wins || 0),
      losses: Number(settings.losses || 0),
      ties: Number(settings.ties || 0),
      pf: scoring(settings, 'fpts'),
      pa: scoring(settings, 'fpts_against'),
      moves: Number(settings.total_moves || 0)
    };
  }).sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses) || (b.pf - a.pf));
}

function champion(item) {
  const titleGame = (item.winnersBracket || []).find(game => Number(game.p) === 1 && game.w != null);
  if (!titleGame) return { franchise: item.league.status === 'complete' ? 'Unavailable' : 'TBD', manager: '', record: '—', ownerId: null };
  const roster = item.rosters.find(row => Number(row.roster_id) === Number(titleGame.w));
  const user = roster ? item.users.find(row => row.user_id === roster.owner_id) : null;
  return {
    franchise: roster ? franchiseName(user, roster) : `Roster ${titleGame.w}`,
    manager: managerName(user),
    record: roster ? rosterRecord(roster) : '—',
    ownerId: roster?.owner_id || null
  };
}

function renderCurrentLeague() {
  const item = { league: state.league, users: state.users, rosters: state.rosters };
  const rows = rosterTable(item);
  const status = String(state.league.status || 'unknown').replaceAll('_', ' ');
  $('league-meta').textContent = `${state.league.season} • ${state.league.total_rosters} franchises • ${status}`;
  $('stat-season').textContent = state.league.season || '—';
  $('stat-status').textContent = status;
  $('stat-teams').textContent = state.league.total_rosters || rows.length;

  const leader = rows[0];
  const pointsLeader = [...rows].sort((a, b) => b.pf - a.pf)[0];
  $('stat-leader').textContent = leader?.franchise || '—';
  $('stat-leader-detail').textContent = leader ? `${leader.wins}-${leader.losses}${leader.ties ? `-${leader.ties}` : ''} • ${leader.pf.toFixed(2)} PF` : '—';
  $('stat-pf-leader').textContent = pointsLeader?.franchise || '—';
  $('stat-pf-detail').textContent = pointsLeader ? `${pointsLeader.pf.toFixed(2)} points` : '—';

  $('overview-standings').innerHTML = standingsRowsHtml(rows, false);
}

function standingsRowsHtml(rows, detailed = true) {
  return rows.map((row, index) => `<tr>
    <td class="rank">${index + 1}</td>
    <td class="team-cell"><strong>${escapeHtml(row.franchise)}</strong>${detailed ? '' : `<span>${escapeHtml(row.manager)}</span>`}</td>
    ${detailed ? `<td>${escapeHtml(row.manager)}</td>` : ''}
    <td class="record">${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ''}</td>
    <td>${row.pf.toFixed(2)}</td>
    <td>${row.pa.toFixed(2)}</td>
    ${detailed ? `<td>${row.moves}</td>` : ''}
  </tr>`).join('');
}

function renderStandingsSeason(index = 0) {
  const item = state.history[index] || { league: state.league, users: state.users, rosters: state.rosters };
  $('standings-title').textContent = `${item.league.season} Standings`;
  $('full-standings').innerHTML = standingsRowsHtml(rosterTable(item), true);
}

async function loadHistory() {
  const seasons = [];
  let league = state.league;
  const visited = new Set();

  while (league && !visited.has(league.league_id) && seasons.length < CONFIG.maxHistorySeasons) {
    visited.add(league.league_id);
    const [users, rosters, winnersBracket] = await Promise.all([
      api(`/league/${league.league_id}/users`).catch(() => []),
      api(`/league/${league.league_id}/rosters`).catch(() => []),
      api(`/league/${league.league_id}/winners_bracket`).catch(() => [])
    ]);
    seasons.push({ league, users, rosters, winnersBracket, matchups: [] });

    if (!league.previous_league_id || league.previous_league_id === '0') break;
    try {
      league = await api(`/league/${league.previous_league_id}`);
    } catch {
      break;
    }
  }

  state.history = seasons;
  renderHistory();
  populateSeasonSelect();
  renderStandingsSeason(0);
}

function renderHistory() {
  $('history-count').textContent = state.history.length;
  const rows = state.history.map(item => ({ season: item.league.season, ...champion(item) }));

  const historyRow = (row, ledger = false) => `<div class="history-row${ledger ? ' ledger-row' : ''}">
    <span class="history-year">${escapeHtml(row.season)}</span>
    <span class="history-champ"><strong>${escapeHtml(row.franchise)}</strong><small>${row.manager && row.manager !== row.franchise ? escapeHtml(row.manager) : ''}</small></span>
    <span class="champ-record">${escapeHtml(row.record)}</span>
    <span class="trophy">${row.ownerId ? '🏆' : '—'}</span>
  </div>`;

  $('history-summary').innerHTML = rows.slice(0, 6).map(row => historyRow(row, false)).join('') || '<div class="empty-cell">No linked seasons found.</div>';
  $('history-ledger').innerHTML = rows.map(row => historyRow(row, true)).join('') || '<div class="empty-cell">No linked seasons found.</div>';

  const titleMap = new Map();
  rows.filter(row => row.ownerId).forEach(row => {
    if (!titleMap.has(row.ownerId)) titleMap.set(row.ownerId, { name: row.manager || row.franchise, count: 0, seasons: [] });
    const entry = titleMap.get(row.ownerId);
    entry.count += 1;
    entry.seasons.push(row.season);
  });

  const leaders = [...titleMap.values()].sort((a, b) => b.count - a.count || String(b.seasons[0]).localeCompare(String(a.seasons[0])));
  $('championship-leaders').innerHTML = leaders.length ? leaders.map((entry, index) => `<div class="title-card">
    <span class="medal">${index === 0 ? '♛' : '🏆'}</span>
    <span><strong>${escapeHtml(entry.name)}</strong><small>${entry.seasons.join(' • ')}</small></span>
    <b>${entry.count}</b>
  </div>`).join('') : '<div class="empty-cell">No completed titles found.</div>';
}

function populateSeasonSelect() {
  $('season-select').innerHTML = state.history.map((item, index) => `<option value="${index}">${escapeHtml(item.league.season)}</option>`).join('');
}

function managerDirectory() {
  const managers = new Map();
  state.history.forEach(item => item.users.forEach(user => {
    if (user?.user_id && !managers.has(user.user_id)) managers.set(user.user_id, { id: user.user_id, name: managerName(user) });
  }));
  return [...managers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function regularSeasonEnd(item) {
  const playoffStart = Number(item.league?.settings?.playoff_week_start || 0);
  return playoffStart > 1 ? playoffStart - 1 : 14;
}

async function loadAllMatchups() {
  if (state.matchupsLoaded) return;
  if (state.matchupsPromise) return state.matchupsPromise;

  $('h2h-loading').classList.remove('hidden');
  $('records-loading').classList.remove('hidden');
  $('records-status').textContent = 'Loading archive';

  state.matchupsPromise = (async () => {
    const tasks = [];
    state.history.forEach(item => {
      item.matchups = [];
      for (let week = 1; week <= CONFIG.maxWeeksPerSeason; week += 1) tasks.push({ item, week });
    });

    let cursor = 0;
    const workers = Array.from({ length: CONFIG.matchupConcurrency }, async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++];
        const data = await api(`/league/${task.item.league.league_id}/matchups/${task.week}`).catch(() => []);
        if (Array.isArray(data) && data.length) task.item.matchups.push({ week: task.week, data });
      }
    });
    await Promise.all(workers);
    state.history.forEach(item => item.matchups.sort((a, b) => a.week - b.week));
    state.matchupsLoaded = true;
    renderH2HSelectors();
  })().finally(() => {
    $('h2h-loading').classList.add('hidden');
    $('records-loading').classList.add('hidden');
  });

  return state.matchupsPromise;
}

function renderH2HSelectors() {
  const managers = managerDirectory();
  const currentA = $('h2h-a').value;
  const currentB = $('h2h-b').value;
  const options = managers.map(manager => `<option value="${manager.id}">${escapeHtml(manager.name)}</option>`).join('');
  $('h2h-a').innerHTML = options;
  $('h2h-b').innerHTML = options;
  $('h2h-a').value = managers.some(m => m.id === currentA) ? currentA : managers[0]?.id || '';
  $('h2h-b').value = managers.some(m => m.id === currentB) ? currentB : managers[1]?.id || managers[0]?.id || '';
}

function matchupArchive(managerA, managerB) {
  const games = [];
  state.history.forEach(item => {
    const rosterOwners = Object.fromEntries(item.rosters.map(roster => [Number(roster.roster_id), roster.owner_id]));
    const regularEnd = regularSeasonEnd(item);

    item.matchups.forEach(({ week, data }) => {
      const groups = {};
      data.forEach(matchup => {
        if (matchup.matchup_id == null) return;
        (groups[matchup.matchup_id] ||= []).push(matchup);
      });

      Object.values(groups).forEach(pair => {
        if (pair.length !== 2) return;
        const one = pair[0];
        const two = pair[1];
        const ownerOne = rosterOwners[Number(one.roster_id)];
        const ownerTwo = rosterOwners[Number(two.roster_id)];
        if (!((ownerOne === managerA && ownerTwo === managerB) || (ownerOne === managerB && ownerTwo === managerA))) return;

        const scoreOne = Number(one.points || 0);
        const scoreTwo = Number(two.points || 0);
        games.push({
          season: item.league.season,
          week,
          type: week > regularEnd ? 'Playoffs' : 'Regular',
          ownerOne,
          ownerTwo,
          scoreOne,
          scoreTwo,
          winner: scoreOne === scoreTwo ? null : (scoreOne > scoreTwo ? ownerOne : ownerTwo)
        });
      });
    });
  });

  return games.sort((a, b) => Number(b.season) - Number(a.season) || b.week - a.week);
}

function renderH2H() {
  if (!state.matchupsLoaded) return;
  const a = $('h2h-a').value;
  const b = $('h2h-b').value;
  const names = Object.fromEntries(managerDirectory().map(manager => [manager.id, manager.name]));

  if (!a || !b || a === b) {
    $('h2h-results').innerHTML = '<tr><td colspan="5" class="empty-cell">Choose two different managers.</td></tr>';
    return;
  }

  const games = matchupArchive(a, b);
  const aWins = games.filter(game => game.winner === a).length;
  const bWins = games.filter(game => game.winner === b).length;
  const ties = games.filter(game => game.winner == null).length;

  $('h2h-a-label').textContent = names[a] || 'Manager A';
  $('h2h-b-label').textContent = names[b] || 'Manager B';
  $('h2h-a-wins').textContent = aWins;
  $('h2h-b-wins').textContent = bWins;
  $('h2h-ties').textContent = ties;
  $('h2h-games').textContent = games.length;

  $('h2h-results').innerHTML = games.length ? games.map(game => {
    const aFirst = game.ownerOne === a;
    const aScore = aFirst ? game.scoreOne : game.scoreTwo;
    const bScore = aFirst ? game.scoreTwo : game.scoreOne;
    const winner = game.winner ? names[game.winner] : 'Tie';
    return `<tr><td>${escapeHtml(game.season)}</td><td>${game.week}</td><td>${game.type}</td><td><strong>${escapeHtml(winner)}</strong></td><td>${aScore.toFixed(2)} – ${bScore.toFixed(2)}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="empty-cell">No matchups found between these managers.</td></tr>';

  const aPoints = games.reduce((sum, game) => sum + (game.ownerOne === a ? game.scoreOne : game.scoreTwo), 0);
  const bPoints = games.reduce((sum, game) => sum + (game.ownerOne === b ? game.scoreOne : game.scoreTwo), 0);
  const highest = games.flatMap(game => [
    { owner: game.ownerOne, score: game.scoreOne, season: game.season, week: game.week },
    { owner: game.ownerTwo, score: game.scoreTwo, season: game.season, week: game.week }
  ]).sort((x, y) => y.score - x.score)[0];
  const closest = games.map(game => ({ margin: Math.abs(game.scoreOne - game.scoreTwo), season: game.season, week: game.week })).sort((x, y) => x.margin - y.margin)[0];
  const playoffGames = games.filter(game => game.type === 'Playoffs').length;

  $('h2h-notes').innerHTML = `
    <div class="record-card"><span>Series Leader</span><strong>${aWins === bWins ? 'Dead Even' : escapeHtml(aWins > bWins ? names[a] : names[b])}</strong><small>${aWins}-${bWins}${ties ? `-${ties}` : ''}</small></div>
    <div class="record-card"><span>All-Time Points</span><strong>${aPoints.toFixed(2)}</strong><small>${escapeHtml(names[a])} • ${bPoints.toFixed(2)} ${escapeHtml(names[b])}</small></div>
    <div class="record-card"><span>Highest Team Week</span><strong>${highest ? highest.score.toFixed(2) : '—'}</strong><small>${highest ? `${escapeHtml(names[highest.owner])} • ${highest.season} W${highest.week}` : '—'}</small></div>
    <div class="record-card"><span>Closest Finish</span><strong>${closest ? closest.margin.toFixed(2) : '—'}</strong><small>${closest ? `${closest.season} • Week ${closest.week}` : '—'}</small></div>
    <div class="record-card"><span>Playoff Meetings</span><strong>${playoffGames}</strong><small>included in the series above</small></div>`;
}

async function ensureH2H() {
  await loadAllMatchups();
  renderH2H();
}

async function loadPlayerMap() {
  if (state.playerMap) return state.playerMap;
  if (state.playerMapPromise) return state.playerMapPromise;
  $('player-db-note').textContent = 'Loading Sleeper player directory...';
  state.playerMapPromise = api('/players/nfl').then(data => {
    state.playerMap = data || {};
    $('player-db-note').textContent = 'Player names resolved from Sleeper.';
    return state.playerMap;
  }).catch(() => {
    state.playerMap = {};
    $('player-db-note').textContent = 'Player directory unavailable; Sleeper player IDs are shown instead.';
    return state.playerMap;
  });
  return state.playerMapPromise;
}

function collectPlayerGames() {
  const rows = [];
  state.history.forEach(item => {
    const rosterOwners = Object.fromEntries(item.rosters.map(roster => [Number(roster.roster_id), roster.owner_id]));
    const users = Object.fromEntries(item.users.map(user => [user.user_id, user]));

    item.matchups.forEach(({ week, data }) => data.forEach(matchup => {
      const ownerId = rosterOwners[Number(matchup.roster_id)];
      const manager = managerName(users[ownerId]);
      Object.entries(matchup.players_points || {}).forEach(([playerId, score]) => {
        const points = Number(score);
        if (!Number.isFinite(points) || points <= 0) return;
        rows.push({ playerId, points, season: item.league.season, week, manager });
      });
    }));
  });
  return rows.sort((a, b) => b.points - a.points);
}

function playerInfo(id) {
  const player = state.playerMap?.[id];
  if (!player) return { name: `Player ${id}`, meta: '' };
  return {
    name: player.full_name || [player.first_name, player.last_name].filter(Boolean).join(' ') || `Player ${id}`,
    meta: [player.position, player.team].filter(Boolean).join(' • ')
  };
}

function renderPlayerRecords() {
  const games = collectPlayerGames().slice(0, state.recordsLimit);
  $('player-records').innerHTML = games.length ? games.map((game, index) => {
    const player = playerInfo(game.playerId);
    return `<tr><td class="rank big-rank">${index + 1}</td><td class="team-cell"><strong>${escapeHtml(player.name)}</strong><span>${escapeHtml(player.meta)}</span></td><td class="gold-score">${game.points.toFixed(2)}</td><td>${escapeHtml(game.season)}</td><td>${game.week}</td><td>${escapeHtml(game.manager)}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-cell">No individual player scoring data was found.</td></tr>';
}

async function ensureRecords() {
  $('records-status').textContent = 'Loading';
  await loadAllMatchups();
  await loadPlayerMap();
  renderPlayerRecords();
  $('records-status').textContent = 'Archive loaded';
}

function activateView(viewName) {
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === viewName));
  $$('.view').forEach(view => view.classList.toggle('active-view', view.id === `${viewName}-view`));
}

async function navigate(viewName) {
  activateView(viewName);
  try {
    if (viewName === 'headtohead') await ensureH2H();
    if (viewName === 'records') await ensureRecords();
  } catch (error) {
    showError(`Historical analytics could not finish loading: ${error.message}`);
  }
}

async function load() {
  clearError();
  setApiState('loading', 'Connecting to Sleeper');
  $('league-meta').textContent = 'Loading league...';

  try {
    state.league = await api(`/league/${CONFIG.primaryLeagueId}`);
    [state.users, state.rosters] = await Promise.all([
      api(`/league/${CONFIG.primaryLeagueId}/users`),
      api(`/league/${CONFIG.primaryLeagueId}/rosters`)
    ]);
    renderCurrentLeague();
    setApiState('', 'Live Sleeper data');

    try {
      await loadHistory();
    } catch (historyError) {
      showError(`Current season loaded, but league history did not fully load: ${historyError.message}`);
    }
  } catch (error) {
    showError(`Could not load the current Sleeper league: ${error.message}`);
  }
}

$$('.nav-item').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
$$('[data-jump]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.jump)));
$('refresh-btn').addEventListener('click', () => location.reload());
$('season-select').addEventListener('change', event => renderStandingsSeason(Number(event.target.value)));
$('h2h-a').addEventListener('change', renderH2H);
$('h2h-b').addEventListener('change', renderH2H);
$$('.record-tab').forEach(button => button.addEventListener('click', () => {
  $$('.record-tab').forEach(tab => tab.classList.toggle('active', tab === button));
  state.recordsLimit = Number(button.dataset.limit);
  if (state.matchupsLoaded && state.playerMap) renderPlayerRecords();
}));

load();
