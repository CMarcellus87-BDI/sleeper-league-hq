const CONFIG = {
  primaryLeagueId: '1326583431680761856',
  apiBase: 'https://api.sleeper.app/v1',
  maxHistorySeasons: 20,
  maxWeeksPerSeason: 18,
  matchupConcurrency: 4,
  version: '6.2.0'
};

const state = {
  league: null,
  users: [],
  rosters: [],
  nflState: null,
  history: [],
  matchupsLoaded: false,
  matchupsPromise: null,
  playerMap: null,
  playerMapPromise: null,
  archive: null,
  recordView: 'team',
  tradesLoaded: false,
  tradesPromise: null,
  trades: [],
  tradesBySeason: new Map(),
  tradePromisesBySeason: new Map(),
  draftResolutionsLoaded: false,
  draftResolutionsPromise: null,
  draftResolutions: new Map(),
  draftResolutionSeasons: new Set(),
  draftResolutionPromises: new Map()
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

function clearError() { $('error-banner').classList.add('hidden'); }
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function pct(n) { return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—'; }
function scoreSettings(settings, key = 'fpts') { return Number(settings?.[key] || 0) + Number(settings?.[`${key}_decimal`] || 0) / 100; }
function managerName(user) { return user?.display_name || user?.username || 'Orphan'; }
function franchiseName(user, roster) { return user?.metadata?.team_name || user?.display_name || user?.username || `Roster ${roster?.roster_id ?? '?'}`; }
function rosterRecord(roster) { const s = roster?.settings || {}; return `${Number(s.wins || 0)}-${Number(s.losses || 0)}`; }
function ownerNameMap() { return Object.fromEntries(managerDirectory().map(m => [m.id, m.name])); }

function avatarUrl(user) { return user?.avatar ? `https://sleepercdn.com/avatars/thumbs/${user.avatar}` : ''; }
function seasonItemForOwner(ownerId) {
  return state.history.filter(item => item.rosters.some(r => r.owner_id === ownerId));
}
function ownerUser(ownerId) {
  for (const item of state.history) { const user=item.users.find(u=>u.user_id===ownerId); if(user)return user; }
  return null;
}


function rosterTable(item) {
  const users = Object.fromEntries(item.users.map(u => [u.user_id, u]));
  return item.rosters.map(roster => {
    const user = users[roster.owner_id]; const s = roster.settings || {};
    return { rosterId:Number(roster.roster_id), ownerId:roster.owner_id, franchise:franchiseName(user, roster), manager:managerName(user), wins:Number(s.wins||0), losses:Number(s.losses||0), ties:0, pf:scoreSettings(s,'fpts'), pa:scoreSettings(s,'fpts_against'), moves:Number(s.total_moves||0) };
  }).sort((a,b)=>(b.wins-a.wins)||(a.losses-b.losses)||(b.pf-a.pf));
}

function titleGame(item) { return (item.winnersBracket || []).find(g => Number(g.p) === 1 && g.w != null) || null; }
function rosterIdentity(item, rosterId) {
  const roster = item.rosters.find(r => Number(r.roster_id) === Number(rosterId));
  const user = roster ? item.users.find(u => u.user_id === roster.owner_id) : null;
  return { roster, user, ownerId:roster?.owner_id || null, franchise:roster ? franchiseName(user, roster) : `Roster ${rosterId}`, manager:managerName(user), record:roster ? rosterRecord(roster) : '—' };
}
function champion(item) { const game=titleGame(item); return game ? rosterIdentity(item, game.w) : {franchise:item.league.status==='complete'?'Unavailable':'TBD',manager:'',record:'—',ownerId:null}; }
function runnerUp(item) { const game=titleGame(item); return game?.l != null ? rosterIdentity(item, game.l) : {franchise:'—',manager:'',record:'—',ownerId:null}; }
function playoffRosterIds(item) {
  const ids = new Set();
  (item.winnersBracket || []).forEach(g => ['t1','t2','w','l'].forEach(k => { if (Number.isFinite(Number(g[k]))) ids.add(Number(g[k])); }));
  return ids;
}
function regularSeasonEnd(item) { const p=Number(item.league?.settings?.playoff_week_start || 0); return p > 1 ? p - 1 : 14; }

function standingsRowsHtml(rows, detailed=true) {
  return rows.map((r,i)=>`<tr><td class="rank">${i+1}</td><td class="team-cell"><strong>${escapeHtml(r.franchise)}</strong>${detailed?'':`<span>${escapeHtml(r.manager)}</span>`}</td>${detailed?`<td>${escapeHtml(r.manager)}</td>`:''}<td class="record">${r.wins}-${r.losses}</td><td>${r.pf.toFixed(2)}</td><td>${r.pa.toFixed(2)}</td>${detailed?`<td>${r.moves}</td>`:''}</tr>`).join('');
}

function renderCurrentLeague() {
  const item={league:state.league,users:state.users,rosters:state.rosters}; const rows=rosterTable(item); const status=String(state.league.status||'unknown').replaceAll('_',' ');
  $('league-meta').textContent=`${state.league.season} • ${state.league.total_rosters} franchises • ${status}`;
  $('stat-season').textContent=state.league.season||'—'; $('stat-status').textContent=status; $('stat-teams').textContent=state.league.total_rosters||rows.length;
  const leader=rows[0], points=[...rows].sort((a,b)=>b.pf-a.pf)[0];
  $('stat-leader').textContent=leader?.franchise||'—'; $('stat-leader-detail').textContent=leader?`${leader.wins}-${leader.losses} • ${leader.pf.toFixed(2)} PF`:'—';
  $('stat-pf-leader').textContent=points?.franchise||'—'; $('stat-pf-detail').textContent=points?`${points.pf.toFixed(2)} points`:'—';
  $('overview-standings').innerHTML=standingsRowsHtml(rows,false);
}

function homeDisplayWeek(){
  return state.nflState?.season_type === 'regular' ? Number(state.nflState?.week || 1) : 1;
}

async function renderCurrentWeek() {
  const week = homeDisplayWeek(); $('stat-week').textContent=`Week ${week}`; $('matchup-week-title').textContent=`Week ${week} Matchups`;
  const rows=await api(`/league/${CONFIG.primaryLeagueId}/matchups/${week}`).catch(()=>[]); const users=Object.fromEntries(state.users.map(u=>[u.user_id,u])); const rosters=Object.fromEntries(state.rosters.map(r=>[Number(r.roster_id),r]));
  const groups={}; rows.forEach(m=>{ if(m.matchup_id!=null)(groups[m.matchup_id]||=[]).push(m); });
  const games=Object.values(groups).filter(g=>g.length===2).map(pair=>pair.map(m=>{const r=rosters[Number(m.roster_id)],u=r?users[r.owner_id]:null;return {name:franchiseName(u,r),score:Number(m.points||0)};}));
  $('current-matchups').innerHTML=games.length?games.map(pair=>`<div class="matchup-card"><div><strong>${escapeHtml(pair[0].name)}</strong><b>${pair[0].score.toFixed(2)}</b></div><span>VS</span><div><strong>${escapeHtml(pair[1].name)}</strong><b>${pair[1].score.toFixed(2)}</b></div></div>`).join(''):'<div class="empty-cell">No matchup data available for the current week.</div>';
}

async function loadHistory() {
  const seasons=[]; let league=state.league; const visited=new Set();
  while(league && !visited.has(league.league_id) && seasons.length<CONFIG.maxHistorySeasons){
    visited.add(league.league_id);
    const [users,rosters,winnersBracket]=await Promise.all([api(`/league/${league.league_id}/users`).catch(()=>[]),api(`/league/${league.league_id}/rosters`).catch(()=>[]),api(`/league/${league.league_id}/winners_bracket`).catch(()=>[])]);
    seasons.push({league,users,rosters,winnersBracket,matchups:[]});
    if(!league.previous_league_id||league.previous_league_id==='0')break;
    try{league=await api(`/league/${league.previous_league_id}`);}catch{break;}
  }
  state.history=seasons; renderHistory(); populateSeasonSelects(); renderStandingsSeason(0);
}

function renderHistory() {
  $('history-count').textContent=state.history.length;
  const rows=state.history.map(item=>({season:item.league.season,...champion(item),runner:runnerUp(item)}));
  const rowHtml=(r,ledger=false)=>`<div class="history-row${ledger?' ledger-row':''}"><span class="history-year">${escapeHtml(r.season)}</span><span class="history-champ"><strong>${escapeHtml(r.franchise)}</strong><small>${r.manager&&r.manager!==r.franchise?escapeHtml(r.manager):''}</small></span><span class="champ-record">${escapeHtml(r.record)}</span><span class="trophy">${r.ownerId?'🏆':'—'}</span></div>`;
  $('history-summary').innerHTML=rows.slice(0,6).map(r=>rowHtml(r)).join('')||'<div class="empty-cell">No linked seasons found.</div>';
  $('history-ledger').innerHTML=rows.map(r=>rowHtml(r,true)).join('')||'<div class="empty-cell">No linked seasons found.</div>';
  $('trophy-wall').innerHTML=rows.filter(r=>r.ownerId).map(r=>`<article class="trophy-card"><span class="trophy-year">${escapeHtml(r.season)}</span><span class="trophy-icon">♛</span><strong>${escapeHtml(r.franchise)}</strong><small>${escapeHtml(r.record)} • defeated ${escapeHtml(r.runner.franchise)}</small></article>`).join('')||'<div class="empty-cell">No completed championships found.</div>';
  const map=new Map(); rows.filter(r=>r.ownerId).forEach(r=>{if(!map.has(r.ownerId))map.set(r.ownerId,{name:r.manager||r.franchise,count:0,seasons:[]});const e=map.get(r.ownerId);e.count++;e.seasons.push(r.season);});
  const leaders=[...map.values()].sort((a,b)=>b.count-a.count||String(b.seasons[0]).localeCompare(String(a.seasons[0])));
  $('championship-leaders').innerHTML=leaders.length?leaders.map((e,i)=>`<div class="title-card"><span class="medal">${i===0?'♛':'🏆'}</span><span><strong>${escapeHtml(e.name)}</strong><small>${e.seasons.join(' • ')}</small></span><b>${e.count}</b></div>`).join(''):'<div class="empty-cell">No completed titles found.</div>';
}

function populateSeasonSelects(){const opts=state.history.map((item,i)=>`<option value="${i}">${escapeHtml(item.league.season)}</option>`).join('');$('season-select').innerHTML=opts;$('explorer-season').innerHTML=opts;}
function renderStandingsSeason(index=0){const item=state.history[index]||{league:state.league,users:state.users,rosters:state.rosters};$('standings-title').textContent=`${item.league.season} Standings`;$('full-standings').innerHTML=standingsRowsHtml(rosterTable(item),true);}
function managerDirectory(){const m=new Map();state.history.forEach(item=>item.users.forEach(u=>{if(u?.user_id&&!m.has(u.user_id))m.set(u.user_id,{id:u.user_id,name:managerName(u)});}));return [...m.values()].sort((a,b)=>a.name.localeCompare(b.name));}

async function loadAllMatchups() {
  if(state.matchupsLoaded)return; if(state.matchupsPromise)return state.matchupsPromise;
  state.matchupsPromise=(async()=>{
    const tasks=[];state.history.forEach(item=>{item.matchups=[];for(let week=1;week<=CONFIG.maxWeeksPerSeason;week++)tasks.push({item,week});});let cursor=0;
    const workers=Array.from({length:CONFIG.matchupConcurrency},async()=>{while(cursor<tasks.length){const task=tasks[cursor++];const data=await api(`/league/${task.item.league.league_id}/matchups/${task.week}`).catch(()=>[]);if(Array.isArray(data)&&data.length)task.item.matchups.push({week:task.week,data});}});
    await Promise.all(workers);state.history.forEach(item=>item.matchups.sort((a,b)=>a.week-b.week));state.matchupsLoaded=true;state.archive=buildArchive();renderOverviewLegends();
  })();return state.matchupsPromise;
}

function buildArchive(){
  const names=ownerNameMap(); const teamGames=[]; const pairedGames=[]; const playerGames=[]; const franchise=new Map();
  state.history.forEach(item=>{
    const users=Object.fromEntries(item.users.map(u=>[u.user_id,u])); const ownerByRoster=Object.fromEntries(item.rosters.map(r=>[Number(r.roster_id),r.owner_id])); const table=rosterTable(item); const playoffIds=playoffRosterIds(item); const champ=champion(item); const runner=runnerUp(item);
    table.forEach(r=>{if(!r.ownerId)return; if(!franchise.has(r.ownerId))franchise.set(r.ownerId,{ownerId:r.ownerId,name:r.manager,seasons:0,titles:0,finals:0,playoffs:0,wins:0,losses:0,ties:0,pf:0,pa:0,bestSeason:null});const f=franchise.get(r.ownerId);f.name=r.manager||f.name;f.seasons++;f.wins+=r.wins;f.losses+=r.losses;f.pf+=r.pf;f.pa+=r.pa;if(playoffIds.has(r.rosterId))f.playoffs++;if(champ.ownerId===r.ownerId)f.titles++;if(runner.ownerId===r.ownerId)f.finals++;const candidate={season:item.league.season,wins:r.wins,losses:r.losses,pf:r.pf};if(!f.bestSeason||candidate.wins>f.bestSeason.wins||(candidate.wins===f.bestSeason.wins&&candidate.pf>f.bestSeason.pf))f.bestSeason=candidate;});
    item.matchups.forEach(({week,data})=>{
      data.forEach(m=>{const ownerId=ownerByRoster[Number(m.roster_id)]; if(!ownerId)return; const user=users[ownerId];teamGames.push({ownerId,manager:managerName(user),season:item.league.season,week,points:Number(m.points||0),type:week>regularSeasonEnd(item)?'Playoffs':'Regular'});Object.entries(m.players_points||{}).forEach(([playerId,pts])=>{const points=Number(pts);if(Number.isFinite(points))playerGames.push({playerId,points,ownerId,manager:managerName(user),season:item.league.season,week});});});
      const groups={};data.forEach(m=>{if(m.matchup_id!=null)(groups[m.matchup_id]||=[]).push(m);});Object.values(groups).filter(p=>p.length===2).forEach(pair=>{const a=pair[0],b=pair[1],oa=ownerByRoster[Number(a.roster_id)],ob=ownerByRoster[Number(b.roster_id)];if(!oa||!ob)return;const sa=Number(a.points||0),sb=Number(b.points||0);pairedGames.push({season:item.league.season,week,type:week>regularSeasonEnd(item)?'Playoffs':'Regular',a:oa,b:ob,aName:names[oa]||oa,bName:names[ob]||ob,aScore:sa,bScore:sb,winner:sa===sb?null:(sa>sb?oa:ob),loser:sa===sb?null:(sa>sb?ob:oa),margin:Math.abs(sa-sb),total:sa+sb});});
    });
  });
  const franchises=[...franchise.values()].map(f=>{const gp=f.wins+f.losses;f.winPct=gp?f.wins/gp:0;f.goat=f.titles*100+f.finals*45+f.playoffs*15+f.wins*2+f.pf/100;return f;}).sort((a,b)=>b.goat-a.goat);
  return {teamGames,pairedGames,playerGames,franchises};
}

function renderOverviewLegends(){if(!state.archive)return;const top=state.archive.franchises[0];const score=[...state.archive.teamGames].sort((a,b)=>b.points-a.points)[0];const rivalry=computeRivalries()[0];$('overview-legends').innerHTML=`<div class="mini-award"><span>GOAT Leader</span><strong>${escapeHtml(top?.name||'—')}</strong><small>${top?top.goat.toFixed(1)+' DOL':'—'}</small></div><div class="mini-award"><span>Highest Team Week</span><strong>${score?score.points.toFixed(2):'—'}</strong><small>${score?`${escapeHtml(score.manager)} • ${score.season} W${score.week}`:'—'}</small></div><div class="mini-award"><span>Top Rivalry</span><strong>${rivalry?`${escapeHtml(rivalry.aName)} vs ${escapeHtml(rivalry.bName)}`:'—'}</strong><small>${rivalry?`${rivalry.games} meetings • ${rivalry.score.toFixed(1)} index`:'—'}</small></div>`;}

function renderH2HSelectors(){const managers=managerDirectory(),a=$('h2h-a').value,b=$('h2h-b').value,opts=managers.map(m=>`<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');$('h2h-a').innerHTML=opts;$('h2h-b').innerHTML=opts;$('h2h-a').value=managers.some(m=>m.id===a)?a:managers[0]?.id||'';$('h2h-b').value=managers.some(m=>m.id===b)?b:managers[1]?.id||managers[0]?.id||'';}
function matchupArchive(a,b){return (state.archive?.pairedGames||[]).filter(g=>(g.a===a&&g.b===b)||(g.a===b&&g.b===a)).sort((x,y)=>Number(y.season)-Number(x.season)||y.week-x.week);}
function renderH2H(){if(!state.archive)return;const a=$('h2h-a').value,b=$('h2h-b').value,names=ownerNameMap();if(!a||!b||a===b){$('h2h-results').innerHTML='<tr><td colspan="6" class="empty-cell">Choose two different managers.</td></tr>';return;}const games=matchupArchive(a,b),aw=games.filter(g=>g.winner===a).length,bw=games.filter(g=>g.winner===b).length;$('h2h-a-label').textContent=names[a]||'Manager A';$('h2h-b-label').textContent=names[b]||'Manager B';$('h2h-a-wins').textContent=aw;$('h2h-b-wins').textContent=bw;$('h2h-games').textContent=games.length;
  $('h2h-results').innerHTML=games.length?games.map(g=>{const aScore=g.a===a?g.aScore:g.bScore,bScore=g.a===a?g.bScore:g.aScore;return `<tr><td>${escapeHtml(g.season)}</td><td>${g.week}</td><td>${g.type}</td><td><strong>${escapeHtml(g.winner?names[g.winner]:'Tie')}</strong></td><td>${aScore.toFixed(2)} – ${bScore.toFixed(2)}</td><td>${g.margin.toFixed(2)}</td></tr>`;}).join(''):'<tr><td colspan="6" class="empty-cell">No matchups found between these managers.</td></tr>';
  const ap=games.reduce((s,g)=>s+(g.a===a?g.aScore:g.bScore),0),bp=games.reduce((s,g)=>s+(g.a===a?g.bScore:g.aScore),0),highest=[...games].sort((x,y)=>Math.max(y.aScore,y.bScore)-Math.max(x.aScore,x.bScore))[0],closest=[...games].sort((x,y)=>x.margin-y.margin)[0],playoffs=games.filter(g=>g.type==='Playoffs').length,biggest=[...games].sort((x,y)=>y.margin-x.margin)[0];
  $('h2h-notes').innerHTML=`<div class="record-card"><span>Series Leader</span><strong>${aw===bw?'Dead Even':escapeHtml(aw>bw?names[a]:names[b])}</strong><small>${aw}-${bw}</small></div><div class="record-card"><span>All-Time Points</span><strong>${ap.toFixed(2)}</strong><small>${escapeHtml(names[a])} • ${bp.toFixed(2)} ${escapeHtml(names[b])}</small></div><div class="record-card"><span>Highest Meeting Score</span><strong>${highest?Math.max(highest.aScore,highest.bScore).toFixed(2):'—'}</strong><small>${highest?`${highest.season} • Week ${highest.week}`:'—'}</small></div><div class="record-card"><span>Closest Finish</span><strong>${closest?closest.margin.toFixed(2):'—'}</strong><small>${closest?`${closest.season} • Week ${closest.week}`:'—'}</small></div><div class="record-card"><span>Biggest Beatdown</span><strong>${biggest?biggest.margin.toFixed(2):'—'}</strong><small>${biggest?`${biggest.season} • Week ${biggest.week}`:'—'}</small></div><div class="record-card"><span>Playoff Meetings</span><strong>${playoffs}</strong><small>postseason receipts</small></div>`;
}

function computePain(){if(!state.archive)return[];const names=ownerNameMap(),map=new Map(state.archive.franchises.map(f=>[f.ownerId,{ownerId:f.ownerId,name:f.name,score:f.finals*25,runnerUps:f.finals,closeLosses:0,highLosses:0,pa:f.pa}]));const allScores=state.archive.teamGames.map(g=>g.points).sort((a,b)=>a-b);const threshold=allScores.length?allScores[Math.floor(allScores.length*.75)]:0;state.archive.pairedGames.forEach(g=>{if(!g.loser)return;const e=map.get(g.loser);if(!e)return;if(g.margin<=5){e.closeLosses++;e.score+=5;}const loserScore=g.loser===g.a?g.aScore:g.bScore;if(loserScore>=threshold){e.highLosses++;e.score+=4;}});const maxPa=Math.max(...[...map.values()].map(e=>e.pa),1);map.forEach(e=>e.score+=10*(e.pa/maxPa));return[...map.values()].sort((a,b)=>b.score-a.score);}
function computeRivalries(){if(!state.archive)return[];const names=ownerNameMap(),map=new Map();state.archive.pairedGames.forEach(g=>{const ids=[g.a,g.b].sort(),key=ids.join('|');if(!map.has(key))map.set(key,{a:ids[0],b:ids[1],aName:names[ids[0]]||ids[0],bName:names[ids[1]]||ids[1],games:0,playoffs:0,close:0,aWins:0,bWins:0});const e=map.get(key);e.games++;if(g.type==='Playoffs')e.playoffs++;if(g.margin<=5)e.close++;if(g.winner===e.a)e.aWins++;if(g.winner===e.b)e.bWins++;});return[...map.values()].map(e=>{const parity=e.games?1-Math.abs(e.aWins-e.bWins)/e.games:0;e.score=e.games*2+e.playoffs*6+e.close*3+parity*10;return e;}).sort((a,b)=>b.score-a.score);}

function renderFranchiseHall(){
  if(!state.archive)return;const rows=state.archive.franchises;
  $('franchise-table').innerHTML=rows.map((f,i)=>`<tr class="profile-row" data-owner-id="${escapeHtml(f.ownerId)}" tabindex="0"><td class="rank big-rank">${i+1}</td><td><strong>${escapeHtml(f.name)}</strong><span class="tap-hint">View profile →</span></td><td>${f.seasons}</td><td class="gold-score">${f.titles}</td><td>${f.playoffs}</td><td>${f.wins}-${f.losses}</td><td>${pct(f.winPct)}</td><td>${f.pf.toFixed(1)}</td><td class="gold-score">${f.goat.toFixed(1)}</td></tr>`).join('');
  $('goat-podium').innerHTML=rows.slice(0,3).map((f,i)=>`<div class="podium-row place-${i+1}" data-owner-id="${escapeHtml(f.ownerId)}"><span>${i===0?'♛':i===1?'Ⅱ':'Ⅲ'}</span><div><strong>${escapeHtml(f.name)}</strong><small>${f.titles} titles • ${f.playoffs} playoffs</small></div><b>${f.goat.toFixed(1)}</b></div>`).join('');
  $('pain-index').innerHTML=computePain().slice(0,6).map((e,i)=>`<div class="rank-row"><span>${i+1}</span><div><strong>${escapeHtml(e.name)}</strong><small>${e.runnerUps} finals losses • ${e.closeLosses} close losses • ${e.highLosses} high-score losses</small></div><b>${e.score.toFixed(1)}</b></div>`).join('');
  $('rivalry-index').innerHTML=computeRivalries().slice(0,6).map((e,i)=>`<div class="rank-row"><span>${i+1}</span><div><strong>${escapeHtml(e.aName)} vs ${escapeHtml(e.bName)}</strong><small>${e.games} meetings • ${e.playoffs} playoffs • ${e.close} nail-biters</small></div><b>${e.score.toFixed(1)}</b></div>`).join('');
  const options=rows.map(f=>`<option value="${escapeHtml(f.ownerId)}">${escapeHtml(f.name)}</option>`).join('');
  $('franchise-select').innerHTML=options;
  if(rows[0])renderFranchiseProfile(rows[0].ownerId);
  $$('.profile-row').forEach(row=>{const open=()=>{renderFranchiseProfile(row.dataset.ownerId);$('franchise-profile').scrollIntoView({behavior:'smooth',block:'start'});};row.addEventListener('click',open);row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});});
  $$('#goat-podium [data-owner-id]').forEach(row=>row.addEventListener('click',()=>renderFranchiseProfile(row.dataset.ownerId)));
  $('franchise-loading').classList.add('hidden');$('franchise-content').classList.remove('hidden');$('franchise-profile').classList.remove('hidden');
}

function renderFranchiseProfile(ownerId){
  if(!state.archive)return;const f=state.archive.franchises.find(x=>x.ownerId===ownerId);if(!f)return;
  $('franchise-select').value=ownerId;$('profile-title').textContent=f.name;
  const games=state.archive.teamGames.filter(g=>g.ownerId===ownerId).sort((a,b)=>b.points-a.points);
  const rivalry=computeRivalries().find(r=>r.a===ownerId||r.b===ownerId);
  const seasons=seasonItemForOwner(ownerId).map(item=>{const row=rosterTable(item).find(r=>r.ownerId===ownerId);const champ=champion(item).ownerId===ownerId;const runner=runnerUp(item).ownerId===ownerId;return row?{...row,season:item.league.season,champ,runner}:null;}).filter(Boolean);
  const user=ownerUser(ownerId),avatar=avatarUrl(user);const high=games[0];
  const rivalName=rivalry?(rivalry.a===ownerId?rivalry.bName:rivalry.aName):'—';
  $('franchise-profile-content').innerHTML=`<div class="profile-hero"><div class="profile-avatar">${avatar?`<img src="${avatar}" alt="">`:'♛'}</div><div><span class="profile-kicker">${f.seasons} SEASONS • ${f.titles} TITLES</span><strong>${escapeHtml(f.name)}</strong><small>${f.wins}-${f.losses} career • ${pct(f.winPct)} win rate</small></div><b>${f.goat.toFixed(1)}<small>DOL</small></b></div>
  <div class="profile-metrics"><div><span>Career PF</span><strong>${f.pf.toFixed(1)}</strong></div><div><span>Playoffs</span><strong>${f.playoffs}</strong></div><div><span>Finals</span><strong>${f.finals+f.titles}</strong></div><div><span>Best Season</span><strong>${f.bestSeason?`${f.bestSeason.wins}-${f.bestSeason.losses}`:'—'}</strong></div><div><span>High Week</span><strong>${high?high.points.toFixed(2):'—'}</strong></div><div><span>Top Rival</span><strong>${escapeHtml(rivalName)}</strong></div></div>
  <div class="profile-split"><div><p class="eyebrow">SEASON LEDGER</p><div class="profile-season-list">${seasons.map(x=>`<div><span>${x.season}</span><strong>${x.wins}-${x.losses}</strong><small>${x.pf.toFixed(1)} PF</small><b>${x.champ?'🏆':x.runner?'🥈':''}</b></div>`).join('')}</div></div><div><p class="eyebrow">BIGGEST WEEKS</p><div class="rank-list">${games.slice(0,5).map((g,i)=>`<div class="rank-row"><span>${i+1}</span><div><strong>${g.points.toFixed(2)}</strong><small>${g.season} • Week ${g.week} • ${g.type}</small></div><b>🔥</b></div>`).join('')}</div></div></div>`;
}

function renderTeamRecords(){if(!state.archive)return;const games=state.archive.teamGames,pairs=state.archive.pairedGames;const high=[...games].sort((a,b)=>b.points-a.points)[0],low=[...games].filter(g=>g.points>0).sort((a,b)=>a.points-b.points)[0],blow=[...pairs].sort((a,b)=>b.margin-a.margin)[0],close=[...pairs].sort((a,b)=>a.margin-b.margin)[0],losses=pairs.filter(g=>g.loser).map(g=>({manager:g.loser===g.a?g.aName:g.bName,points:g.loser===g.a?g.aScore:g.bScore,season:g.season,week:g.week,winner:g.winner===g.a?g.aName:g.bName})).sort((a,b)=>b.points-a.points),bad=losses[0];
  const cards=[['Highest Team Week',high?high.points.toFixed(2):'—',high?`${high.manager} • ${high.season} W${high.week}`:'—','🔥'],['Lowest Team Week',low?low.points.toFixed(2):'—',low?`${low.manager} • ${low.season} W${low.week}`:'—','🧊'],['Biggest Blowout',blow?blow.margin.toFixed(2):'—',blow?`${blow.aName} vs ${blow.bName} • ${blow.season} W${blow.week}`:'—','💥'],['Closest Finish',close?close.margin.toFixed(2):'—',close?`${close.aName} vs ${close.bName} • ${close.season} W${close.week}`:'—','🪒'],['Highest-Scoring Loss',bad?bad.points.toFixed(2):'—',bad?`${bad.manager} lost to ${bad.winner} • ${bad.season} W${bad.week}`:'—','☠'],['Highest Combined Game',pairs.length?[...pairs].sort((a,b)=>b.total-a.total)[0].total.toFixed(2):'—',pairs.length?(()=>{const g=[...pairs].sort((a,b)=>b.total-a.total)[0];return `${g.aName} vs ${g.bName} • ${g.season} W${g.week}`;})():'—','⚔']];
  $('team-record-cards').innerHTML=cards.map(c=>`<article class="showcase-card"><span class="showcase-icon">${c[3]}</span><small>${c[0]}</small><strong>${c[1]}</strong><p>${escapeHtml(c[2])}</p></article>`).join('');
  const seasonRows=[];state.history.forEach(item=>rosterTable(item).forEach(r=>seasonRows.push({...r,season:item.league.season})));seasonRows.sort((a,b)=>b.pf-a.pf);$('season-records').innerHTML=seasonRows.slice(0,25).map((r,i)=>`<tr><td class="rank">${i+1}</td><td>${r.season}</td><td><strong>${escapeHtml(r.manager)}</strong></td><td>${r.wins}-${r.losses}</td><td class="gold-score">${r.pf.toFixed(2)}</td><td>${r.pa.toFixed(2)}</td></tr>`).join('');
}


function renderCareerRecords(){
  if(!state.archive)return;const fs=state.archive.franchises;if(!fs.length)return;
  const min3=fs.filter(f=>f.seasons>=3);const top=(arr,key)=>[...arr].sort((a,b)=>b[key]-a[key])[0];
  const bestPct=[...(min3.length?min3:fs)].sort((a,b)=>b.winPct-a.winPct)[0];
  const categories=[['Most Championships',top(fs,'titles'),'titles','♛'],['Most Career Wins',top(fs,'wins'),'wins','✓'],['Most Career PF',top(fs,'pf'),'pf','Σ'],['Best Win Rate',bestPct,'winPct','%'],['Most Playoff Trips',top(fs,'playoffs'),'playoffs','🏁'],['Highest DOL Index',top(fs,'goat'),'goat','★']];
  $('career-record-cards').innerHTML=categories.map(([label,f,key,icon])=>{let value='—';if(f){value=key==='winPct'?pct(f[key]):key==='pf'?f[key].toFixed(1):key==='goat'?f[key].toFixed(1):String(f[key]);}return `<article class="showcase-card"><span class="showcase-icon">${icon}</span><small>${label}</small><strong>${value}</strong><p>${escapeHtml(f?.name||'—')}</p></article>`;}).join('');
}

async function loadPlayerMap(){if(state.playerMap)return state.playerMap;if(state.playerMapPromise)return state.playerMapPromise;$('player-db-note').textContent='Loading Sleeper player directory...';state.playerMapPromise=api('/players/nfl').then(data=>{state.playerMap=data||{};$('player-db-note').textContent='Player names resolved from Sleeper.';return state.playerMap;}).catch(()=>{state.playerMap={};$('player-db-note').textContent='Player directory unavailable; Sleeper player IDs are shown instead.';return state.playerMap;});return state.playerMapPromise;}
function playerInfo(id){const p=state.playerMap?.[id];if(!p)return{name:`Player ${id}`,meta:''};return{name:p.full_name||[p.first_name,p.last_name].filter(Boolean).join(' ')||`Player ${id}`,meta:[p.position,p.team].filter(Boolean).join(' • ')}};
function renderPlayerRecords(){const games=[...(state.archive?.playerGames||[])].filter(g=>g.points>0).sort((a,b)=>b.points-a.points).slice(0,50);$('player-records').innerHTML=games.length?games.map((g,i)=>{const p=playerInfo(g.playerId);return`<tr><td class="rank big-rank">${i+1}</td><td class="team-cell"><strong>${escapeHtml(p.name)}</strong><span>${escapeHtml(p.meta)}</span></td><td class="gold-score">${g.points.toFixed(2)}</td><td>${g.season}</td><td>${g.week}</td><td>${escapeHtml(g.manager)}</td></tr>`;}).join(''):'<tr><td colspan="6" class="empty-cell">No player scoring data found in the matchup archive.</td></tr>';}

async function showRecordView(view){state.recordView=view;$$('.record-tab').forEach(b=>b.classList.toggle('active',b.dataset.recordView===view));$$('.record-panel').forEach(p=>p.classList.add('hidden'));$(`${view}-records-panel`).classList.remove('hidden');if(view==='player'){ $('records-loading').classList.remove('hidden');$('records-status').textContent='Loading players';await loadPlayerMap();renderPlayerRecords();$('records-loading').classList.add('hidden');$('records-status').textContent='Archive loaded';}}

function seasonWeeklyHighs(item){const highs=[];item.matchups.forEach(({week,data})=>{const ownerByRoster=Object.fromEntries(item.rosters.map(r=>[Number(r.roster_id),r.owner_id]));const users=Object.fromEntries(item.users.map(u=>[u.user_id,u]));const best=[...data].sort((a,b)=>Number(b.points||0)-Number(a.points||0))[0];if(best){const owner=ownerByRoster[Number(best.roster_id)],u=users[owner];highs.push({week,manager:managerName(u),points:Number(best.points||0)});}});return highs;}
function renderSeasonExplorer(index=0){const item=state.history[index];if(!item)return;const champ=champion(item),runner=runnerUp(item),table=rosterTable(item),highs=seasonWeeklyHighs(item).sort((a,b)=>b.points-a.points).slice(0,5);const bracket=(item.winnersBracket||[]).filter(g=>g.w!=null).sort((a,b)=>Number(b.r)-Number(a.r));$('season-explorer-content').innerHTML=`<article class="panel explorer-hero"><div><p class="eyebrow gold">${escapeHtml(item.league.season)} CHAMPION</p><h2>${escapeHtml(champ.franchise)}</h2><p>${escapeHtml(champ.record)} • defeated ${escapeHtml(runner.franchise)}</p></div><span>♛</span></article><article class="panel"><div class="panel-head"><div><p class="eyebrow">FINAL REGULAR SEASON</p><h2>Standings</h2></div></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Franchise</th><th>Record</th><th>PF</th><th>PA</th></tr></thead><tbody>${standingsRowsHtml(table,false)}</tbody></table></div></article><article class="panel"><div class="panel-head"><div><p class="eyebrow">WEEKLY CEILINGS</p><h2>Top Weekly Scores</h2></div></div><div class="rank-list">${highs.length?highs.map((h,i)=>`<div class="rank-row"><span>${i+1}</span><div><strong>${escapeHtml(h.manager)}</strong><small>Week ${h.week}</small></div><b>${h.points.toFixed(2)}</b></div>`).join(''):'<div class="empty-cell">Load the archive to see weekly highs.</div>'}</div></article><article class="panel"><div class="panel-head"><div><p class="eyebrow">POSTSEASON</p><h2>Playoff Summary</h2></div></div><div class="bracket-summary">${bracket.length?bracket.map(g=>{const w=rosterIdentity(item,g.w),l=rosterIdentity(item,g.l);return`<div><span>${g.p===1?'Championship':`Round ${g.r}`}</span><strong>${escapeHtml(w.franchise)}</strong><small>def. ${escapeHtml(l.franchise)}</small></div>`;}).join(''):'<div class="empty-cell">No completed playoff bracket data.</div>'}</div></article>`;}


function rosterTradeIdentity(item, rosterId){
  const ident=rosterIdentity(item,rosterId);return ident.manager||ident.franchise||`Roster ${rosterId}`;
}
function pickLabel(p){return `${p.season} Round ${p.round}`;}
function pickResolutionKey(season, round, rosterId){return `${season}|${Number(round)}|${Number(rosterId)}`;}
function pickSlotLabel(round, slot){return `${Number(round)}.${String(Number(slot)).padStart(2,'0')}`;}
async function loadDraftResolutionsForSeason(season){
  const seasonKey=String(season);
  if(state.draftResolutionSeasons.has(seasonKey))return;
  if(state.draftResolutionPromises.has(seasonKey))return state.draftResolutionPromises.get(seasonKey);
  const promise=(async()=>{
    const item=state.history.find(h=>String(h.league.season)===seasonKey);
    if(!item){state.draftResolutionSeasons.add(seasonKey);return;}
    const drafts=await api(`/league/${item.league.league_id}/drafts`).catch(()=>[]);
    const complete=(Array.isArray(drafts)?drafts:[]).filter(d=>d?.draft_id&&d.status==='complete');
    const candidates=new Map();
    await Promise.all(complete.map(async draft=>{
      const [detail,picks]=await Promise.all([
        api(`/draft/${draft.draft_id}`).catch(()=>draft),
        api(`/draft/${draft.draft_id}/picks`).catch(()=>[])
      ]);
      const slotMap=detail?.slot_to_roster_id||draft?.slot_to_roster_id||{};
      const rounds=Number(detail?.settings?.rounds||draft?.settings?.rounds||99);
      for(const pick of (Array.isArray(picks)?picks:[])){
        const slot=Number(pick.draft_slot||0);
        const originalRoster=Number(slotMap[String(slot)]||0);
        if(!originalRoster||!pick.round)continue;
        const draftSeason=String(detail?.season||draft?.season||item.league.season);
        const key=pickResolutionKey(draftSeason,pick.round,originalRoster);
        const player=playerInfo(pick.player_id);
        const candidate={season:draftSeason,round:Number(pick.round),slot,originalRoster,playerId:pick.player_id,playerName:player.name,playerMeta:player.meta,draftId:draft.draft_id,rounds,startTime:Number(detail?.start_time||draft?.start_time||0)};
        const existing=state.draftResolutions.get(key)||candidates.get(key);
        if(!existing||candidate.rounds<existing.rounds||(candidate.rounds===existing.rounds&&candidate.startTime>existing.startTime))candidates.set(key,candidate);
      }
    }));
    candidates.forEach((value,key)=>state.draftResolutions.set(key,value));
    state.draftResolutionSeasons.add(seasonKey);
  })().finally(()=>state.draftResolutionPromises.delete(seasonKey));
  state.draftResolutionPromises.set(seasonKey,promise);
  return promise;
}
async function loadDraftResolutionsForTrades(txs){
  const current=Number(state.league?.season||0);
  const seasons=[...new Set(txs.flatMap(t=>(t.draft_picks||[]).map(p=>String(p.season))).filter(s=>Number(s)<=current))];
  await Promise.all(seasons.map(loadDraftResolutionsForSeason));
}
function resolvedPick(p){return state.draftResolutions.get(pickResolutionKey(p.season,p.round,p.roster_id))||null;}
function tradeSeasonItem(season){return state.history.find(item=>String(item.league.season)===String(season))||null;}
function populateTradeSeasons(){
  const seasons=state.history.map(item=>String(item.league.season)).sort((a,b)=>Number(b)-Number(a));
  $('trade-season').innerHTML=seasons.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')+'<option value="all">All seasons (slow)</option>';
  const current=String(state.league?.season||seasons[0]||'');
  $('trade-season').value=seasons.includes(current)?current:(seasons[0]||'all');
}
async function loadTradesForSeason(season){
  const seasonKey=String(season);
  if(state.tradesBySeason.has(seasonKey))return state.tradesBySeason.get(seasonKey);
  if(state.tradePromisesBySeason.has(seasonKey))return state.tradePromisesBySeason.get(seasonKey);
  const item=tradeSeasonItem(seasonKey);
  if(!item){state.tradesBySeason.set(seasonKey,[]);return [];}
  const promise=(async()=>{
    const rounds=Array.from({length:CONFIG.maxWeeksPerSeason+1},(_,i)=>i);
    let cursor=0;const found=new Map();
    const workers=Array.from({length:4},async()=>{
      while(cursor<rounds.length){
        const round=rounds[cursor++];
        const txs=await api(`/league/${item.league.league_id}/transactions/${round}`).catch(()=>[]);
        (Array.isArray(txs)?txs:[]).filter(t=>t.type==='trade'&&t.status==='complete').forEach(t=>{
          if(!found.has(t.transaction_id))found.set(t.transaction_id,{...t,season:item.league.season,item});
        });
      }
    });
    await Promise.all(workers);
    const txs=[...found.values()].sort((a,b)=>Number(b.created||0)-Number(a.created||0));
    state.tradesBySeason.set(seasonKey,txs);
    await loadPlayerMap();
    await loadDraftResolutionsForTrades(txs);
    state.trades=[...state.tradesBySeason.values()].flat().sort((a,b)=>Number(b.created||0)-Number(a.created||0));
    return txs;
  })().finally(()=>state.tradePromisesBySeason.delete(seasonKey));
  state.tradePromisesBySeason.set(seasonKey,promise);
  return promise;
}
async function loadSelectedTradeSeason(){
  const selected=$('trade-season').value||String(state.league?.season||'');
  $('trades-loading').classList.remove('hidden');$('trades-content').classList.add('hidden');
  $('trades-loading').innerHTML='<span class="spinner"></span>Loading '+escapeHtml(selected==='all'?'all trade seasons':`${selected} trades`)+'…';
  if(selected==='all'){
    const seasons=state.history.map(item=>String(item.league.season));
    for(const season of seasons)await loadTradesForSeason(season);
  }else await loadTradesForSeason(selected);
  renderTrades();
}
async function loadTrades(){
  populateTradeSeasons();
  return loadSelectedTradeSeason();
}
function tradeAssets(t, rosterId){
  const received=[];Object.entries(t.adds||{}).filter(([,rid])=>Number(rid)===Number(rosterId)).forEach(([pid])=>received.push({type:'player',label:playerInfo(pid).name,meta:playerInfo(pid).meta}));
  (t.draft_picks||[]).filter(p=>Number(p.owner_id)===Number(rosterId)).forEach(p=>{
    const resolved=resolvedPick(p);
    if(resolved){
      received.push({type:'pick resolved-pick',label:`${p.season} ${pickSlotLabel(p.round,resolved.slot)} → ${resolved.playerName}`,meta:`Originally roster ${p.roster_id} • ${resolved.playerMeta||'drafted player'}`});
    }else{
      const isPast=Number(p.season)<Number(state.league?.season||0);
      received.push({type:'pick',label:pickLabel(p),meta:`${isPast?'Draft result unavailable':'Future pick'} • original roster ${p.roster_id}`});
    }
  });
  (t.waiver_budget||[]).filter(w=>Number(w.receiver)===Number(rosterId)).forEach(w=>received.push({type:'faab',label:`$${w.amount} FAAB`,meta:'waiver budget'}));
  return received;
}
function tradeAssetCount(t){return Object.keys(t.adds||{}).length+(t.draft_picks||[]).length+(t.waiver_budget||[]).length;}
function renderTrades(){
  const filter=$('trade-season').value||String(state.league?.season||'');
  const txs=filter==='all'?[...state.tradesBySeason.values()].flat():state.tradesBySeason.get(String(filter))||[];
  const activity=new Map();let picks=0;txs.forEach(t=>{(t.roster_ids||[]).forEach(r=>{const n=rosterTradeIdentity(t.item,r);activity.set(n,(activity.get(n)||0)+1);});picks+=(t.draft_picks||[]).length;});const active=[...activity.entries()].sort((a,b)=>b[1]-a[1])[0];const biggest=[...txs].sort((a,b)=>tradeAssetCount(b)-tradeAssetCount(a))[0];
  $('trade-count').textContent=txs.length;$('trade-most-active').textContent=active?.[0]||'—';$('trade-most-active-detail').textContent=active?`${active[1]} trades involved`:'—';$('trade-biggest').textContent=biggest?tradeAssetCount(biggest):'—';$('trade-picks').textContent=picks;
  $('trade-list').innerHTML=txs.length?txs.map(t=>{const ids=t.roster_ids||[];const date=t.created?new Date(Number(t.created)).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):`${t.season} W${t.leg||'?'}`;return `<article class="trade-card"><div class="trade-card-head"><div><span>${escapeHtml(t.season)} • Week ${t.leg??'—'}</span><strong>${escapeHtml(date)}</strong></div><b>${tradeAssetCount(t)} assets</b></div><div class="trade-sides">${ids.map((rid,i)=>{const assets=tradeAssets(t,rid);return `<div class="trade-side"><h3>${escapeHtml(rosterTradeIdentity(t.item,rid))}</h3><span class="received-label">RECEIVED</span>${assets.length?assets.map(a=>`<div class="asset ${a.type}"><span>${a.type==='pick'?'◇':a.type==='faab'?'$':'●'}</span><div><strong>${escapeHtml(a.label)}</strong><small>${escapeHtml(a.meta||'')}</small></div></div>`).join(''):'<div class="asset empty"><div><strong>No mapped incoming assets</strong><small>Sleeper transaction metadata may be incomplete.</small></div></div>'}</div>${i<ids.length-1?'<div class="trade-arrow">⇄</div>':''}`;}).join('')}</div></article>`;}).join(''):`<article class="panel empty-cell">No completed trades found for ${escapeHtml(filter==='all'?'the loaded seasons':filter)}.</article>`;
  $('trades-loading').classList.add('hidden');$('trades-content').classList.remove('hidden');
}

async function ensureArchive(){if(!state.matchupsLoaded){$('h2h-loading').classList.remove('hidden');$('franchise-loading').classList.remove('hidden');$('records-loading').classList.remove('hidden');await loadAllMatchups();$('h2h-loading').classList.add('hidden');$('records-loading').classList.add('hidden');}renderH2HSelectors();renderFranchiseHall();renderTeamRecords();renderCareerRecords();renderSeasonExplorer(Number($('explorer-season').value||0));}

function activateView(name){$$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$$('.view').forEach(v=>v.classList.toggle('active-view',v.id===`${name}-view`));}
async function navigate(name){activateView(name);try{if(['franchises','headtohead','records','season'].includes(name))await ensureArchive();if(name==='trades')await loadTrades();if(name==='headtohead')renderH2H();if(name==='records')await showRecordView(state.recordView);}catch(e){showError(`Historical analytics could not finish loading: ${e.message}`);}}

async function load(){clearError();setApiState('loading','Connecting to Sleeper');$('league-meta').textContent='Loading league...';try{state.league=await api(`/league/${CONFIG.primaryLeagueId}`);[state.users,state.rosters,state.nflState]=await Promise.all([api(`/league/${CONFIG.primaryLeagueId}/users`),api(`/league/${CONFIG.primaryLeagueId}/rosters`),api('/state/nfl').catch(()=>null)]);renderCurrentLeague();renderCurrentWeek();setApiState('','Live Sleeper data');try{await loadHistory();setApiState('','Live + history ready');loadAllMatchups().then(()=>{renderOverviewLegends();}).catch(()=>{});}catch(e){showError(`Current league loaded, but history could not finish: ${e.message}`);}}catch(e){showError(`Could not load Sleeper league ${CONFIG.primaryLeagueId}: ${e.message}`);}}

$$('.nav-item').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.view)));$$('[data-jump]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.jump)));$('season-select').addEventListener('change',e=>renderStandingsSeason(Number(e.target.value)));$('explorer-season').addEventListener('change',e=>renderSeasonExplorer(Number(e.target.value)));$('franchise-select').addEventListener('change',e=>renderFranchiseProfile(e.target.value));$('trade-season').addEventListener('change',loadSelectedTradeSeason);$('h2h-a').addEventListener('change',renderH2H);$('h2h-b').addEventListener('change',renderH2H);$$('.record-tab').forEach(b=>b.addEventListener('click',()=>showRecordView(b.dataset.recordView)));$('refresh-btn').addEventListener('click',()=>location.reload());
load();
