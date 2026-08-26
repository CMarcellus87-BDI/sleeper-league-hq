const CONFIG = {
  primaryLeagueId: '1326583431680761856',
  apiBase: 'https://api.sleeper.app/v1',
  maxHistorySeasons: 20
};

const state = { league: null, users: [], rosters: [], history: [] };
const $ = (id) => document.getElementById(id);
const api = async (path) => {
  const res = await fetch(`${CONFIG.apiBase}${path}`);
  if (!res.ok) throw new Error(`Sleeper API returned ${res.status}`);
  return res.json();
};

function points(settings, key='fpts') {
  if (!settings) return 0;
  const whole = Number(settings[key] || 0);
  const decimal = Number(settings[`${key}_decimal`] || 0) / 100;
  return whole + decimal;
}

function teamName(user, roster) {
  return user?.metadata?.team_name || user?.display_name || user?.username || `Roster ${roster.roster_id}`;
}

function rosterRows() {
  const usersById = Object.fromEntries(state.users.map(u => [u.user_id, u]));
  return state.rosters.map(r => {
    const u = usersById[r.owner_id];
    const s = r.settings || {};
    return {
      rosterId: r.roster_id,
      team: teamName(u, r),
      manager: u?.display_name || u?.username || 'Orphan',
      wins: Number(s.wins || 0), losses: Number(s.losses || 0), ties: Number(s.ties || 0),
      pf: points(s, 'fpts'), pa: points(s, 'fpts_against'), moves: Number(s.total_moves || 0)
    };
  }).sort((a,b) => (b.wins-a.wins) || (a.losses-b.losses) || (b.pf-a.pf));
}

function renderStandings() {
  const rows = rosterRows();
  const rowHtml = rows.map((r,i) => `<tr><td class="rank">${i+1}</td><td class="team-cell"><strong>${escapeHtml(r.team)}</strong><span>${escapeHtml(r.manager)}</span></td><td class="record">${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}</td><td>${r.pf.toFixed(2)}</td><td>${r.pa.toFixed(2)}</td></tr>`).join('');
  $('overview-standings').innerHTML = rowHtml;
  $('full-standings').innerHTML = rows.map((r,i) => `<tr><td class="rank">${i+1}</td><td class="team-cell"><strong>${escapeHtml(r.team)}</strong></td><td>${escapeHtml(r.manager)}</td><td class="record">${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}</td><td>${r.pf.toFixed(2)}</td><td>${r.pa.toFixed(2)}</td><td>${r.moves}</td></tr>`).join('');

  const leader = rows[0];
  const pfLeader = [...rows].sort((a,b)=>b.pf-a.pf)[0];
  $('stat-leader').textContent = leader?.team || '—';
  $('stat-leader-detail').textContent = leader ? `${leader.wins}-${leader.losses} • ${leader.pf.toFixed(2)} PF` : '—';
  $('stat-pf-leader').textContent = pfLeader?.team || '—';
  $('stat-pf-detail').textContent = pfLeader ? `${pfLeader.pf.toFixed(2)} points` : '—';
}

function renderLeague() {
  const l = state.league;
  $('league-name').textContent = l.name || 'Sleeper League';
  $('league-meta').textContent = `${l.season} • ${l.total_rosters} teams • ${l.status.replaceAll('_',' ')}`;
  $('stat-teams').textContent = l.total_rosters;
  $('stat-season').textContent = l.season;
  $('stat-status').textContent = l.status.replaceAll('_',' ');
  renderStandings();
}

async function loadHistory(startLeague) {
  const history = [];
  let current = startLeague;
  const seen = new Set();
  while (current && !seen.has(current.league_id) && history.length < CONFIG.maxHistorySeasons) {
    seen.add(current.league_id);
    const [users, rosters, winnersBracket] = await Promise.all([
      api(`/league/${current.league_id}/users`).catch(()=>[]),
      api(`/league/${current.league_id}/rosters`).catch(()=>[]),
      api(`/league/${current.league_id}/winners_bracket`).catch(()=>[])
    ]);
    history.push({league: current, users, rosters, winnersBracket});
    if (!current.previous_league_id || current.previous_league_id === '0') break;
    current = await api(`/league/${current.previous_league_id}`);
  }
  state.history = history;
  renderHistory();
}

function championForSeason(item) {
  const byUser = Object.fromEntries(item.users.map(u => [u.user_id, u]));
  const championship = (item.winnersBracket || []).find(m => Number(m.p) === 1 && m.w != null);
  if (!championship) return item.league.status === 'complete' ? 'Champion unavailable' : 'TBD';
  const winner = item.rosters.find(r => Number(r.roster_id) === Number(championship.w));
  return winner ? teamName(byUser[winner.owner_id], winner) : `Roster ${championship.w}`;
}

function renderHistory() {
  $('history-count').textContent = state.history.length;
  $('season-select').innerHTML = state.history.map((h,i)=>`<option value="${i}">${h.league.season}</option>`).join('');
  $('history-summary').innerHTML = state.history.slice(0,4).map(h => `<div class="history-row"><div><span>${h.league.season}</span><strong>${escapeHtml(h.league.name)}</strong></div><div><span>Champion</span><strong>${escapeHtml(championForSeason(h))}</strong></div></div>`).join('') || '<p class="muted">No linked prior seasons found.</p>';
  $('history-cards').innerHTML = state.history.map(h => {
    const top = championForSeason(h);
    return `<article class="history-card"><span class="season">${h.league.season}</span><h3>${escapeHtml(h.league.name)}</h3><dl><div><dt>Teams</dt><dd>${h.league.total_rosters}</dd></div><div><dt>Status</dt><dd>${escapeHtml(h.league.status.replaceAll('_',' '))}</dd></div><div><dt>Champion</dt><dd>${escapeHtml(top)}</dd></div><div><dt>League ID</dt><dd>${h.league.league_id.slice(-6)}</dd></div></dl></article>`;
  }).join('');
}

function escapeHtml(value='') { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function setError(err) { $('error-banner').textContent = `Could not load Sleeper data: ${err.message}. If you opened this as a local file, serve it over HTTP (for example with GitHub Pages or a local dev server).`; $('error-banner').classList.remove('hidden'); $('api-status').textContent = 'Sleeper API unavailable'; }

async function load() {
  $('error-banner').classList.add('hidden'); $('api-status').textContent = 'Connecting to Sleeper';
  try {
    state.league = await api(`/league/${CONFIG.primaryLeagueId}`);
    [state.users, state.rosters] = await Promise.all([api(`/league/${CONFIG.primaryLeagueId}/users`), api(`/league/${CONFIG.primaryLeagueId}/rosters`)]);
    renderLeague();
    $('api-status').textContent = 'Live Sleeper data';
    await loadHistory(state.league);
  } catch (err) { setError(err); }
}

document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active-view')); $(`${btn.dataset.view}-view`).classList.add('active-view');
}));
$('refresh-btn').addEventListener('click', load);
$('season-select').addEventListener('change', (e) => {
  const item = state.history[Number(e.target.value)]; if (!item) return;
  state.league = item.league; state.users = item.users; state.rosters = item.rosters; renderLeague();
});
load();
