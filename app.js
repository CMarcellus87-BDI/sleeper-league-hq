const CONFIG = {
  primaryLeagueId: '1326583431680761856',
  apiBase: 'https://api.sleeper.app/v1',
  maxHistorySeasons: 20,
  maxWeeksPerSeason: 18
};

const state = {
  league: null, users: [], rosters: [], history: [],
  matchupsLoaded: false, playerMap: {}, playerRecordsLimit: 10
};
const $ = id => document.getElementById(id);

const api = async path => {
  const res = await fetch(`${CONFIG.apiBase}${path}`);
  if (!res.ok) throw new Error(`Sleeper API returned ${res.status}`);
  return res.json();
};

function points(settings, key='fpts') {
  if (!settings) return 0;
  return Number(settings[key] || 0) + Number(settings[`${key}_decimal`] || 0) / 100;
}
function escapeHtml(value='') {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function teamName(user, roster) {
  return user?.metadata?.team_name || user?.display_name || user?.username || `Roster ${roster?.roster_id ?? '?'}`;
}
function managerName(user) { return user?.display_name || user?.username || 'Orphan'; }
function formatRecord(roster) {
  const s = roster?.settings || {};
  const t = Number(s.ties || 0);
  return `${Number(s.wins || 0)}-${Number(s.losses || 0)}${t ? `-${t}` : ''}`;
}
function rosterRowsFor(item) {
  const usersById = Object.fromEntries(item.users.map(u => [u.user_id, u]));
  return item.rosters.map(r => {
    const u = usersById[r.owner_id], s = r.settings || {};
    return { rosterId:r.roster_id, ownerId:r.owner_id, team:teamName(u,r), manager:managerName(u), wins:Number(s.wins||0), losses:Number(s.losses||0), ties:Number(s.ties||0), pf:points(s,'fpts'), pa:points(s,'fpts_against'), moves:Number(s.total_moves||0) };
  }).sort((a,b)=>(b.wins-a.wins)||(a.losses-b.losses)||(b.pf-a.pf));
}
function rosterRows() { return rosterRowsFor({users:state.users, rosters:state.rosters}); }

function championDetail(item) {
  const byUser = Object.fromEntries(item.users.map(u => [u.user_id,u]));
  const title = (item.winnersBracket || []).find(m => Number(m.p) === 1 && m.w != null);
  if (!title) return { name:item.league.status === 'complete' ? 'Champion unavailable' : 'TBD', manager:'', record:'—', ownerId:null, rosterId:null };
  const roster = item.rosters.find(r => Number(r.roster_id) === Number(title.w));
  const user = roster ? byUser[roster.owner_id] : null;
  return { name:roster ? teamName(user,roster) : `Roster ${title.w}`, manager:managerName(user), record:roster ? formatRecord(roster) : '—', ownerId:roster?.owner_id || null, rosterId:roster?.roster_id || null };
}

function renderStandings(item={league:state.league,users:state.users,rosters:state.rosters}) {
  const rows = rosterRowsFor(item);
  const overview = rows.map((r,i)=>`<tr><td class="rank">${i+1}</td><td class="team-cell"><strong>${escapeHtml(r.team)}</strong><span>${escapeHtml(r.manager)}</span></td><td class="record">${r.wins}-${r.losses}${r.ties?`-${r.ties}`:''}</td><td>${r.pf.toFixed(2)}</td><td>${r.pa.toFixed(2)}</td></tr>`).join('');
  if (item.league.league_id === state.league.league_id) $('overview-standings').innerHTML = overview;
  $('full-standings').innerHTML = rows.map((r,i)=>`<tr><td class="rank">${i+1}</td><td class="team-cell"><strong>${escapeHtml(r.team)}</strong></td><td>${escapeHtml(r.manager)}</td><td class="record">${r.wins}-${r.losses}${r.ties?`-${r.ties}`:''}</td><td>${r.pf.toFixed(2)}</td><td>${r.pa.toFixed(2)}</td><td>${r.moves}</td></tr>`).join('');
  $('standings-title').textContent = `${item.league.season} Standings`;

  if (item.league.league_id === state.league.league_id) {
    const leader=rows[0], pfLeader=[...rows].sort((a,b)=>b.pf-a.pf)[0];
    $('stat-leader').textContent=leader?.team||'—'; $('stat-leader-detail').textContent=leader?`${leader.wins}-${leader.losses} • ${leader.pf.toFixed(2)} PF`:'—';
    $('stat-pf-leader').textContent=pfLeader?.team||'—'; $('stat-pf-detail').textContent=pfLeader?`${pfLeader.pf.toFixed(2)} points`:'—';
  }
}

function renderLeague() {
  const l=state.league;
  $('league-meta').textContent=`${l.season} • ${l.total_rosters} teams • ${String(l.status).replaceAll('_',' ')}`;
  $('stat-teams').textContent=l.total_rosters; $('stat-season').textContent=l.season; $('stat-status').textContent=String(l.status).replaceAll('_',' ');
  renderStandings();
}

async function loadHistory(startLeague) {
  const history=[]; let current=startLeague; const seen=new Set();
  while(current && !seen.has(current.league_id) && history.length<CONFIG.maxHistorySeasons){
    seen.add(current.league_id);
    const [users,rosters,winnersBracket]=await Promise.all([
      api(`/league/${current.league_id}/users`).catch(()=>[]),
      api(`/league/${current.league_id}/rosters`).catch(()=>[]),
      api(`/league/${current.league_id}/winners_bracket`).catch(()=>[])
    ]);
    history.push({league:current,users,rosters,winnersBracket,matchups:[]});
    if(!current.previous_league_id||current.previous_league_id==='0') break;
    current=await api(`/league/${current.previous_league_id}`);
  }
  state.history=history;
  renderHistory();
  populateSeasonSelect();
  await loadAllMatchups();
}

function renderHistory() {
  $('history-count').textContent=state.history.length;
  const rows=state.history.map(h=>({season:h.league.season,...championDetail(h)}));
  const rowHtml=rows.map(r=>`<div class="history-row clean"><span class="history-year">${r.season}</span><strong>${escapeHtml(r.name)}</strong><span class="champ-record">${r.record}</span><span class="trophy">🏆</span></div>`).join('')||'<p class="muted">No linked prior seasons found.</p>';
  $('history-summary').innerHTML=state.history.slice(0,6).map(h=>{const c=championDetail(h);return `<div class="history-row clean"><span class="history-year">${h.league.season}</span><strong>${escapeHtml(c.name)}</strong><span class="champ-record">${c.record}</span><span class="trophy">🏆</span></div>`}).join('');
  $('history-ledger').innerHTML=rowHtml;

  const titles={};
  rows.filter(r=>r.ownerId).forEach(r=>{const key=r.ownerId; if(!titles[key]) titles[key]={name:r.manager||r.name,count:0,seasons:[]}; titles[key].count++; titles[key].seasons.push(r.season)});
  const leaders=Object.values(titles).sort((a,b)=>b.count-a.count||String(b.seasons[0]).localeCompare(String(a.seasons[0])));
  $('championship-leaders').innerHTML=leaders.length?leaders.map((x,i)=>`<div class="champ-leader"><span class="medal">${i===0?'♛':'🏆'}</span><div><strong>${escapeHtml(x.name)}</strong><small>${x.seasons.join(' • ')}</small></div><b>${x.count}</b></div>`).join(''):'<p class="muted">No completed championships yet.</p>';
}

function populateSeasonSelect(){
  $('season-select').innerHTML=state.history.map((h,i)=>`<option value="${i}">${h.league.season}</option>`).join('');
}

function regularSeasonWeeks(item){
  const p=Number(item.league?.settings?.playoff_week_start||0);
  return p>1?Math.min(CONFIG.maxWeeksPerSeason,p-1):CONFIG.maxWeeksPerSeason;
}

async function loadAllMatchups(){
  $('records-status').textContent='Loading matchup archive';
  const jobs=[];
  for(const item of state.history){
    const weeks=regularSeasonWeeks(item);
    jobs.push((async()=>{
      const results=[];
      for(let week=1;week<=weeks;week++){
        const data=await api(`/league/${item.league.league_id}/matchups/${week}`).catch(()=>[]);
        if(!data?.length && week>14) break;
        results.push({week,data:data||[]});
      }
      item.matchups=results;
    })());
  }
  await Promise.all(jobs);
  state.matchupsLoaded=true;
  renderH2HSelectors(); renderH2H();
  $('records-status').textContent='Matchup archive loaded';
  await loadPlayerDirectory();
  renderPlayerRecords();
}

function managerDirectory(){
  const map=new Map();
  state.history.forEach(item=>item.users.forEach(u=>{if(u?.user_id&&!map.has(u.user_id)) map.set(u.user_id,{id:u.user_id,name:managerName(u)})}));
  return [...map.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
function renderH2HSelectors(){
  const managers=managerDirectory();
  const options=managers.map(m=>`<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  $('h2h-a').innerHTML=options; $('h2h-b').innerHTML=options;
  if(managers.length>1){ $('h2h-a').value=managers[0].id; $('h2h-b').value=managers[1].id; }
}
function allH2HGames(a,b){
  const games=[];
  state.history.forEach(item=>{
    const rosterOwners=Object.fromEntries(item.rosters.map(r=>[Number(r.roster_id),r.owner_id]));
    item.matchups.forEach(({week,data})=>{
      const groups={}; data.forEach(m=>{if(m.matchup_id==null)return; (groups[m.matchup_id]??=[]).push(m)});
      Object.values(groups).forEach(pair=>{
        if(pair.length!==2)return;
        const x=pair[0],y=pair[1], ox=rosterOwners[Number(x.roster_id)], oy=rosterOwners[Number(y.roster_id)];
        if(!((ox===a&&oy===b)||(ox===b&&oy===a)))return;
        const sx=Number(x.points||0), sy=Number(y.points||0);
        games.push({season:item.league.season,week,ownerA:ox,ownerB:oy,scoreA:sx,scoreB:sy,winner:sx===sy?null:(sx>sy?ox:oy)});
      });
    });
  });
  return games.sort((x,y)=>Number(y.season)-Number(x.season)||y.week-x.week);
}
function renderH2H(){
  if(!state.matchupsLoaded)return;
  const a=$('h2h-a').value,b=$('h2h-b').value;
  if(!a||!b||a===b){$('h2h-results').innerHTML='<tr><td colspan="4" class="muted">Choose two different managers.</td></tr>';return;}
  const managers=Object.fromEntries(managerDirectory().map(m=>[m.id,m.name])); const games=allH2HGames(a,b);
  const aw=games.filter(g=>g.winner===a).length,bw=games.filter(g=>g.winner===b).length,t=games.filter(g=>g.winner===null).length;
  $('h2h-a-wins').textContent=aw;$('h2h-b-wins').textContent=bw;$('h2h-ties').textContent=t;$('h2h-games').textContent=games.length;
  $('h2h-a-label').textContent=`${managers[a]} wins`; $('h2h-b-label').textContent=`${managers[b]} wins`;
  $('h2h-results').innerHTML=games.length?games.map(g=>{
    const aIsFirst=g.ownerA===a, as=aIsFirst?g.scoreA:g.scoreB, bs=aIsFirst?g.scoreB:g.scoreA;
    const winner=g.winner?managers[g.winner]:'Tie';
    return `<tr><td>${g.season}</td><td>${g.week}</td><td><strong>${escapeHtml(winner)}</strong></td><td>${as.toFixed(2)} – ${bs.toFixed(2)}</td></tr>`;
  }).join(''):'<tr><td colspan="4" class="muted">No regular-season matchups found between these managers.</td></tr>';
  const totalA=games.reduce((n,g)=>n+(g.ownerA===a?g.scoreA:g.scoreB),0), totalB=games.reduce((n,g)=>n+(g.ownerA===b?g.scoreA:g.scoreB),0);
  const high=games.reduce((best,g)=>{const vals=[{owner:g.ownerA,score:g.scoreA},{owner:g.ownerB,score:g.scoreB}];const candidate=vals.sort((x,y)=>y.score-x.score)[0];return !best||candidate.score>best.score?{...candidate,season:g.season,week:g.week}:best},null);
  const close=games.reduce((best,g)=>{const d=Math.abs(g.scoreA-g.scoreB);return !best||d<best.d?{d,season:g.season,week:g.week}:best},null);
  $('h2h-notes').innerHTML=`<div class="record-card"><span>Series Leader</span><strong>${aw===bw?'Even':escapeHtml(aw>bw?managers[a]:managers[b])}</strong><small>${aw}-${bw}${t?`-${t}`:''}</small></div><div class="record-card"><span>Total Points</span><strong>${totalA.toFixed(2)}</strong><small>${escapeHtml(managers[a])} vs ${totalB.toFixed(2)}</small></div><div class="record-card"><span>Highest Game</span><strong>${high?high.score.toFixed(2):'—'}</strong><small>${high?`${escapeHtml(managers[high.owner])} • ${high.season} W${high.week}`:'—'}</small></div><div class="record-card"><span>Closest Battle</span><strong>${close?close.d.toFixed(2):'—'}</strong><small>${close?`${close.season} • Week ${close.week}`:'—'}</small></div>`;
}

async function loadPlayerDirectory(){
  $('player-db-note').textContent='Loading Sleeper player names…';
  try{ state.playerMap=await api('/players/nfl'); $('player-db-note').textContent='Sleeper player directory loaded'; }
  catch{ state.playerMap={}; $('player-db-note').textContent='Player names unavailable; showing Sleeper player IDs'; }
}
function collectPlayerPerformances(){
  const rows=[];
  state.history.forEach(item=>{
    const rosterOwners=Object.fromEntries(item.rosters.map(r=>[Number(r.roster_id),r.owner_id]));
    const users=Object.fromEntries(item.users.map(u=>[u.user_id,u]));
    item.matchups.forEach(({week,data})=>data.forEach(m=>{
      const owner=rosterOwners[Number(m.roster_id)], manager=managerName(users[owner]);
      const pp=m.players_points||{};
      Object.entries(pp).forEach(([playerId,score])=>{
        const n=Number(score); if(!Number.isFinite(n)||n<=0)return;
        rows.push({playerId,score:n,season:item.league.season,week,manager});
      });
    }));
  });
  return rows.sort((a,b)=>b.score-a.score);
}
function playerLabel(id){
  const p=state.playerMap[id];
  if(!p)return {name:`Player ${id}`,meta:''};
  return {name:p.full_name||[p.first_name,p.last_name].filter(Boolean).join(' ')||`Player ${id}`,meta:[p.position,p.team].filter(Boolean).join(' • ')};
}
function renderPlayerRecords(){
  if(!state.matchupsLoaded)return;
  const rows=collectPlayerPerformances().slice(0,state.playerRecordsLimit);
  $('player-records').innerHTML=rows.length?rows.map((r,i)=>{const p=playerLabel(r.playerId);return `<tr><td class="rank big-rank">${i+1}</td><td class="team-cell"><strong>${escapeHtml(p.name)}</strong><span>${escapeHtml(p.meta)}</span></td><td class="gold-score">${r.score.toFixed(2)}</td><td>${r.season}</td><td>${r.week}</td><td>${escapeHtml(r.manager)}</td></tr>`}).join(''):'<tr><td colspan="6" class="muted">No player scoring data found.</td></tr>';
}

function setError(err){ $('error-banner').textContent=`Could not load Sleeper data: ${err.message}.`; $('error-banner').classList.remove('hidden'); $('api-status').textContent='Sleeper API unavailable'; }
async function load(){
  $('error-banner').classList.add('hidden'); $('api-status').textContent='Connecting to Sleeper';
  try{
    state.league=await api(`/league/${CONFIG.primaryLeagueId}`);
    [state.users,state.rosters]=await Promise.all([api(`/league/${CONFIG.primaryLeagueId}/users`),api(`/league/${CONFIG.primaryLeagueId}/rosters`)]);
    renderLeague(); $('api-status').textContent='Live Sleeper data'; await loadHistory(state.league);
  }catch(err){setError(err)}
}

document.querySelectorAll('.nav-item').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active-view'));$(`${btn.dataset.view}-view`).classList.add('active-view');
}));
$('refresh-btn').addEventListener('click',load);
$('season-select').addEventListener('change',e=>{const item=state.history[Number(e.target.value)];if(item)renderStandings(item)});
$('h2h-a').addEventListener('change',renderH2H); $('h2h-b').addEventListener('change',renderH2H);
document.querySelectorAll('.record-tab').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.record-tab').forEach(b=>b.classList.remove('active'));btn.classList.add('active');state.playerRecordsLimit=Number(btn.dataset.limit);renderPlayerRecords()}));
load();
