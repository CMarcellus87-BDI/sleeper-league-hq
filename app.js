import {
  gradeLetter,
  edgePct,
  isUnplayedWeek,
  rankAmong,
  buildPlayerIndex,
  realizedForSide,
  attributionShare,
  traceAssetForward,
  percentileRank,
  valueWeightedAge,
  strengthScore,
  timelineScore,
  classifyWindow,
  windowDirective,
  windowComplement,
  starterSlotCounts,
  replacementLevels,
  surplusValue,
  rosterCrunchCost,
  realizedSettledShare
} from './analytics.js?v=10.0.0';
import {
  optimalLineup,
  weekEfficiency,
  accumulateAllPlay,
  luckIndex,
  scheduleSwap,
  coachingRecord
} from './efficiency.js?v=10.0.0';
import {
  NAV,
  DEFAULT_ROUTE,
  routeId,
  parseRoute,
  resolveRoute,
  routeHash,
  itemsForGroup
} from './routing.js?v=10.0.0';
import {
  powerRankings,
  managerActivity,
  countEmptySlots,
  countZeroStarters
} from './pulse.js?v=10.0.0';
import {
  aggregateUsage,
  mergeSnapCounts,
  usageTrend,
  risingUsage,
  fadingUsage,
  crossReferenceTrending
} from './usage.js?v=10.0.0';
import {
  makeRng,
  scoringProfile,
  leagueScoringProfile,
  simulatePlayoffOdds
} from './simulation.js?v=10.0.0';
import {
  waiverLeaderboard,
  waiverExtremes,
  draftSlotBaselines,
  gradeDraftPicks,
  draftLeaderboard,
  reportCard,
  summarizeStints
} from './insights.js?v=10.0.0';
import {
  buildNameIndex,
  matchRankings,
  marketPositionRanks,
  arbitrage,
  coverageSummary,
  arbitrageThresholds,
  matchProjections,
  startSitAdvice
} from './fantasypros.js?v=10.0.0';

// Optional local overrides. `config.local.js` is gitignored and excluded from
// release archives, so settings survive upgrades and never reach the repo.
// Its absence is expected and harmless.
let LOCAL = {};
try { LOCAL = (await import('./config.local.js')).default || {}; } catch { LOCAL = {}; }

const CONFIG = {
  primaryLeagueId: new URLSearchParams(location.search).get('league') || LOCAL.primaryLeagueId || '1326583431680761856',
  apiBase: 'https://api.sleeper.app/v1',
  maxHistorySeasons: 20,
  maxWeeksPerSeason: 18,
  matchupConcurrency: 4,
  version: '10.0.0',
  valueApiBase: 'https://api.statsguyfantasy.com/api/v1',
  // Deployed proxy that holds the FantasyPros key. Empty disables ECR features.
  // See worker/fantasypros-proxy.js for the Cloudflare Worker, or api/ for Vercel.
  proxyBase: LOCAL.proxyBase || ''
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
  playerMapFull: false,
  archive: null,
  recordView: 'team',
  view: 'overview',
  tradesBySeason: new Map(),
  tradePromisesBySeason: new Map(),
  draftResolutions: new Map(),
  draftResolutionSeasons: new Set(),
  draftResolutionPromises: new Map(),
  marketPlayers: new Map(),
  marketPicks: new Map(),
  marketLoaded: false,
  marketPromise: null,
  marketError: null,
  tradeLabRendered: false,
  currentTradedPicks: null,
  tradeGradesBySeason: new Map(),
  tradeGradePromises: new Map(),
  tradeLabSelections: {a:new Set(), b:new Set()},
  h2hMode: 'matchups',
  tradeRelationshipsLoaded: false,
  tradeRelationshipsPromise: null,
  liveRefreshTimer: null,
  lastLiveUpdate: null,
  pickValueWarned: false,
  efficiency: null,
  efficiencyPromise: null,
  labSeason: 'all',
  ecr: null,
  ecrPromise: null,
  ecrError: null,
  ecrUnmatched: 0,
  ecrCoverage: null,
  projections: null,
  projectionsPromise: null,
  projectionsError: null,
  projectionFields: [],
  waiversBySeason: new Map(),
  waiversLoaded: false,
  odds: null,
  oddsPromise: null,
  oddsError: null,
  labTab: 'efficiency',
  playerQuery: '',
  selectedPlayer: null,
  usage: null,
  usagePromise: null,
  usageError: null,
  usageByGsis: null,
  trending: null,
  trendingPromise: null,
  pulseSeason: null,
  route: {...DEFAULT_ROUTE},
  chainMode: false,
  lineageReady: false,
  lineagePromise: null,
  lineageByTrade: new Map()
};

// Roster-derived values are pure functions of (rosters, traded picks, market
// data, player map). The Assistant re-derives them thousands of times per
// render, so memoise and invalidate explicitly when an input lands.
const memo = {
  rosterAssets: new Map(),
  playerPool: new Map(),
  snapshot: new Map(),
  pickOwners: null,
  dropIndex: null,
  windows: null,
  replacement: null
};
function clearRosterMemo() {
  memo.rosterAssets.clear();
  memo.playerPool.clear();
  memo.snapshot.clear();
  memo.pickOwners = null;
  memo.dropIndex = null;
  memo.windows = null;
  memo.replacement = null;
}

const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];

const apiInflight = new Map();
const apiQueue = [];
let apiActive = 0;
const API_CONCURRENCY = 5;

function pumpApiQueue(){
  while(apiActive < API_CONCURRENCY && apiQueue.length){
    const job=apiQueue.shift(); apiActive++;
    job.run().finally(()=>{apiActive--;pumpApiQueue();});
  }
}
function queuedFetch(url, options={}){
  return new Promise((resolve,reject)=>{
    apiQueue.push({run:async()=>{try{resolve(await fetch(url,options));}catch(e){reject(e);}}});
    pumpApiQueue();
  });
}
async function api(path) {
  if(apiInflight.has(path)) return apiInflight.get(path);
  const promise=(async()=>{
    let lastError;
    for(let attempt=0;attempt<3;attempt++){
      try{
        const response=await queuedFetch(`${CONFIG.apiBase}${path}`,{cache:'no-store'});
        if(response.status===429 || response.status>=500){
          const wait=Number(response.headers.get('Retry-After')||0)*1000 || 500*(attempt+1);
          await new Promise(r=>setTimeout(r,wait));
          lastError=new Error(`${path} returned HTTP ${response.status}`);
          continue;
        }
        if(!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
        return response.json();
      }catch(e){lastError=e;if(attempt<2)await new Promise(r=>setTimeout(r,350*(attempt+1)));}
    }
    throw lastError||new Error(`${path} failed`);
  })().finally(()=>apiInflight.delete(path));
  apiInflight.set(path,promise); return promise;
}

function cacheGet(key,maxAgeMs){
  try{const raw=localStorage.getItem(key);if(!raw)return null;const obj=JSON.parse(raw);if(!obj?.savedAt||Date.now()-obj.savedAt>maxAgeMs)return null;return obj.data;}catch{return null;}
}
function cacheSet(key,data){
  try{localStorage.setItem(key,JSON.stringify({savedAt:Date.now(),data}));return true;}
  catch(e){console.warn(`Cache write failed for ${key} (likely localStorage quota):`,e?.name||e);return false;}
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
  return state.nflState?.season_type === 'pre' ? 1 : Number(state.nflState?.week || 1);
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
    const workers=Array.from({length:CONFIG.matchupConcurrency},async()=>{while(cursor<tasks.length){const task=tasks[cursor++];const data=await api(`/league/${task.item.league.league_id}/matchups/${task.week}`).catch(()=>[]);if(Array.isArray(data)&&data.length&&!isUnplayedWeek(data))task.item.matchups.push({week:task.week,data});}});
    await Promise.all(workers);state.history.forEach(item=>item.matchups.sort((a,b)=>a.week-b.week));state.matchupsLoaded=true;state.archive=buildArchive();renderOverviewLegends();
  })();return state.matchupsPromise;
}

function buildArchive(){
  const names=ownerNameMap(); const teamGames=[]; const pairedGames=[]; const playerGames=[]; const franchise=new Map();
  state.history.forEach(item=>{
    const users=Object.fromEntries(item.users.map(u=>[u.user_id,u])); const ownerByRoster=Object.fromEntries(item.rosters.map(r=>[Number(r.roster_id),r.owner_id])); const table=rosterTable(item); const playoffIds=playoffRosterIds(item); const champ=champion(item); const runner=runnerUp(item);
    table.forEach(r=>{if(!r.ownerId)return; if(!franchise.has(r.ownerId))franchise.set(r.ownerId,{ownerId:r.ownerId,name:r.manager,seasons:0,titles:0,finals:0,playoffs:0,wins:0,losses:0,ties:0,pf:0,pa:0,bestSeason:null});const f=franchise.get(r.ownerId);f.name=r.manager||f.name;f.seasons++;f.wins+=r.wins;f.losses+=r.losses;f.pf+=r.pf;f.pa+=r.pa;if(playoffIds.has(r.rosterId))f.playoffs++;if(champ.ownerId===r.ownerId)f.titles++;if(runner.ownerId===r.ownerId)f.finals++;const candidate={season:item.league.season,wins:r.wins,losses:r.losses,pf:r.pf};if(!f.bestSeason||candidate.wins>f.bestSeason.wins||(candidate.wins===f.bestSeason.wins&&candidate.pf>f.bestSeason.pf))f.bestSeason=candidate;});
    item.matchups.forEach(({week,data})=>{
      const seasonNum=Number(item.league.season);
      data.forEach(m=>{const ownerId=ownerByRoster[Number(m.roster_id)]; if(!ownerId)return; const user=users[ownerId];teamGames.push({ownerId,manager:managerName(user),season:item.league.season,week,points:Number(m.points||0),type:week>regularSeasonEnd(item)?'Playoffs':'Regular'});const starters=new Set((m.starters||[]).map(String));Object.entries(m.players_points||{}).forEach(([playerId,pts])=>{const points=Number(pts);if(Number.isFinite(points))playerGames.push({playerId,points,ownerId,manager:managerName(user),season:item.league.season,seasonNum,week,started:starters.has(String(playerId))});});});
      const groups={};data.forEach(m=>{if(m.matchup_id!=null)(groups[m.matchup_id]||=[]).push(m);});Object.values(groups).filter(p=>p.length===2).forEach(pair=>{const a=pair[0],b=pair[1],oa=ownerByRoster[Number(a.roster_id)],ob=ownerByRoster[Number(b.roster_id)];if(!oa||!ob)return;const sa=Number(a.points||0),sb=Number(b.points||0);pairedGames.push({season:item.league.season,week,type:week>regularSeasonEnd(item)?'Playoffs':'Regular',a:oa,b:ob,aName:names[oa]||oa,bName:names[ob]||ob,aScore:sa,bScore:sb,winner:sa===sb?null:(sa>sb?oa:ob),loser:sa===sb?null:(sa>sb?ob:oa),margin:Math.abs(sa-sb),total:sa+sb});});
    });
  });
  const franchises=[...franchise.values()].map(f=>{const gp=f.wins+f.losses;f.winPct=gp?f.wins/gp:0;f.goat=f.titles*100+f.finals*45+f.playoffs*15+f.wins*2+f.pf/100;return f;}).sort((a,b)=>b.goat-a.goat);
  return {teamGames,pairedGames,playerGames,franchises,playerIndex:buildPlayerIndex(playerGames)};
}

function renderOverviewLegends(){if(!state.archive)return;const top=state.archive.franchises[0];const score=[...state.archive.teamGames].sort((a,b)=>b.points-a.points)[0];const rivalry=computeRivalries()[0];$('overview-legends').innerHTML=`<div class="mini-award"><span>GOAT Leader</span><strong>${escapeHtml(top?.name||'—')}</strong><small>${top?top.goat.toFixed(1)+' DOL':'—'}</small></div><div class="mini-award"><span>Highest Team Week</span><strong>${score?score.points.toFixed(2):'—'}</strong><small>${score?`${escapeHtml(score.manager)} • ${score.season} W${score.week}`:'—'}</small></div><div class="mini-award"><span>Top Rivalry</span><strong>${rivalry?`${escapeHtml(rivalry.aName)} vs ${escapeHtml(rivalry.bName)}`:'—'}</strong><small>${rivalry?`${rivalry.games} meetings • ${rivalry.score.toFixed(1)} index`:'—'}</small></div>`;}

function renderH2HSelectors(){const managers=managerDirectory(),a=$('h2h-a').value,b=$('h2h-b').value,opts=managers.map(m=>`<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');$('h2h-a').innerHTML=opts;$('h2h-b').innerHTML=opts;$('h2h-a').value=managers.some(m=>m.id===a)?a:managers[0]?.id||'';$('h2h-b').value=managers.some(m=>m.id===b)?b:managers[1]?.id||managers[0]?.id||'';}
function matchupArchive(a,b){return (state.archive?.pairedGames||[]).filter(g=>(g.a===a&&g.b===b)||(g.a===b&&g.b===a)).sort((x,y)=>Number(y.season)-Number(x.season)||y.week-x.week);}
function renderH2H(){if(!state.archive)return;const a=$('h2h-a').value,b=$('h2h-b').value,names=ownerNameMap();if(!a||!b||a===b){$('h2h-results').innerHTML='<tr><td colspan="7" class="empty-cell">Choose two different managers.</td></tr>';return;}const games=matchupArchive(a,b),aw=games.filter(g=>g.winner===a).length,bw=games.filter(g=>g.winner===b).length;$('h2h-a-label').textContent=names[a]||'Manager A';$('h2h-b-label').textContent=names[b]||'Manager B';$('h2h-a-wins').textContent=aw;$('h2h-b-wins').textContent=bw;$('h2h-games').textContent=games.length;
  $('h2h-results').innerHTML=games.length?games.map(g=>{
    const winnerName=g.winner?names[g.winner]:'Tie', loserName=g.loser?names[g.loser]:'Tie';
    const winnerScore=g.winner===g.a?g.aScore:g.winner===g.b?g.bScore:g.aScore;
    const loserScore=g.loser===g.a?g.aScore:g.loser===g.b?g.bScore:g.bScore;
    return `<tr><td>${escapeHtml(g.season)}</td><td>${g.week}</td><td><strong>${escapeHtml(winnerName)}</strong></td><td>${winnerScore.toFixed(2)}</td><td>${escapeHtml(loserName)}</td><td>${loserScore.toFixed(2)}</td><td>${g.margin.toFixed(2)}</td></tr>`;
  }).join(''):'<tr><td colspan="7" class="empty-cell">No matchups found between these managers.</td></tr>';
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

// Sleeper's /players/nfl payload is several megabytes. Caching it whole always
// blew the localStorage quota, so the 24h cache silently never worked. Keep
// only the fields the UI reads (plus age/experience, which the cut-candidate
// and timeline logic need) and the map fits comfortably.
function slimPlayerCard(p){
  const card={};
  if(p.full_name)card.full_name=p.full_name;
  if(p.first_name)card.first_name=p.first_name;
  if(p.last_name)card.last_name=p.last_name;
  if(p.position)card.position=p.position;
  if(p.team)card.team=p.team;
  if(p.age!=null)card.age=Number(p.age);
  if(p.years_exp!=null)card.years_exp=Number(p.years_exp);
  if(p.injury_status)card.injury_status=p.injury_status;
  // The nflverse join key. Exact ids beat name matching, and it costs one field.
  if(p.gsis_id)card.gsis_id=p.gsis_id;
  return card;
}
function mergePlayerCards(cards={}){
  state.playerMap=state.playerMap||{};
  Object.entries(cards||{}).forEach(([id,p])=>{
    if(!p)return;
    const slim=slimPlayerCard(p);
    if(!slim.full_name&&!slim.first_name&&!slim.last_name&&!slim.position)return;
    state.playerMap[String(id)]={...(state.playerMap[String(id)]||{}),...slim};
  });
}
function mergeMarketPlayerNames(players=[]){
  state.playerMap=state.playerMap||{};
  (players||[]).forEach(p=>{if(!p?.id)return;const id=String(p.id),existing=state.playerMap[id]||{};state.playerMap[id]={...existing,player_id:id,full_name:existing.full_name||p.name||'',first_name:existing.first_name||'',last_name:existing.last_name||'',position:existing.position||p.position||'',team:existing.team||p.team||''};});
}
async function loadPlayerMap(){
  if(state.playerMapFull&&state.playerMap)return state.playerMap;
  if(state.playerMapPromise)return state.playerMapPromise;
  state.playerMapPromise=(async()=>{
    const note=$('player-db-note');if(note)note.textContent='Resolving player names…';
    const cached=cacheGet('dol-player-directory-v3',24*60*60*1000);
    if(cached&&typeof cached==='object'){mergePlayerCards(cached);state.playerMapFull=true;clearRosterMemo();if(note)note.textContent='Player names loaded from daily cache.';return state.playerMap;}
    // Fast first layer: Stats Guy returns Sleeper IDs plus current player
    // metadata. ensureMarketData owns that fetch so we don't request it twice.
    try{await ensureMarketData();}catch{}
    if(note)note.textContent='Loading full Sleeper player directory for historical names…';
    try{
      const full=await api('/players/nfl');
      mergePlayerCards(full||{});state.playerMapFull=true;clearRosterMemo();
      const stored=cacheSet('dol-player-directory-v3',state.playerMap);
      if(note)note.textContent=stored?'Player names resolved from Sleeper.':'Player names resolved (too large to cache this session).';
    }catch{
      if(note)note.textContent=Object.keys(state.playerMap||{}).length?'Current player names loaded; some retired players may still show IDs.':'Player directory unavailable; Sleeper player IDs are shown instead.';
    }
    return state.playerMap||{};
  })().finally(()=>state.playerMapPromise=null);
  return state.playerMapPromise;
}
function playerInfo(id){const key=String(id),p=state.playerMap?.[key],m=state.marketPlayers.get(key);if(!p&&!m)return{name:`Player ${key}`,meta:'',position:'',age:null,yearsExp:null,gsisId:null};return{name:p?.full_name||[p?.first_name,p?.last_name].filter(Boolean).join(' ')||m?.name||`Player ${key}`,meta:[p?.position||m?.position,p?.team||m?.team].filter(Boolean).join(' • '),position:p?.position||m?.position||'',age:p?.age??null,yearsExp:p?.years_exp??null,gsisId:p?.gsis_id||null,injuryStatus:p?.injury_status||null};};
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
async function loadTradeIndexForSeason(season){
  const seasonKey=String(season);
  if(state.tradesBySeason.has(seasonKey))return state.tradesBySeason.get(seasonKey);
  if(state.tradePromisesBySeason.has(`index:${seasonKey}`))return state.tradePromisesBySeason.get(`index:${seasonKey}`);
  const item=tradeSeasonItem(seasonKey);if(!item){state.tradesBySeason.set(seasonKey,[]);return[];}
  const cacheKey=`dol:tx:${item.league.league_id}:v2`;
  const isCurrent=String(state.league?.season)===seasonKey;
  const cached=cacheGet(cacheKey,isCurrent?5*60*1000:30*24*60*60*1000);
  if(Array.isArray(cached)){const txs=cached.map(t=>({...t,season:item.league.season,item}));state.tradesBySeason.set(seasonKey,txs);memo.dropIndex=null;state.lineageByTrade.clear();return txs;}
  const promise=(async()=>{
    const rounds=Array.from({length:CONFIG.maxWeeksPerSeason+1},(_,i)=>i);
    let cursor=0;const found=new Map(),claims=[];
    const workers=Array.from({length:6},async()=>{while(cursor<rounds.length){const round=rounds[cursor++];const txs=await api(`/league/${item.league.league_id}/transactions/${round}`).catch(()=>[]);const list=Array.isArray(txs)?txs:[];
      list.filter(t=>t.type==='trade'&&t.status==='complete').forEach(t=>{if(!found.has(t.transaction_id))found.set(t.transaction_id,{...t,season:item.league.season,item});});
      // Waiver and free-agent claims arrive in the same response and used to be
      // thrown away. They cost nothing extra to keep.
      list.filter(t=>(t.type==='waiver'||t.type==='free_agent')&&t.status==='complete').forEach(t=>{
        Object.entries(t.adds||{}).forEach(([playerId,rosterId])=>{
          claims.push({transactionId:t.transaction_id,playerId:String(playerId),rosterId:Number(rosterId),bid:Number(t.settings?.waiver_bid)||0,type:t.type,created:Number(t.created||0),leg:Number(t.leg)||null,season:item.league.season,item});
        });
      });}});
    await Promise.all(workers);
    const txs=[...found.values()].sort((a,b)=>Number(b.created||0)-Number(a.created||0));
    cacheSet(cacheKey,txs.map(({item:drop,...rest})=>rest));
    state.waiversBySeason.set(seasonKey,claims);
    state.tradesBySeason.set(seasonKey,txs);memo.dropIndex=null;state.lineageByTrade.clear();return txs;
  })().finally(()=>state.tradePromisesBySeason.delete(`index:${seasonKey}`));
  state.tradePromisesBySeason.set(`index:${seasonKey}`,promise);return promise;
}
async function loadTradesForSeason(season){
  const seasonKey=String(season);
  const existing=state.tradesBySeason.get(seasonKey);
  // If already hydrated, return it.
  if(existing&&existing._hydrated)return existing;
  if(state.tradePromisesBySeason.has(seasonKey))return state.tradePromisesBySeason.get(seasonKey);
  const promise=(async()=>{
    const txs=existing||await loadTradeIndexForSeason(seasonKey);
    await loadPlayerMap();
    await loadDraftResolutionsForTrades(txs);
    try{Object.defineProperty(txs,'_hydrated',{value:true,configurable:true});}catch{}
    return txs;
  })().finally(()=>state.tradePromisesBySeason.delete(seasonKey));
  state.tradePromisesBySeason.set(seasonKey,promise);return promise;
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


async function valueApi(path, options={}){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch(`${CONFIG.valueApiBase}${path}`,{...options,signal:controller.signal,headers:{'Content-Type':'application/json',...(options.headers||{})}});
    if(!response.ok)throw new Error(`value API ${path} returned HTTP ${response.status}`);
    return response.json();
  }finally{clearTimeout(timeout);}
}
function dynastyFormat(){
  const slots=state.league?.roster_positions||[];
  const sf=slots.includes('SUPER_FLEX')||slots.filter(x=>x==='QB').length>1;
  return sf?'sf_dynasty':'non_sf_dynasty';
}
async function ensureMarketData(){
  if(state.marketLoaded)return true;
  if(state.marketPromise)return state.marketPromise;
  state.marketPromise=(async()=>{
    try{
      let players=await valueApi('/players').catch(()=>null);
      if(!players?.players?.length){
        const board=await valueApi(`/rankings?format=${dynastyFormat()}&limit=1000`).catch(()=>({rankings:[]}));
        players={players:(board.rankings||[]).map(x=>({...x,value:{[dynastyFormat()]:Number(x.value||0)}}))};
      }
      const picks=await valueApi('/picks').catch(()=>({picks:[]}));
      (players.players||[]).forEach(x=>state.marketPlayers.set(String(x.id),x));
      mergeMarketPlayerNames(players.players||[]);
      (picks.picks||[]).forEach(x=>state.marketPicks.set(String(x.id),x));
      state.marketLoaded=state.marketPlayers.size>0||state.marketPicks.size>0;
      clearRosterMemo();
      state.marketError=state.marketLoaded?null:'Market values unavailable right now';
      return state.marketLoaded;
    }catch(e){
      state.marketError=e?.name==='AbortError'?'Market value service timed out':'Market values unavailable right now';
      return false;
    }
  })().finally(()=>state.marketPromise=null);
  return state.marketPromise;
}
function marketValueForPlayer(id){return Number(state.marketPlayers.get(String(id))?.value?.[dynastyFormat()]||0);}
function pickMarketId(season,round,slot=null){return slot?`pick:${season}:${Number(round)}.${String(slot).padStart(2,'0')}`:`pick:${season}:${Number(round)}:mid`;}
function marketValueForPick(season,round,slot=null){
  const exact=pickMarketId(season,round,slot), generic=pickMarketId(season,round,null), bare=`pick:${season}:${Number(round)}`;
  const p=state.marketPicks.get(exact)||state.marketPicks.get(generic)||state.marketPicks.get(bare);
  return Number(p?.value?.[dynastyFormat()]||0);
}
function tradeDateISO(t){return t.created?new Date(Number(t.created)).toISOString().slice(0,10):null;}
function genericHistoricalPickId(p){return `pick:${p.season}:${Number(p.round)}:mid`;}
function currentAssetIdForPick(p){const r=resolvedPick(p);return r?.playerId?String(r.playerId):genericHistoricalPickId(p);}
function sideReceivedIds(t,rid,mode='then'){
  const ids=[];
  Object.entries(t.adds||{}).filter(([,r])=>Number(r)===Number(rid)).forEach(([pid])=>ids.push(String(pid)));
  (t.draft_picks||[]).filter(p=>Number(p.owner_id)===Number(rid)).forEach(p=>ids.push(mode==='now'?currentAssetIdForPick(p):genericHistoricalPickId(p)));
  return ids.slice(0,20);
}
function chunks(arr,n){const out=[];for(let i=0;i<arr.length;i+=n)out.push(arr.slice(i,i+n));return out;}
async function batchEvaluate(entries){
  const valid=(entries||[]).filter(x=>x?.body?.sideA?.length&&x?.body?.sideB?.length);
  const evaluateGroup=async group=>{
    if(!group.length)return[];
    try{
      const data=await valueApi('/trades/evaluate/batch',{method:'POST',body:JSON.stringify({trades:group.map(x=>x.body)})});
      return (data.results||[]).map((r,i)=>({key:group[i].key,result:r}));
    }catch(e){
      // Batch validation is atomic. Split failures so one odd historical deal does not erase a whole season.
      if(group.length===1){
        try{const result=await valueApi('/trades/evaluate',{method:'POST',body:JSON.stringify(group[0].body)});return[{key:group[0].key,result}];}
        catch(singleErr){console.warn('Trade grade unavailable for',group[0].key,singleErr);return[];}
      }
      const mid=Math.ceil(group.length/2);
      const [left,right]=await Promise.all([evaluateGroup(group.slice(0,mid)),evaluateGroup(group.slice(mid))]);
      return [...left,...right];
    }
  };
  const out=[];for(const group of chunks(valid,25))out.push(...await evaluateGroup(group));return out;
}
function normalizeGrade(t, thenResult, nowResult){
  const ids=t.roster_ids||[];if(ids.length!==2)return null;
  const aName=rosterTradeIdentity(t.item,ids[0]),bName=rosterTradeIdentity(t.item,ids[1]);
  const toSide=(r,key)=>Number(r?.[key]?.totalValue||0);
  // A missing result used to fall through as 0 vs 0, which graded out as a
  // confident "B" for both sides. An ungradeable trade must render as unknown.
  const calc=(r)=>{
    if(!r)return null;
    const a=toSide(r,'sideA'),b=toSide(r,'sideB');
    if(!a&&!b)return null;
    return{a,b,aEdge:edgePct(a,b),bEdge:edgePct(b,a)};
  };
  const now=calc(nowResult),then=calc(thenResult);
  return{transactionId:t.transaction_id,aRoster:ids[0],bRoster:ids[1],aName,bName,date:tradeDateISO(t),then,now,thenRaw:thenResult,nowRaw:nowResult};
}
async function gradeTradesForSeason(season,txs){
  const key=String(season);if(state.tradeGradesBySeason.has(key))return state.tradeGradesBySeason.get(key);if(state.tradeGradePromises.has(key))return state.tradeGradePromises.get(key);
  const promise=(async()=>{
    const valid=txs.filter(t=>(t.roster_ids||[]).length===2);
    const nowEntries=valid.map(t=>({key:t.transaction_id,body:{format:dynastyFormat(),sideA:sideReceivedIds(t,t.roster_ids[0],'now'),sideB:sideReceivedIds(t,t.roster_ids[1],'now')}}));
    const thenEntries=valid.filter(t=>tradeDateISO(t)&&tradeDateISO(t)>='2025-09-01').map(t=>({key:t.transaction_id,body:{format:dynastyFormat(),date:tradeDateISO(t),sideA:sideReceivedIds(t,t.roster_ids[0],'then'),sideB:sideReceivedIds(t,t.roster_ids[1],'then')}}));
    const [nowRows,thenRows]=await Promise.all([batchEvaluate(nowEntries),batchEvaluate(thenEntries)]);
    const nowMap=new Map(nowRows.map(x=>[x.key,x.result])),thenMap=new Map(thenRows.map(x=>[x.key,x.result]));
    const grades=new Map();valid.forEach(t=>grades.set(t.transaction_id,normalizeGrade(t,thenMap.get(t.transaction_id)||null,nowMap.get(t.transaction_id)||null)));
    state.tradeGradesBySeason.set(key,grades);return grades;
  })().finally(()=>state.tradeGradePromises.delete(key));
  state.tradeGradePromises.set(key,promise);return promise;
}
// ---------------------------------------------------------------------------
// Realized-points grading
//
// Market snapshots only exist from 2025-09-01, which left every earlier trade
// ungradeable at the time it happened. But the matchup archive already holds
// every player's weekly score AND whether they were in the starting lineup, for
// the whole history of the league. That gives a snapshot-free outcome measure:
// how many points did the assets each side received actually put in the lineup
// for that manager, from the trade forward. Ownership comes from the weekly
// matchup snapshot itself, so a player flipped again later simply stops
// accruing to the original acquirer.
// ---------------------------------------------------------------------------
function tradeChrono(t){
  const season=Number(t.season||t.item?.league?.season||0);
  const week=Number(t.leg);
  return{season,week:Number.isFinite(week)&&week>0?week:null};
}
function receivedForPoints(t,rid){
  const playerIds=[],assets=[];
  Object.entries(t.adds||{}).filter(([,r])=>Number(r)===Number(rid)).forEach(([pid])=>{playerIds.push(String(pid));assets.push({kind:'player'});});
  (t.draft_picks||[]).filter(p=>Number(p.owner_id)===Number(rid)).forEach(p=>{
    const resolved=resolvedPick(p);
    if(resolved?.playerId){playerIds.push(String(resolved.playerId));assets.push({kind:'resolvedPick'});}
    else assets.push({kind:'unresolvedPick'});
  });
  (t.waiver_budget||[]).filter(w=>Number(w.receiver)===Number(rid)).forEach(()=>assets.push({kind:'faab'}));
  return{playerIds,assets};
}
function realizedTradeSummary(t){
  const index=state.archive?.playerIndex;
  const ids=t.roster_ids||[];
  if(!index||ids.length!==2)return null;
  const {season,week}=tradeChrono(t);
  if(!season)return null;
  const sides=ids.map(rid=>{
    const ownerId=tradeOwnerId(t.item,rid);
    const {playerIds,assets}=receivedForPoints(t,rid);
    const totals=ownerId?realizedForSide(index,playerIds,ownerId,season,week):{started:0,rostered:0,startedWeeks:0,rosteredWeeks:0,counted:0};
    return{rosterId:Number(rid),ownerId,assets,...totals};
  });
  if(!sides[0].rosteredWeeks&&!sides[1].rosteredWeeks)return null;
  const settled=realizedSettledShare([...sides[0].assets,...sides[1].assets]);
  return{
    settled,
    byRoster:new Map(sides.map((s,i)=>[s.rosterId,{...s,edge:edgePct(s.started,sides[1-i].started)}]))
  };
}
// ---------------------------------------------------------------------------
// Chain-following ("what it actually became")
//
// The realized grade above stops the moment an asset is traded again. But if
// you flipped the player you got for two others a month later, the real outcome
// of the original trade is those two others. This walks each received asset
// forward through every subsequent trade by the same manager, splitting credit
// proportionally when an asset leaves as part of a package.
//
// Attribution uses current market value as a proxy for value at the time of the
// flip, because historical snapshots only exist from 2025-09-01. Where no
// values are available it falls back to an even split. Both are approximations
// and the UI says so.
// ---------------------------------------------------------------------------

function tradeDropIndex(){
  if(memo.dropIndex)return memo.dropIndex;
  const index=new Map();
  for(const t of [...state.tradesBySeason.values()].flat()){
    for(const [pid,rid] of Object.entries(t.drops||{})){
      const key=String(pid);
      let bucket=index.get(key);
      if(!bucket){bucket=[];index.set(key,bucket);}
      bucket.push({trade:t,rosterId:Number(rid),created:Number(t.created||0)});
    }
  }
  for(const bucket of index.values())bucket.sort((a,b)=>a.created-b.created);
  memo.dropIndex=index;return index;
}
function nextTradeSendingPlayer(playerId,ownerId,afterCreated){
  for(const entry of tradeDropIndex().get(String(playerId))||[]){
    if(entry.created<=afterCreated)continue;
    const rid=rosterIdForOwnerInTrade(entry.trade,ownerId);
    if(rid==null||Number(rid)!==entry.rosterId)continue;
    return entry.trade;
  }
  return null;
}
function outgoingAssetsFor(t,rid){
  const out=[];
  Object.entries(t.drops||{}).filter(([,r])=>Number(r)===Number(rid)).forEach(([pid])=>out.push({kind:'player',id:String(pid),label:playerInfo(pid).name,value:marketValueForPlayer(pid)}));
  (t.draft_picks||[]).filter(p=>Number(p.previous_owner_id)===Number(rid)).forEach(p=>{
    const resolved=resolvedPick(p);
    out.push({kind:'pick',id:`pick:${p.season}:${p.round}:${p.roster_id}`,label:resolved?.playerName?`${pickLabel(p)} (${resolved.playerName})`:pickLabel(p),value:resolved?.playerId?marketValueForPlayer(resolved.playerId):marketValueForPick(p.season,p.round)});
  });
  return out;
}
function lineageContext(){
  return{
    playerIndex:state.archive.playerIndex,
    describe:id=>{const p=playerInfo(id);return{name:p.name,meta:p.meta};},
    nextFlip:(playerId,ownerId,afterCreated)=>nextTradeSendingPlayer(playerId,ownerId,afterCreated),
    rosterFor:(t,ownerId)=>rosterIdForOwnerInTrade(t,ownerId),
    outgoing:(t,rid)=>outgoingAssetsFor(t,rid),
    received:(t,rid)=>receivedForPoints(t,rid).playerIds,
    chrono:t=>tradeChrono(t),
    createdOf:t=>Number(t.created||0),
    idOf:t=>t.transaction_id,
    seasonOf:t=>t.season,
    dateOf:t=>tradeDateISO(t)
  };
}
function lineageTradeSummary(t){
  if(!state.lineageReady||!state.archive?.playerIndex)return null;
  const ids=t.roster_ids||[];
  if(ids.length!==2)return null;
  const cached=state.lineageByTrade.get(t.transaction_id);
  if(cached!==undefined)return cached;
  const from=tradeChrono(t);
  if(!from.season){state.lineageByTrade.set(t.transaction_id,null);return null;}
  const sides=ids.map(rid=>{
    const ownerId=tradeOwnerId(t.item,rid);
    const {playerIds,assets}=receivedForPoints(t,rid);
    const roots=[];let total=0,hops=0;
    if(ownerId){
      const ctx=lineageContext();
      for(const pid of playerIds){
        const traced=traceAssetForward(ctx,pid,ownerId,from,Number(t.created||0),1,0,new Set());
        roots.push(traced.node);total+=traced.total;hops+=traced.hops;
      }
    }
    return{rosterId:Number(rid),ownerId,assets,roots,total,hops};
  });
  if(!sides[0].total&&!sides[1].total){state.lineageByTrade.set(t.transaction_id,null);return null;}
  const summary={
    settled:realizedSettledShare([...sides[0].assets,...sides[1].assets]),
    hops:sides[0].hops+sides[1].hops,
    byRoster:new Map(sides.map((s,i)=>[s.rosterId,{...s,edge:edgePct(s.total,sides[1-i].total)}]))
  };
  state.lineageByTrade.set(t.transaction_id,summary);
  return summary;
}
function lineageNodeHtml(node,depth=0){
  const pct=Math.round(node.weight*100);
  const creditText=node.weight<0.999?` • ${pct}% credited`:'';
  const held=`${node.held.toFixed(1)} started pts${creditText}`;
  const flip=node.flip
    ?`<div class="lineage-step lineage-flip"><b>${escapeHtml(node.flip.date||String(node.flip.season))}</b><span>→</span><div><strong>Flipped${node.flip.packaged?' as part of a package':''}</strong><small>${node.flip.returned} asset${node.flip.returned===1?'':'s'} back${node.flip.packaged?` • ${Math.round(node.flip.share*100)}% of the return attributed here`:''}</small></div></div>`
    :'<div class="lineage-step lineage-end"><b>End</b><span>→</span><div><strong>Never traded again</strong><small>chain terminates here</small></div></div>';
  return `<div class="lineage-node" style="--depth:${depth}"><div class="lineage-step"><b>${depth?'↳':'◆'}</b><span></span><div><strong>${escapeHtml(node.name)}</strong><small>${escapeHtml(held)}</small></div></div>${flip}${node.children.map(c=>lineageNodeHtml(c,depth+1)).join('')}</div>`;
}
function renderLineageChain(transactionId,rosterId){
  const box=$(`chain-${transactionId}-${rosterId}`);
  if(!box)return;
  const t=[...state.tradesBySeason.values()].flat().find(x=>x.transaction_id===transactionId);
  const side=t?lineageTradeSummary(t)?.byRoster?.get(Number(rosterId)):null;
  box.classList.remove('hidden');
  if(!side||!side.roots.length){box.textContent='No traceable scoring chain on this side.';return;}
  box.innerHTML=`${side.roots.map(n=>lineageNodeHtml(n)).join('')}<div class="lineage-note">Package splits use current market value as a proxy for value at the time of each flip.</div>`;
}
function bindChainButtons(){
  $$('.chain-button').forEach(btn=>btn.addEventListener('click',()=>renderLineageChain(btn.dataset.chainId,Number(btn.dataset.chainRoster))));
}
async function ensureLineageData(){
  if(state.lineageReady)return true;
  if(state.lineagePromise)return state.lineagePromise;
  const node=$('trade-analytics-loading');
  state.lineagePromise=(async()=>{
    const seasons=state.history.map(item=>String(item.league.season)).sort((a,b)=>Number(a)-Number(b));
    const step=(text)=>{if(node){node.innerHTML=`<span class="spinner"></span>${text}`;node.classList.remove('hidden');}};
    step('Loading scoring archive…');
    await loadAllMatchups();
    step('Loading player names…');
    await loadPlayerMap();
    for(let i=0;i<seasons.length;i++){
      step(`Loading trade history ${i+1}/${seasons.length} seasons…`);
      await loadTradeIndexForSeason(seasons[i]);
      await loadDraftResolutionsForSeason(seasons[i]);
    }
    step('Loading market values for package attribution…');
    await ensureMarketData().catch(()=>false);
    memo.dropIndex=null;
    state.lineageByTrade.clear();
    state.lineageReady=true;
    if(node)node.classList.add('hidden');
    return true;
  })().catch(e=>{
    if(node){node.innerHTML=`Chain grades could not finish loading: ${escapeHtml(e.message)}`;node.classList.remove('hidden');}
    return false;
  }).finally(()=>state.lineagePromise=null);
  return state.lineagePromise;
}
async function setChainMode(on){
  state.chainMode=!!on;
  const toggle=$('trade-chain-toggle');
  if(toggle)toggle.setAttribute('aria-pressed',String(state.chainMode));
  if(state.chainMode)await ensureLineageData();
  renderTrades();
}

// Chain mode swaps the realized grade for the lineage-adjusted one, falling
// back to the direct grade for any trade the chain walker cannot resolve.
function tradeOutcomeSummary(t){
  if(state.chainMode){
    const chained=lineageTradeSummary(t);
    if(chained)return{...chained,chain:true};
  }
  return realizedTradeSummary(t);
}
function chainButtonHtml(t,rid,realized){
  if(!realized?.chain)return '';
  const side=realized.byRoster.get(Number(rid));
  if(!side?.hops)return '';
  const id=escapeHtml(t.transaction_id);
  return `<button type="button" class="chain-button" data-chain-id="${id}" data-chain-roster="${rid}">Show the value chain →</button><div class="lineage-box hidden" id="chain-${id}-${rid}"></div>`;
}

function realizedCellHtml(realized,rid){
  const side=realized?.byRoster?.get(Number(rid));
  if(!side)return '';
  const settledText=realized.settled!=null?` • ${Math.round(realized.settled*100)}% settled`:'';
  const points=side.total!=null?side.total:side.started;
  if(realized.chain){
    return `<div><span>CHAIN</span><strong>${gradeLetter(side.edge)}</strong><small>${points.toFixed(1)} chained pts • ${side.hops} hop${side.hops===1?'':'s'}${settledText}</small></div>`;
  }
  return `<div><span>SINCE TRADE</span><strong>${gradeLetter(side.edge)}</strong><small>${points.toFixed(1)} started pts${settledText}</small></div>`;
}
function tradeGradeHtml(g,rid,realized){
  const cells=[];
  if(g){
    const isA=Number(rid)===Number(g.aRoster);
    if(g.then)cells.push(`<div><span>THEN</span><strong>${gradeLetter(isA?g.then.aEdge:g.then.bEdge)}</strong><small>Market grade when dealt</small></div>`);
    if(g.now)cells.push(`<div><span>NOW</span><strong>${gradeLetter(isA?g.now.aEdge:g.now.bEdge)}</strong><small>Value of the assets today</small></div>`);
  }
  const realizedCell=realizedCellHtml(realized,rid);
  if(realizedCell)cells.push(realizedCell);
  if(!cells.length)return '';
  const sizeClass=cells.length===1?' grade-strip-single':cells.length===3?' grade-strip-triple':'';
  return `<div class="grade-strip${sizeClass}">${cells.join('')}</div>`;
}
function renderTradeAwards(txs,grades){
  const candidates=[];txs.forEach(t=>{const g=grades?.get(t.transaction_id);if(!g?.now)return;candidates.push({t,g,rid:g.aRoster,name:g.aName,edge:g.now.aEdge,then:g.then?.aEdge??null});candidates.push({t,g,rid:g.bRoster,name:g.bName,edge:g.now.bEdge,then:g.then?.bEdge??null});});
  if(!candidates.length){$('trade-awards').classList.add('hidden');return;}
  const best=[...candidates].sort((a,b)=>b.edge-a.edge)[0],worst=[...candidates].sort((a,b)=>a.edge-b.edge)[0];
  const gamble=[...candidates].filter(x=>x.then!=null&&x.then<-3&&x.edge>8).sort((a,b)=>(b.edge-b.then)-(a.edge-a.then))[0];
  const process=[...candidates].filter(x=>x.then!=null&&x.then>3&&x.edge<-8).sort((a,b)=>(a.edge-a.then)-(b.edge-b.then))[0];
  const card=(label,x,icon)=>x?`<button type="button" class="trade-award-card" data-trade-jump="${escapeHtml(x.t.transaction_id)}"><span>${icon}</span><small>${label}</small><strong>${escapeHtml(x.name)}</strong><b>${gradeLetter(x.edge)}</b><p>${x.t.season} • ${tradeDateISO(x.t)||`Week ${x.t.leg||'?'}`} • open trade →</p></button>`:'';
  $('trade-awards').innerHTML=card('Best Trade Outcome',best,'🏆')+card('Worst Trade Outcome',worst,'💀')+card('Best Gamble',gamble,'🎲')+card('Good Process, Bad Result',process,'🫠');$('trade-awards').classList.remove('hidden');
}
function bindTradeAwardJumps(){
  $$('[data-trade-jump]').forEach(btn=>btn.addEventListener('click',()=>{const card=$(`trade-${btn.dataset.tradeJump}`);if(!card)return;card.scrollIntoView({behavior:'smooth',block:'center'});card.classList.add('trade-card-highlight');setTimeout(()=>card.classList.remove('trade-card-highlight'),1800);}));
}
function currentRosterForOwner(ownerId){return state.rosters.find(r=>r.owner_id===ownerId)||null;}
function pickKey(originalRoster,season,round){return `${Number(originalRoster)}|${season}|${Number(round)}`;}
function pickOwnerIndex(){
  if(memo.pickOwners)return memo.pickOwners;
  const index=new Map();
  for(const p of state.currentTradedPicks||[]){
    if(p?.roster_id==null||p?.owner_id==null)continue;
    index.set(pickKey(p.roster_id,String(p.season),p.round),Number(p.owner_id));
  }
  memo.pickOwners=index;return index;
}
function pickOwnerFor(originalRoster,season,round){
  const moved=pickOwnerIndex().get(pickKey(originalRoster,String(season),round));
  return moved==null?Number(originalRoster):moved;
}
function currentDraftCapital(rosterId){
  const base=Number(state.league?.season||new Date().getFullYear())+1,rounds=Number(state.league?.settings?.draft_rounds||4),years=[base,base+1,base+2],out=[];
  for(const year of years)for(let round=1;round<=rounds;round++)for(const original of state.rosters.map(r=>Number(r.roster_id)))if(pickOwnerFor(original,year,round)===Number(rosterId))out.push({season:year,round,originalRoster:original,value:marketValueForPick(year,round)});
  // If the value service has pick data but none of our IDs resolve, the key
  // format has drifted. Fail loudly once instead of silently valuing every
  // future pick at zero.
  if(out.length&&state.marketPicks.size&&!state.pickValueWarned&&out.every(p=>!p.value)){
    state.pickValueWarned=true;
    console.warn('No draft-pick market values matched. Expected ids like',pickMarketId(base,1),'but the service returned keys such as',[...state.marketPicks.keys()].slice(0,5));
    state.marketError=state.marketError||'Draft-pick values unavailable (pick ID format mismatch)';
  }
  return out;
}
function rosterAssets(ownerId){
  const cached=memo.rosterAssets.get(ownerId);if(cached)return cached;
  const built=buildRosterAssets(ownerId);
  memo.rosterAssets.set(ownerId,built);
  return built;
}
function buildRosterAssets(ownerId){
  const roster=currentRosterForOwner(ownerId);if(!roster)return[];
  const starters=new Set((roster.starters||[]).map(String)),taxi=new Set((roster.taxi||[]).map(String)),reserve=new Set((roster.reserve||[]).map(String));
  const players=(roster.players||[]).map(id=>{const p=playerInfo(id);return{id:String(id),type:'player',label:p.name,meta:[p.meta,starters.has(String(id))?'Starter':taxi.has(String(id))?'Taxi':reserve.has(String(id))?'IR/Reserve':'Bench'].filter(Boolean).join(' • '),value:marketValueForPlayer(id),age:p.age,yearsExp:p.yearsExp};}).sort((a,b)=>b.value-a.value);
  const picks=currentDraftCapital(roster.roster_id).map(p=>({id:`pick:${p.season}:${p.round}:mid|orig:${p.originalRoster}`,type:'pick',label:`${p.season} Round ${p.round}`,meta:p.originalRoster===Number(roster.roster_id)?'Own pick':`From roster ${p.originalRoster}`,value:p.value}));
  return [...players,...picks];
}
function rosterProfileHtml(ownerId){
  const roster=currentRosterForOwner(ownerId);if(!roster)return '<div class="empty-cell">This manager does not control a current-season roster.</div>';
  const assets=rosterAssets(ownerId),players=assets.filter(a=>a.type==='player'),picks=assets.filter(a=>a.type==='pick');
  const total=assets.reduce((n,a)=>n+a.value,0);
  return `<div class="roster-module"><div class="panel-head"><div><p class="eyebrow">CURRENT DYNASTY ASSETS</p><h2>Roster & Draft Capital</h2></div><strong class="market-total">${Math.round(total).toLocaleString()}</strong></div><div class="roster-value-grid">${['QB','RB','WR','TE'].map(pos=>{const group=players.filter(a=>a.meta.startsWith(pos));return `<div><span>${pos}</span><strong>${group.length}</strong><small>${Math.round(group.reduce((n,a)=>n+a.value,0)).toLocaleString()} value</small></div>`;}).join('')}</div><div class="roster-assets">${players.map(a=>`<div class="roster-asset"><div><strong>${escapeHtml(a.label)}</strong><small>${escapeHtml(a.meta)}</small></div><b>${state.marketLoaded?(a.value?Math.round(a.value).toLocaleString():'—'):'…'}</b></div>`).join('')}</div><p class="eyebrow roster-pick-head">DRAFT CAPITAL</p><div class="pick-chip-row">${picks.length?picks.map(a=>`<span class="pick-chip"><strong>${escapeHtml(a.label)}</strong><small>${escapeHtml(a.meta)} • ${a.value?Math.round(a.value).toLocaleString():'—'}</small></span>`).join(''):'<span class="empty-cell">No future picks mapped.</span>'}</div><div class="market-credit">Values by <a href="https://statsguyfantasy.com" target="_blank" rel="noopener">Stats Guy Fantasy</a></div></div>`;
}
function renderFranchiseProfile(ownerId){
  if(!state.archive)return;const f=state.archive.franchises.find(x=>x.ownerId===ownerId);if(!f)return;
  $('franchise-select').value=ownerId;$('profile-title').textContent=f.name;
  const games=state.archive.teamGames.filter(g=>g.ownerId===ownerId).sort((a,b)=>b.points-a.points),rivalry=computeRivalries().find(r=>r.a===ownerId||r.b===ownerId);
  const seasons=seasonItemForOwner(ownerId).map(item=>{const row=rosterTable(item).find(r=>r.ownerId===ownerId);return row?{...row,season:item.league.season,champ:champion(item).ownerId===ownerId,runner:runnerUp(item).ownerId===ownerId}:null;}).filter(Boolean);
  const user=ownerUser(ownerId),avatar=avatarUrl(user),high=games[0],rivalName=rivalry?(rivalry.a===ownerId?rivalry.bName:rivalry.aName):'—';
  $('franchise-profile-content').innerHTML=`<div class="profile-hero"><div class="profile-avatar">${avatar?`<img src="${escapeHtml(avatar)}" alt="">`:'♛'}</div><div><span class="profile-kicker">${f.seasons} SEASONS • ${f.titles} TITLES</span><strong>${escapeHtml(f.name)}</strong><small>${f.wins}-${f.losses} career • ${pct(f.winPct)} win rate</small></div><b>${f.goat.toFixed(1)}<small>DOL</small></b></div><div class="profile-metrics"><div><span>Career PF</span><strong>${f.pf.toFixed(1)}</strong></div><div><span>Playoffs</span><strong>${f.playoffs}</strong></div><div><span>Finals</span><strong>${f.finals+f.titles}</strong></div><div><span>Best Season</span><strong>${f.bestSeason?`${f.bestSeason.wins}-${f.bestSeason.losses}`:'—'}</strong></div><div><span>High Week</span><strong>${high?high.points.toFixed(2):'—'}</strong></div><div><span>Top Rival</span><strong>${escapeHtml(rivalName)}</strong></div></div>${state.marketLoaded?rosterProfileHtml(ownerId):'<div class="inline-status"><span class="spinner"></span>Loading current roster values…</div>'}<div class="profile-split"><div><p class="eyebrow">SEASON LEDGER</p><div class="profile-season-list">${seasons.map(x=>`<div><span>${x.season}</span><strong>${x.wins}-${x.losses}</strong><small>${x.pf.toFixed(1)} PF</small><b>${x.champ?'🏆':x.runner?'🥈':''}</b></div>`).join('')}</div></div><div><p class="eyebrow">BIGGEST WEEKS</p><div class="rank-list">${games.slice(0,5).map((g,i)=>`<div class="rank-row"><span>${i+1}</span><div><strong>${g.points.toFixed(2)}</strong><small>${g.season} • Week ${g.week} • ${g.type}</small></div><b>🔥</b></div>`).join('')}</div></div></div>`;
}
async function enhanceFranchiseMarket(){await ensureMarketData();const selected=$('franchise-select').value;if(selected)renderFranchiseProfile(selected);}
function renderTrades(){
  const filter=$('trade-season').value||String(state.league?.season||''),txs=filter==='all'?[...state.tradesBySeason.values()].flat():state.tradesBySeason.get(String(filter))||[];
  const activity=new Map();let picks=0;txs.forEach(t=>{(t.roster_ids||[]).forEach(r=>{const n=rosterTradeIdentity(t.item,r);activity.set(n,(activity.get(n)||0)+1);});picks+=(t.draft_picks||[]).length;});const active=[...activity.entries()].sort((a,b)=>b[1]-a[1])[0],biggest=[...txs].sort((a,b)=>tradeAssetCount(b)-tradeAssetCount(a))[0],grades=filter==='all'?null:state.tradeGradesBySeason.get(String(filter));
  $('trade-count').textContent=txs.length;$('trade-most-active').textContent=active?.[0]||'—';$('trade-most-active-detail').textContent=active?`${active[1]} trades involved`:'—';$('trade-biggest').textContent=biggest?tradeAssetCount(biggest):'—';$('trade-picks').textContent=picks;if(grades)renderTradeAwards(txs,grades);else $('trade-awards').classList.add('hidden');
  $('trade-list').innerHTML=txs.length?txs.map(t=>{const ids=t.roster_ids||[],g=grades?.get(t.transaction_id),realized=tradeOutcomeSummary(t),date=t.created?new Date(Number(t.created)).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):`${t.season} W${t.leg||'?'}`;return `<article class="trade-card" id="trade-${escapeHtml(t.transaction_id)}"><div class="trade-card-head"><div><span>${escapeHtml(t.season)} • Week ${t.leg??'—'}</span><strong>${escapeHtml(date)}</strong></div><b>${tradeAssetCount(t)} assets</b></div><div class="trade-sides">${ids.map((rid,i)=>{const assets=tradeAssets(t,rid);return `<div class="trade-side"><h3>${escapeHtml(rosterTradeIdentity(t.item,rid))}</h3>${tradeGradeHtml(g,rid,realized)}<span class="received-label">RECEIVED</span>${assets.length?assets.map(a=>`<div class="asset ${a.type}"><span>${a.type.includes('pick')?'◇':a.type==='faab'?'$':'●'}</span><div><strong>${escapeHtml(a.label)}</strong><small>${escapeHtml(a.meta||'')}</small></div></div>`).join(''):'<div class="asset empty"><div><strong>No mapped incoming assets</strong><small>Sleeper transaction metadata may be incomplete.</small></div></div>'}${chainButtonHtml(t,rid,realized)}${(t.draft_picks||[]).some(p=>Number(p.owner_id)===Number(rid)&&resolvedPick(p))?`<button type="button" class="trace-button" data-trace-id="${escapeHtml(t.transaction_id)}" data-trace-roster="${rid}">Trace what it became →</button><div class="lineage-box hidden" id="trace-${escapeHtml(t.transaction_id)}-${rid}"></div>`:''}</div>${i<ids.length-1?'<div class="trade-arrow">⇄</div>':''}`;}).join('')}</div></article>`;}).join(''):`<article class="panel empty-cell">No completed trades found for ${escapeHtml(filter==='all'?'the loaded seasons':filter)}.</article>`;
  $('trades-loading').classList.add('hidden');$('trades-content').classList.remove('hidden');bindTraceButtons();bindChainButtons();bindTradeAwardJumps();
}
async function loadSelectedTradeSeason(){
  const selected=$('trade-season').value||String(state.league?.season||'');$('trades-loading').classList.remove('hidden');$('trades-content').classList.add('hidden');$('trades-loading').innerHTML='<span class="spinner"></span>Loading '+escapeHtml(selected==='all'?'all trade seasons':`${selected} trades`)+'…';
  if(selected==='all'){for(const season of state.history.map(item=>String(item.league.season)))await loadTradesForSeason(season);renderTrades();return;}
  const txs=await loadTradesForSeason(selected);renderTrades();$('trade-analytics-loading').classList.remove('hidden');await gradeTradesForSeason(selected,txs).catch(()=>null);$('trade-analytics-loading').classList.add('hidden');renderTrades();
  ensureRealizedArchive();
}
// Realized grading needs the weekly scoring archive. Load it in the background
// so market grades render first and the "since trade" column fills in after.
function ensureRealizedArchive(){
  if(state.matchupsLoaded)return;
  const node=$('trade-analytics-loading');
  if(node){node.innerHTML='<span class="spinner"></span>Loading scoring archive for realized-points grades…';node.classList.remove('hidden');}
  loadAllMatchups().then(()=>{if(node)node.classList.add('hidden');renderTrades();}).catch(()=>{if(node)node.classList.add('hidden');});
}
function tradeLabManagers(){return state.rosters.map(r=>{const u=state.users.find(x=>x.user_id===r.owner_id);return{ownerId:r.owner_id,rosterId:Number(r.roster_id),name:franchiseName(u,r)}}).filter(x=>x.ownerId);}
function renderAssetPicker(side,ownerId){const el=$(`trade-lab-${side}-assets`),selected=state.tradeLabSelections[side],assets=rosterAssets(ownerId);el.innerHTML=assets.map(a=>`<label class="trade-asset-option"><input type="checkbox" data-side="${side}" data-asset-id="${escapeHtml(a.id)}" ${selected.has(a.id)?'checked':''}><span><strong>${escapeHtml(a.label)}${ecrBadge(a.id)}</strong><small>${escapeHtml(a.meta)}</small></span><b>${state.marketLoaded?(a.value?Math.round(a.value).toLocaleString():'—'):'…'}</b></label>`).join('');el.querySelectorAll('input').forEach(inp=>inp.addEventListener('change',()=>{inp.checked?selected.add(inp.dataset.assetId):selected.delete(inp.dataset.assetId);renderTradeLabTotals();}));}
function selectedAssetTotal(side,ownerId){const selected=state.tradeLabSelections[side],map=new Map(rosterAssets(ownerId).map(a=>[a.id,a]));return[...selected].reduce((n,id)=>n+Number(map.get(id)?.value||0),0);}
function selectedAssets(side,ownerId){const selected=state.tradeLabSelections[side],map=new Map(rosterAssets(ownerId).map(a=>[a.id,a]));return[...selected].map(id=>map.get(id)).filter(Boolean);}
function assetPosition(a){return a?.type==='player'?(a.meta||'').split(' • ')[0]:null;}
function playerAssetPool(ownerId){
  const cached=memo.playerPool.get(ownerId);if(cached)return cached;
  const built=rosterAssets(ownerId).filter(a=>a.type==='player').map(a=>{const withPos={...a,pos:assetPosition(a)};return{...withPos,surplus:assetSurplus(withPos)};});
  memo.playerPool.set(ownerId,built);
  return built;
}
function postTradePlayerPool(ownerId,outSide,inSide,otherOwnerId){const outgoing=new Set(selectedAssets(outSide,ownerId).filter(a=>a.type==='player').map(a=>a.id));const incoming=selectedAssets(inSide,otherOwnerId).filter(a=>a.type==='player').map(a=>({...a,pos:assetPosition(a)}));return [...playerAssetPool(ownerId).filter(a=>!outgoing.has(a.id)),...incoming];}
/**
 * Every starting slot in roster order, including ones this app does not value
 * (K, DEF, IDP). Keeping them in the list matters because Sleeper's `starters`
 * array is positionally aligned with roster_positions: dropping unknown slots
 * would misalign flex detection in any league that starts a kicker.
 */
function startingSlotSpec(){
  const raw=state.league?.roster_positions||[];
  return raw.filter(x=>!['BN','IR','TAXI'].includes(x)).map(x=>{
    if(x==='SUPER_FLEX')return{raw:x,eligible:['QB','RB','WR','TE'],flex:true};
    if(x==='FLEX'||x==='WRRB_FLEX')return{raw:x,eligible:['RB','WR','TE'],flex:true};
    if(x==='REC_FLEX')return{raw:x,eligible:['WR','TE'],flex:true};
    if(['QB','RB','WR','TE'].includes(x))return{raw:x,eligible:[x],flex:false};
    return{raw:x,eligible:null,flex:false};
  });
}
function lineupSlots(){return startingSlotSpec().filter(s=>s.eligible).map(s=>s.eligible);}
/** Total roster spots, excluding taxi and IR which sit outside the active roster. */
function rosterLimit(){
  const raw=state.league?.roster_positions||[];
  const spots=raw.filter(x=>x!=='TAXI'&&x!=='IR').length;
  return spots||null;
}
/** How each flex slot is actually being filled across the league right now. */
function observedFlexUsage(){
  const spec=startingSlotSpec(),usage={};
  for(const roster of state.rosters||[]){
    const starters=roster.starters||[];
    spec.forEach((slot,i)=>{
      if(!slot.flex)return;
      const pid=starters[i];
      if(!pid||String(pid)==='0')return;
      const pos=playerInfo(pid).position;
      if(!pos||!slot.eligible.includes(pos))return;
      usage[pos]=(usage[pos]||0)+1;
    });
  }
  return usage;
}
/**
 * Replacement level per position, computed from this league's own rosters.
 * Recomputed whenever market data or rosters change, via the memo.
 */
function leagueReplacementLevels(){
  if(memo.replacement)return memo.replacement;
  const teams=(state.rosters||[]).length||1;
  const perTeam=starterSlotCounts(lineupSlots(),observedFlexUsage());
  const leagueWide=Object.fromEntries(Object.entries(perTeam).map(([pos,n])=>[pos,n*teams]));
  const pools={};
  for(const roster of state.rosters||[]){
    for(const id of roster.players||[]){
      const pos=playerInfo(id).position;
      if(!pos)continue;
      (pools[pos]||=[]).push(marketValueForPlayer(id));
    }
  }
  memo.replacement=replacementLevels(pools,leagueWide);
  return memo.replacement;
}
/**
 * Surplus over replacement for one asset. Picks are not discounted against a
 * replacement level: they occupy no lineup slot today, so there is nothing for
 * them to beat. That slightly favours the side receiving picks in surplus
 * terms, which is why surplus is shown next to market balance rather than
 * replacing it.
 */
function assetSurplus(asset){
  if(!asset)return 0;
  if(asset.type==='pick')return Number(asset.value||0);
  const pos=asset.pos||assetPosition(asset);
  return surplusValue(asset.value,leagueReplacementLevels()[pos]||0);
}
function bestLineupValue(pool){const available=pool.map(a=>({...a}));let total=0;const chosen=[];const slots=lineupSlots();const strict=slots.filter(s=>s.length===1),flex=slots.filter(s=>s.length>1);for(const slot of [...strict,...flex]){let best=-1;for(let i=0;i<available.length;i++){if(slot.includes(available[i].pos)&&(best<0||Number(available[i].value||0)>Number(available[best].value||0)))best=i;}if(best>=0){const [a]=available.splice(best,1);total+=Number(a.value||0);chosen.push(a);}}return{total,chosen};}
// Room strength is measured in surplus, not raw value. Summing raw value
// rewarded hoarding: six startable-but-replaceable RBs used to outrank an
// elite one. Below-replacement depth now contributes nothing.
function positionGroupValue(pool,pos){return pool.filter(a=>a.pos===pos).reduce((n,a)=>n+Number(a.surplus??assetSurplus(a)),0);}
function assetsSurplusTotal(assets){return (assets||[]).reduce((n,a)=>n+Number(a?.surplus??assetSurplus(a)),0);}

function contextForSide(ownerId,outSide,inSide,otherOwnerId){const before=playerAssetPool(ownerId),after=postTradePlayerPool(ownerId,outSide,inSide,otherOwnerId),beforeLine=bestLineupValue(before),afterLine=bestLineupValue(after);const roster=currentRosterForOwner(ownerId),beforePicks=currentDraftCapital(roster?.roster_id),outPicks=selectedAssets(outSide,ownerId).filter(a=>a.type==='pick'),inPicks=selectedAssets(inSide,otherOwnerId).filter(a=>a.type==='pick');const beforePickValue=beforePicks.reduce((n,p)=>n+Number(p.value||0),0),afterPickValue=beforePickValue-outPicks.reduce((n,p)=>n+Number(p.value||0),0)+inPicks.reduce((n,p)=>n+Number(p.value||0),0);const posChanges=['QB','RB','WR','TE'].map(pos=>{const beforeVal=positionGroupValue(before,pos),afterVal=positionGroupValue(after,pos);const leagueVals=state.rosters.map(r=>{const u=state.users.find(x=>x.user_id===r.owner_id);return positionGroupValue(playerAssetPool(u?.user_id),pos);});const otherIdx=state.rosters.findIndex(r=>r.owner_id===ownerId);const beforeRank=rankAmong(leagueVals,beforeVal);if(otherIdx>=0)leagueVals[otherIdx]=afterVal;const afterRank=rankAmong(leagueVals,afterVal);return{pos,beforeVal,afterVal,beforeRank,afterRank,delta:afterVal-beforeVal};}).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta));return{beforeLine:beforeLine.total,afterLine:afterLine.total,lineDelta:afterLine.total-beforeLine.total,beforePickValue,afterPickValue,pickDelta:afterPickValue-beforePickValue,beforePickCount:beforePicks.length,afterPickCount:beforePicks.length-outPicks.length+inPicks.length,posChanges};}
function fmtDelta(n){const x=Math.round(n);return `${x>0?'+':''}${x.toLocaleString()}`;}
function tradeContextRead(name,ctx,marketEdge){const strongest=ctx.posChanges.find(x=>x.afterRank!==x.beforeRank)||ctx.posChanges[0];const contender=ctx.lineDelta>500&&ctx.pickDelta<0?'Contender move':ctx.lineDelta< -500&&ctx.pickDelta>0?'Future-focused move':ctx.pickDelta>800&&Math.abs(ctx.lineDelta)<500?'Adds flexibility':ctx.lineDelta>500?'Improves the core':'Balanced roster move';const edgeText=Math.abs(marketEdge)<=5?'market is close to even':marketEdge>0?'market value favors this side':'this side gives a little more market value';const posText=strongest&&strongest.afterRank!==strongest.beforeRank?`${strongest.pos} room moves #${strongest.beforeRank} → #${strongest.afterRank}`:`${strongest?.pos||'roster'} depth is roughly unchanged`;return `<div class="context-team"><div><span>${escapeHtml(name)}</span><strong>${escapeHtml(contender)}</strong></div><p>${escapeHtml(edgeText)}; ${escapeHtml(posText)}.</p><div class="context-metrics"><div><small>Best lineup value</small><b>${fmtDelta(ctx.lineDelta)}</b></div><div><small>Draft capital</small><b>${fmtDelta(ctx.pickDelta)}</b></div><div><small>Future picks</small><b>${ctx.beforePickCount} → ${ctx.afterPickCount}</b></div></div></div>`;}
function renderTradeLabContext(a,b,av,bv){const el=$('trade-lab-context');if(!el)return;if(!state.tradeLabSelections.a.size&&!state.tradeLabSelections.b.size){el.innerHTML='<div class="context-empty">Build a deal to see lineup, positional depth, and draft-capital impact.</div>';return;}const aCtx=contextForSide(a,'a','b',b),bCtx=contextForSide(b,'b','a',a),avg=(av+bv)/2||1,aEdge=(bv-av)/avg*100,bEdge=-aEdge;const aName=$('trade-lab-a-name').textContent,bName=$('trade-lab-b-name').textContent;el.innerHTML=`<div class="context-head"><div><p class="eyebrow">LEAGUE CONTEXT</p><h3>What the deal changes</h3></div><small>Value-based lineup strength, not weekly projections.</small></div><div class="context-grid">${tradeContextRead(aName,aCtx,aEdge)}${tradeContextRead(bName,bCtx,bEdge)}</div>`;}
/**
 * Surplus-based read of a proposed deal for one side, including the cost of the
 * players a lopsided-count trade would force off the roster.
 */
function dealSurplusForSide(ownerId,outSide,inSide,otherOwnerId){
  const outgoing=selectedAssets(outSide,ownerId);
  const incoming=selectedAssets(inSide,otherOwnerId);
  const gained=assetsSurplusTotal(incoming)-assetsSurplusTotal(outgoing);
  const pool=postTradePlayerPool(ownerId,outSide,inSide,otherOwnerId);
  const crunch=rosterCrunchCost(pool,rosterLimit());
  return{gained,crunch,net:gained-crunch.cost,incoming,outgoing};
}
function dealDialsHtml(a,b,av,bv){
  const aSide=dealSurplusForSide(a,'a','b',b),bSide=dealSurplusForSide(b,'b','a',a);
  const aCtx=contextForSide(a,'a','b',b),bCtx=contextForSide(b,'b','a',a);
  const aName=$('trade-lab-a-name').textContent,bName=$('trade-lab-b-name').textContent;
  const marketEdge=edgePct(bv,av);
  const surplusEdge=edgePct(Math.max(aSide.net,0)+1,Math.max(bSide.net,0)+1);
  const dial=(label,left,right,note)=>`<div class="deal-dial"><small>${escapeHtml(label)}</small><div class="deal-dial-sides"><b>${left}</b><span>vs</span><b>${right}</b></div><em>${escapeHtml(note)}</em></div>`;
  const crunchNote=(side,name)=>side.crunch.overBy
    ?`${name} drops ${side.crunch.overBy} (−${Math.round(side.crunch.cost).toLocaleString()})`
    :'';
  const crunchNotes=[crunchNote(aSide,aName),crunchNote(bSide,bName)].filter(Boolean).join(' • ');
  return `<div class="deal-dials">
    ${dial('Market balance',fmtDelta(marketEdge==null?0:-marketEdge),fmtDelta(marketEdge==null?0:marketEdge),marketEdge==null?'nothing selected':`% of average deal value, ${Math.abs(marketEdge)<=5?'near even':'lopsided'}`)}
    ${dial('Surplus over replacement',fmtDelta(aSide.net),fmtDelta(bSide.net),'depth below replacement counts for nothing')}
    ${dial('Best lineup value',fmtDelta(aCtx.lineDelta),fmtDelta(bCtx.lineDelta),'market value of the optimal starting eleven')}
    ${dial('Roster crunch',aSide.crunch.overBy?`−${Math.round(aSide.crunch.cost).toLocaleString()}`:'0',bSide.crunch.overBy?`−${Math.round(bSide.crunch.cost).toLocaleString()}`:'0',crunchNotes||'both rosters stay within the limit')}
  </div><div class="deal-dial-legend"><span>${escapeHtml(aName)}</span><span>${escapeHtml(bName)}</span></div>`;
}
function renderTradeLabTotals(){const a=$('trade-lab-a').value,b=$('trade-lab-b').value,av=selectedAssetTotal('a',a),bv=selectedAssetTotal('b',b);$('trade-lab-a-total').textContent=Math.round(av).toLocaleString();$('trade-lab-b-total').textContent=Math.round(bv).toLocaleString();if(!av&&!bv){$('trade-lab-verdict').innerHTML='<strong>Build a deal</strong><small>Tap assets from both rosters.</small>';renderTradeLabContext(a,b,av,bv);return;}
  // av is what A sends, bv is what A receives, so A's edge is (bv - av). The
  // headline previously credited the side giving up more value.
  const avg=(av+bv)/2||1,edge=(bv-av)/avg*100;
  const fav=edge>0?$('trade-lab-a-name').textContent:$('trade-lab-b-name').textContent;
  $('trade-lab-verdict').innerHTML=`<strong>${Math.abs(edge)<=5?'Near-even market':`${escapeHtml(fav)} +${Math.abs(edge).toFixed(1)}%`}</strong><div class="value-bar"><i style="width:${Math.max(5,Math.min(95,50+edge/2))}%"></i></div><small>${Math.round(av).toLocaleString()} ⇄ ${Math.round(bv).toLocaleString()} • ${gradeLetter(-Math.abs(edge))} balance</small>${dealDialsHtml(a,b,av,bv)}`;
  renderTradeLabContext(a,b,av,bv);}
function renderTradeLab(){
  const managers=tradeLabManagers(),opts=managers.map(x=>`<option value="${escapeHtml(x.ownerId)}">${escapeHtml(x.name)}</option>`).join('');
  const aSel=$('trade-lab-a'),bSel=$('trade-lab-b');
  const oldA=aSel.value,oldB=bSel.value;
  aSel.innerHTML=opts;bSel.innerHTML=opts;
  if(oldA&&managers.some(x=>x.ownerId===oldA))aSel.value=oldA;
  if(oldB&&managers.some(x=>x.ownerId===oldB))bSel.value=oldB;else if(managers[1])bSel.value=managers[1].ownerId;
  if(!state.tradeLabRendered){state.tradeLabSelections.a.clear();state.tradeLabSelections.b.clear();state.tradeLabRendered=true;}
  refreshTradeLabSides();
  $('tradelab-loading').classList.add('hidden');$('tradelab-content').classList.remove('hidden');
}
function refreshTradeLabSides(){const aSel=$('trade-lab-a'),bSel=$('trade-lab-b');let a=aSel.value,b=bSel.value;const managers=tradeLabManagers();if(a&&b&&a===b){const alt=managers.find(x=>x.ownerId!==a);if(alt){b=alt.ownerId;bSel.value=b;state.tradeLabSelections.b.clear();}}const ma=managers.find(x=>x.ownerId===a),mb=managers.find(x=>x.ownerId===b);$('trade-lab-a-name').textContent=ma?.name||'Franchise A';$('trade-lab-b-name').textContent=mb?.name||'Franchise B';renderAssetPicker('a',a);renderAssetPicker('b',b);renderTradeLabTotals();}
function setTradeLabMarketStatus(text){const node=$('tradelab-loading');if(!node)return;node.innerHTML=text;node.classList.remove('hidden');}
async function loadTradeLab(){
  // Render immediately from Sleeper roster IDs; hydrate names, picks and values independently.
  renderTradeLab();
  setTradeLabMarketStatus('<span class="spinner"></span>Loading player names and draft capital…');
  await Promise.all([
    loadPlayerMap(),
    api(`/league/${CONFIG.primaryLeagueId}/traded_picks`).then(x=>{state.currentTradedPicks=Array.isArray(x)?x:[];clearRosterMemo();}).catch(()=>{state.currentTradedPicks=[];clearRosterMemo();})
  ]);
  refreshTradeLabSides();
  setTradeLabMarketStatus('<span class="spinner"></span>Adding dynasty market values…');
  const ok=await ensureMarketData();
  refreshTradeLabSides();
  if(ok){$('tradelab-loading').classList.add('hidden');}
  else{setTradeLabMarketStatus(`<span>⚠</span>${escapeHtml(state.marketError||'Market values unavailable. Trade Lab still works with roster context.')}`);}
}

async function traceTradeLineage(transactionId,rosterId){
  const t=[...state.tradesBySeason.values()].flat().find(x=>x.transaction_id===transactionId);if(!t)return;
  const box=$(`trace-${transactionId}-${rosterId}`);if(!box)return;box.classList.remove('hidden');box.innerHTML='<span class="spinner"></span> Tracing later transactions…';
  const resolved=(t.draft_picks||[]).filter(p=>Number(p.owner_id)===Number(rosterId)).map(p=>({pick:p,res:resolvedPick(p)})).filter(x=>x.res?.playerId);
  if(!resolved.length){box.textContent='No resolved draft-pick lineage on this side.';return;}
  const startSeason=Math.min(...resolved.map(x=>Number(x.pick.season))),seasons=state.history.map(x=>String(x.league.season)).filter(s=>Number(s)>=startSeason).sort((a,b)=>Number(a)-Number(b));
  for(const season of seasons)await loadTradesForSeason(season);
  const later=[...state.tradesBySeason.values()].flat().filter(x=>Number(x.created||0)>Number(t.created||0));
  const rows=[];
  resolved.forEach(({pick,res})=>{
    rows.push(`<div class="lineage-step"><b>${escapeHtml(`${pick.season} ${pickSlotLabel(pick.round,res.slot)}`)}</b><span>→</span><div><strong>${escapeHtml(res.playerName)}</strong><small>drafted from acquired pick</small></div></div>`);
    const moves=later.filter(x=>Object.prototype.hasOwnProperty.call(x.adds||{},String(res.playerId))).sort((a,b)=>Number(a.created||0)-Number(b.created||0));
    moves.forEach(x=>{const receiver=Number(x.adds[String(res.playerId)]),name=rosterTradeIdentity(x.item,receiver),date=x.created?new Date(Number(x.created)).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):x.season;rows.push(`<div class="lineage-step"><b>${escapeHtml(date)}</b><span>→</span><div><strong>Traded to ${escapeHtml(name)}</strong><small>${escapeHtml(x.season)} • Week ${x.leg||'?'}</small></div></div>`);});
    if(!moves.length)rows.push('<div class="lineage-step"><b>Now</b><span>→</span><div><strong>No later trade found</strong><small>player remained untraded in the loaded Sleeper archive</small></div></div>');
  });
  box.innerHTML=rows.join('');
}
function bindTraceButtons(){document.querySelectorAll('.trace-button').forEach(btn=>btn.addEventListener('click',()=>traceTradeLineage(btn.dataset.traceId,Number(btn.dataset.traceRoster))));}


function stampLiveUpdate(){
  state.lastLiveUpdate=new Date();
  const el=$('live-updated');if(!el)return;
  el.textContent=`Matchups updated ${state.lastLiveUpdate.toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'})} • auto-refresh 60s`;
  el.classList.add('is-live');
}
async function refreshLiveMatchups(){
  if(document.hidden||!state.league)return;
  try{
    state.nflState=await api('/state/nfl').catch(()=>state.nflState);
    await renderCurrentWeek();
    stampLiveUpdate();
  }catch(e){const el=$('live-updated');if(el){el.textContent='Live refresh paused — use Refresh if needed';el.classList.remove('is-live');}}
}
function startLiveRefresh(){
  if(state.liveRefreshTimer)clearInterval(state.liveRefreshTimer);
  state.liveRefreshTimer=setInterval(refreshLiveMatchups,60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshLiveMatchups();},{passive:true});
}
function tradeOwnerId(item,rosterId){return item?.rosters?.find(r=>Number(r.roster_id)===Number(rosterId))?.owner_id||null;}
function tradeManagerOptions(){
  const map=new Map();
  state.history.forEach(item=>item.rosters.forEach(r=>{if(!r.owner_id)return;const u=item.users.find(x=>x.user_id===r.owner_id);if(!map.has(r.owner_id))map.set(r.owner_id,{id:r.owner_id,name:managerName(u)});}));
  return [...map.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
async function ensureTradeRelationships(){
  if(state.tradeRelationshipsLoaded)return;
  if(state.tradeRelationshipsPromise)return state.tradeRelationshipsPromise;
  state.tradeRelationshipsPromise=(async()=>{
    const loading=$('trade-partners-loading');loading.classList.remove('hidden');
    const seasons=state.history.map(item=>String(item.league.season)).sort((a,b)=>Number(b)-Number(a));
    populateTradePartnerManagers();renderTradeRelationships();
    for(let i=0;i<seasons.length;i++){
      loading.innerHTML=`<span class="spinner"></span>Loading trade history ${i+1}/${seasons.length} seasons…`;
      await loadTradeIndexForSeason(seasons[i]);
      renderTradeRelationships();
    }
    state.tradeRelationshipsLoaded=true;loading.classList.add('hidden');
  })().catch(e=>{const loading=$('trade-partners-loading');loading.classList.remove('hidden');loading.textContent=`Trade relationship history could not finish: ${e.message}`;throw e;}).finally(()=>state.tradeRelationshipsPromise=null);
  return state.tradeRelationshipsPromise;
}

function allHistoricalTrades(){return [...state.tradesBySeason.values()].flat().sort((a,b)=>Number(b.created||0)-Number(a.created||0));}
function partnerStatsFor(ownerId){
  const partners=new Map();
  for(const t of allHistoricalTrades()){
    const owners=[...new Set((t.roster_ids||[]).map(r=>tradeOwnerId(t.item,r)).filter(Boolean))];
    if(!owners.includes(ownerId))continue;
    for(const other of owners.filter(x=>x!==ownerId)){
      if(!partners.has(other))partners.set(other,{ownerId:other,trades:0,assets:0,seasons:new Set(),last:0});
      const row=partners.get(other);row.trades++;row.assets+=tradeAssetCount(t);row.seasons.add(String(t.season));row.last=Math.max(row.last,Number(t.created||0));
    }
  }
  const names=Object.fromEntries(tradeManagerOptions().map(x=>[x.id,x.name]));
  return [...partners.values()].map(x=>({...x,name:names[x.ownerId]||'Former manager',seasonCount:x.seasons.size})).sort((a,b)=>b.trades-a.trades||b.assets-a.assets||a.name.localeCompare(b.name));
}
function bilateralTrades(a,b){
  return allHistoricalTrades().filter(t=>{const owners=[...new Set((t.roster_ids||[]).map(r=>tradeOwnerId(t.item,r)).filter(Boolean))];return owners.includes(a)&&owners.includes(b);});
}
function rosterIdForOwnerInTrade(t,ownerId){return (t.roster_ids||[]).find(r=>tradeOwnerId(t.item,r)===ownerId);}
function compactTradeHtml(t,a,b){
  const ar=rosterIdForOwnerInTrade(t,a),br=rosterIdForOwnerInTrade(t,b);if(ar==null||br==null)return'';
  const date=t.created?new Date(Number(t.created)).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):`${t.season} W${t.leg||'?'}`;
  const side=(rid)=>{const assets=tradeAssets(t,rid);return `<div class="trade-side"><h3>${escapeHtml(rosterTradeIdentity(t.item,rid))}</h3><span class="received-label">RECEIVED</span>${assets.length?assets.map(x=>`<div class="asset ${x.type}"><span>${x.type.includes('pick')?'◇':x.type==='faab'?'$':'●'}</span><div><strong>${escapeHtml(x.label)}</strong><small>${escapeHtml(x.meta||'')}</small></div></div>`).join(''):'<div class="asset empty"><div><strong>No mapped incoming assets</strong></div></div>'}</div>`;};
  return `<article class="trade-card"><div class="trade-card-head"><div><span>${escapeHtml(t.season)} • Week ${t.leg??'—'}</span><strong>${escapeHtml(date)}</strong></div><b>${tradeAssetCount(t)} assets</b></div><div class="trade-sides">${side(ar)}<div class="trade-arrow">⇄</div>${side(br)}</div></article>`;
}
function populateTradePartnerManagers(){
  const managers=tradeManagerOptions(),sel=$('trade-partner-manager');if(!sel)return;
  const existing=sel.value;sel.innerHTML=managers.map(x=>`<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');if(existing&&managers.some(x=>x.id===existing))sel.value=existing;
}
function renderTradeRelationships(){
  populateTradePartnerManagers();const owner=$('trade-partner-manager').value;if(!owner)return;
  const stats=partnerStatsFor(owner),opp=$('trade-partner-opponent'),old=opp.value;opp.innerHTML='<option value="">Most frequent partner</option>'+stats.map(x=>`<option value="${escapeHtml(x.ownerId)}">${escapeHtml(x.name)} — ${x.trades} trades</option>`).join('');if(old&&stats.some(x=>x.ownerId===old))opp.value=old;
  const chosen=opp.value||stats[0]?.ownerId||'',chosenRow=stats.find(x=>x.ownerId===chosen),trades=chosen?bilateralTrades(owner,chosen):[];
  const total=stats.reduce((n,x)=>n+x.trades,0),assets=stats.reduce((n,x)=>n+x.assets,0),top=stats[0];
  $('trade-partner-summary').innerHTML=`<article class="stat-card"><span>Total Partner Trades</span><strong>${total}</strong><small>counterparty relationships</small></article><article class="stat-card"><span>Top Partner</span><strong>${escapeHtml(top?.name||'—')}</strong><small>${top?`${top.trades} trades`:'—'}</small></article><article class="stat-card"><span>Assets in Deals</span><strong>${assets}</strong><small>across partner transactions</small></article><article class="stat-card"><span>Seasons Trading</span><strong>${top?.seasonCount||0}</strong><small>with top partner</small></article>`;
  $('trade-partner-ranking').innerHTML=stats.length?stats.map((x,i)=>`<button type="button" class="rank-row trade-partner-row" data-partner-id="${escapeHtml(x.ownerId)}"><span>${i+1}</span><div><strong>${escapeHtml(x.name)}</strong><small>${x.seasonCount} seasons • ${x.assets} assets moved</small></div><b>${x.trades}</b></button>`).join(''):'<div class="empty-cell">No historical trades found for this manager.</div>';
  $('trade-partner-history-title').textContent=chosenRow?`${managerName(ownerUser(owner))} ↔ ${chosenRow.name}`:'Trade History';
  $('trade-partner-history').innerHTML=trades.length?trades.map(t=>compactTradeHtml(t,owner,chosen)).join(''):'<article class="panel empty-cell">No bilateral trades found.</article>';
  $$('.trade-partner-row').forEach(btn=>btn.addEventListener('click',()=>{opp.value=btn.dataset.partnerId;renderTradeRelationships();hydrateSelectedTradeRelationship();}));
}
async function hydrateSelectedTradeRelationship(){
  const owner=$('trade-partner-manager')?.value,opp=$('trade-partner-opponent')?.value;if(!owner)return;
  const stats=partnerStatsFor(owner),chosen=opp||stats[0]?.ownerId;if(!chosen)return;
  const trades=bilateralTrades(owner,chosen);
  const seasons=[...new Set(trades.map(t=>String(t.season)))];
  if(!seasons.length)return;
  $('trade-partners-loading').innerHTML='<span class="spinner"></span>Resolving names and picks for this trade history…';$('trade-partners-loading').classList.remove('hidden');
  await Promise.all([loadPlayerMap(),...seasons.map(loadTradesForSeason)]).catch(()=>{});
  $('trade-partners-loading').classList.add('hidden');renderTradeRelationships();
}
async function setH2HMode(mode){
  state.h2hMode=mode;$$('.h2h-mode-tab').forEach(b=>b.classList.toggle('active',b.dataset.h2hMode===mode));$('h2h-matchups-mode').classList.toggle('hidden',mode!=='matchups');$('h2h-trades-mode').classList.toggle('hidden',mode!=='trades');$('h2h-mode-status').textContent=mode==='matchups'?'Matchup archive':'Trade relationship archive';
  if(mode==='trades'){populateTradePartnerManagers();renderTradeRelationships();ensureTradeRelationships().then(()=>hydrateSelectedTradeRelationship()).catch(()=>{});}
}


// ---------------------------------------------------------------------------
// Competitive window
//
// The Assistant used to match franchises purely on positional shape, which
// would cheerfully tell a 2-7 team with the league's oldest roster to trade
// picks for an aging WR because the shapes complemented. Every suggestion now
// runs through a two-axis read of where each franchise actually stands:
// strength (can you win now) and timeline (are your assets appreciating).
// ---------------------------------------------------------------------------
function leagueWindows(){
  if(memo.windows)return memo.windows;
  const managers=assistantManagers();
  const rows=managers.map(m=>{
    const pool=playerAssetPool(m.ownerId);
    const roster=currentRosterForOwner(m.ownerId);
    const settings=roster?.settings||{};
    const wins=Number(settings.wins||0),losses=Number(settings.losses||0);
    return{
      ownerId:m.ownerId,
      name:m.name,
      lineupValue:bestLineupValue(pool).total,
      pickValue:pickAssetPool(m.ownerId).reduce((n,p)=>n+Number(p.value||0),0),
      age:valueWeightedAge(pool,LEAGUE_FALLBACK_AGE),
      winPct:(wins+losses)?wins/(wins+losses):0,
      pf:scoreSettings(settings,'fpts'),
      gamesPlayed:wins+losses
    };
  });
  const lineupValues=rows.map(r=>r.lineupValue),pickValues=rows.map(r=>r.pickValue);
  const winPcts=rows.map(r=>r.winPct),pfs=rows.map(r=>r.pf),ages=rows.map(r=>r.age);
  const windows=new Map();
  for(const row of rows){
    const lineupPct=percentileRank(lineupValues,row.lineupValue);
    const recordPct=percentileRank(winPcts,row.winPct);
    const pfPct=percentileRank(pfs,row.pf);
    // Younger is more future-leaning, so the age percentile is inverted.
    const youthPct=100-percentileRank(ages,row.age);
    const pickPct=percentileRank(pickValues,row.pickValue);
    const strength=strengthScore({lineupPct,recordPct,pfPct,gamesPlayed:row.gamesPlayed});
    const timeline=timelineScore({youthPct,pickPct});
    const quadrant=classifyWindow(strength,timeline);
    windows.set(row.ownerId,{
      ...row,strength,timeline,lineupPct,recordPct,pfPct,youthPct,pickPct,
      ...quadrant,
      directive:windowDirective(quadrant.key)
    });
  }
  memo.windows=windows;return windows;
}
const LEAGUE_FALLBACK_AGE=26;
function franchiseWindow(ownerId){return leagueWindows().get(ownerId)||null;}

/**
 * Score an asset against what a franchise in this window actually wants.
 * Positive means "this fits what you should be acquiring".
 */
function assetWindowFit(asset,directive){
  if(!directive)return 0;
  if(asset?.type==='pick')return directive.preferPicks?1:-0.6;
  const age=Number(asset?.age);
  if(!Number.isFinite(age))return 0;
  if(directive.preferYouth)return age<=directive.buyAgeCeiling?1:-(age-directive.buyAgeCeiling)/6;
  return age<=directive.buyAgeCeiling?0.6:-0.5;
}
/** Score an asset a franchise would be sending away. Positive means "good to move on from". */
function assetSellFit(asset,directive){
  if(!directive)return 0;
  if(asset?.type==='pick')return directive.preferPicks?-1:0.8;
  const age=Number(asset?.age);
  if(!Number.isFinite(age))return 0;
  if(directive.sellAgeFloor!=null)return age>=directive.sellAgeFloor?1:-0.7;
  return age<=23?0.5:-0.2;
}

function windowCardHtml(ownerId){
  const w=franchiseWindow(ownerId);
  if(!w)return '';
  const bar=(label,value,left,right)=>`<div class="window-axis"><div class="window-axis-head"><small>${label}</small><b>${Math.round(value)}</b></div><div class="window-bar"><i style="width:${Math.max(2,Math.min(100,value))}%"></i></div><div class="window-axis-ends"><span>${left}</span><span>${right}</span></div></div>`;
  const d=w.directive;
  const moves=[
    d.preferPicks?'Buy future picks':'Spend future picks',
    d.preferYouth?`Target players ${d.buyAgeCeiling} and under`:`Target proven production up to ${d.buyAgeCeiling}`,
    d.sellAgeFloor!=null?`Sell producers ${d.sellAgeFloor}+`:'Hold your producers'
  ];
  return `<article class="window-card window-${w.key}">
    <div class="window-verdict"><span class="window-kicker">COMPETITIVE WINDOW</span><h3>${escapeHtml(w.label)}</h3><p>${escapeHtml(w.blurb)}</p><div class="window-moves">${moves.map(m=>`<span>${escapeHtml(m)}</span>`).join('')}</div></div>
    <div class="window-axes">
      ${bar('Win-now strength',w.strength,'Rebuilding','Contending')}
      ${bar('Asset timeline',w.timeline,'Aging','Appreciating')}
      <div class="window-facts"><div><small>Lineup value</small><b>${Math.round(w.lineupValue).toLocaleString()}</b></div><div><small>Value-weighted age</small><b>${w.age.toFixed(1)}</b></div><div><small>Future pick value</small><b>${Math.round(w.pickValue).toLocaleString()}</b></div><div><small>Record</small><b>${w.gamesPlayed?`${Math.round(w.winPct*100)}%`:'—'}</b></div></div>
    </div>
  </article>`;
}

// ---------------------------------------------------------------------------
// Manager Lab: lineup efficiency, all-play, luck, coaching record, schedule swap
//
// All of this runs on the matchup archive that was already being downloaded and
// only half used. `starters` and `players_points` together say not just what a
// team scored but what it could have scored, which is the difference between a
// scoreboard and an argument.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// League Pulse: power rankings and manager engagement
// ---------------------------------------------------------------------------
function pulseSeasonKey(){return state.pulseSeason||String(state.league?.season||'');}
function pulseWeekScores(){
  const season=pulseSeasonKey();
  const weeks=(state.efficiency?.weeks||[]).filter(w=>w.season===season).sort((a,b)=>a.week-b.week);
  return weeks.map(w=>[...w.scores.entries()].map(([ownerId,points])=>({ownerId,points})));
}
function lastTransactionWeeks(){
  const season=pulseSeasonKey();
  const last=new Map();
  const note=(ownerId,week)=>{
    if(!ownerId||week==null)return;
    const current=last.get(ownerId);
    if(current==null||week>current)last.set(ownerId,week);
  };
  for(const claim of state.waiversBySeason.get(season)||[]){
    note(tradeOwnerId(claim.item,claim.rosterId),claim.leg);
  }
  for(const trade of state.tradesBySeason.get(season)||[]){
    for(const rid of trade.roster_ids||[])note(tradeOwnerId(trade.item,rid),Number(trade.leg)||null);
  }
  return last;
}
function renderPulse(){
  const season=pulseSeasonKey();
  const weekScores=pulseWeekScores();
  if(!weekScores.length){
    $('pulse-rankings').innerHTML='<tr><td colspan="7" class="empty-cell">No scored weeks in this season yet.</td></tr>';
    $('pulse-activity').innerHTML='<div class="empty-cell">Nothing to report until games are played.</div>';
    return;
  }
  const names=ownerNameMap();
  const rosterStrength=new Map(),efficiencyMap=new Map();
  for(const roster of state.rosters||[]){
    if(!roster.owner_id)continue;
    rosterStrength.set(roster.owner_id,bestLineupValue(playerAssetPool(roster.owner_id)).total);
  }
  const seasonWeeks=(state.efficiency?.teamWeeks||[]).filter(r=>r.season===season);
  const effTotals=new Map();
  for(const row of seasonWeeks){
    if(row.efficiency==null)continue;
    const acc=effTotals.get(row.ownerId)||{sum:0,n:0};
    acc.sum+=row.efficiency;acc.n+=1;effTotals.set(row.ownerId,acc);
  }
  for(const [ownerId,acc] of effTotals)efficiencyMap.set(ownerId,acc.sum/acc.n);

  const rows=powerRankings(weekScores,{rosterStrength,efficiency:efficiencyMap,recentWindow:3});
  const move=m=>m==null?'<span class="move-new">NEW</span>'
    :m===0?'<span class="move-flat">—</span>'
    :`<span class="${m>0?'move-up':'move-down'}">${m>0?'▲':'▼'}${Math.abs(m)}</span>`;
  const comp=v=>v==null?'—':Math.round(v);
  $('pulse-rankings').innerHTML=rows.map(row=>`<tr><td class="rank big-rank">${row.rank}</td><td>${move(row.movement)}</td><td><strong>${escapeHtml(names[row.ownerId]||row.ownerId)}</strong><span class="tap-hint">all-play ${row.allPlay.wins}-${row.allPlay.losses}</span></td><td class="gold-score">${comp(row.score)}</td><td>${comp(row.components.allPlay)}</td><td>${comp(row.components.recent)}</td><td>${comp(row.components.roster)}</td></tr>`).join('');

  const currentWeek=Math.max(...seasonWeeks.map(r=>Number(r.week)||0),0);
  const activity=managerActivity(seasonWeeks,{currentWeek,lastTransactionWeek:lastTransactionWeeks()});
  const concerns=activity.filter(a=>a.concern);
  const quiet=activity.filter(a=>!a.concern&&a.signals.length);
  const engaged=activity.filter(a=>!a.signals.length);

  const card=(row,tone)=>`<div class="pulse-manager pulse-${tone}"><div class="pulse-manager-head"><strong>${escapeHtml(row.manager)}</strong><b>${row.recentEfficiency!=null?`${(row.recentEfficiency*100).toFixed(0)}%`:'—'}</b></div>${row.signals.length?`<ul class="pulse-signals">${row.signals.map(s=>`<li>${escapeHtml(s.text)}</li>`).join('')}</ul>`:'<p class="pulse-clear">Lineups set, no signals.</p>'}</div>`;

  $('pulse-activity').innerHTML=`
    ${concerns.length?`<p class="eyebrow">WORTH A NUDGE</p><div class="pulse-grid">${concerns.map(r=>card(r,'concern')).join('')}</div>`:'<div class="empty-cell">No lineup neglect detected. Everyone is still playing.</div>'}
    ${quiet.length?`<p class="eyebrow roster-pick-head">QUIET, BUT FINE</p><div class="pulse-grid">${quiet.map(r=>card(r,'quiet')).join('')}</div>`:''}
    ${engaged.length?`<p class="eyebrow roster-pick-head">FULLY ENGAGED</p><div class="pulse-grid">${engaged.map(r=>card(r,'good')).join('')}</div>`:''}`;

  $('pulse-note').textContent=`Ranked on all-play record (40%), recent three-week form (25%), roster market value (25%) and lineup efficiency (10%). Movement compares against the same ranking computed one week earlier.`;
}
async function loadPulse(){
  $('pulse-loading').classList.remove('hidden');$('pulse-content').classList.add('hidden');
  $('pulse-loading').innerHTML='<span class="spinner"></span>Reading the league pulse…';
  try{
    await ensureEfficiency();
    await ensureMarketData().catch(()=>false);
    await ensureWaivers().catch(()=>{});
    const seasons=labSeasons();
    const sel=$('pulse-season');
    sel.innerHTML=seasons.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    if(!state.pulseSeason||!seasons.includes(state.pulseSeason))state.pulseSeason=seasons[0]||String(state.league?.season||'');
    sel.value=state.pulseSeason;
    renderPulse();
    $('pulse-loading').classList.add('hidden');$('pulse-content').classList.remove('hidden');
  }catch(e){
    $('pulse-loading').innerHTML=`League Pulse could not load: ${escapeHtml(e.message)}`;
  }
}

// ---------------------------------------------------------------------------
// Opportunity data: nflverse usage and Sleeper's trending feed
//
// Market value says what a player is worth. Usage says why it is moving, and
// usually says it first: snap share and target share lead production rather
// than following it.
// ---------------------------------------------------------------------------
async function ensureUsage(){
  if(state.usage)return state.usage;
  if(!CONFIG.proxyBase){state.usageError='No proxy configured, so usage data is unavailable.';return null;}
  if(state.usagePromise)return state.usagePromise;
  state.usagePromise=(async()=>{
    await loadPlayerMap();
    const base=CONFIG.proxyBase.replace(/\/$/,'');
    const season=String(state.league?.season||new Date().getFullYear());
    const fetchSet=async dataset=>{
      const response=await fetch(`${base}?endpoint=nflverse&dataset=${dataset}&season=${season}`,{headers:{Accept:'application/json'}});
      if(!response.ok)throw new Error(`${dataset} returned HTTP ${response.status}`);
      const payload=await response.json();
      return Array.isArray(payload.rows)?payload.rows:[];
    };
    const stats=await fetchSet('player_stats');
    if(!stats.length)throw new Error('no weekly stats published for this season yet');
    const usage=aggregateUsage(stats);
    // Snaps are a separate nflverse dataset and are optional: if the release is
    // not up yet, target share alone is still useful.
    try{ mergeSnapCounts(usage,await fetchSet('snap_counts')); }catch{}
    const byGsis=new Map();
    for(const entry of usage.values())if(entry.gsisId)byGsis.set(String(entry.gsisId),entry);
    state.usage=usage;state.usageByGsis=byGsis;state.usageError=null;
    return usage;
  })().catch(e=>{state.usageError=`Usage data unavailable: ${e.message}`;return null;})
    .finally(()=>state.usagePromise=null);
  return state.usagePromise;
}
/** Look up a Sleeper player in the nflverse set, by id first and name second. */
function usageForPlayer(playerId){
  if(!state.usage)return null;
  const info=playerInfo(playerId);
  if(info.gsisId){
    const hit=state.usageByGsis?.get(String(info.gsisId));
    if(hit)return hit;
  }
  const key=`name:${info.name.toLowerCase()}|${info.position}`;
  return state.usage.get(key)||null;
}
function usageOwnerMap(){
  const owner=new Map();
  for(const roster of state.rosters||[])for(const id of roster.players||[])owner.set(String(id),roster.owner_id);
  return owner;
}
async function ensureTrending(){
  if(state.trending)return state.trending;
  if(state.trendingPromise)return state.trendingPromise;
  state.trendingPromise=(async()=>{
    const [adds,drops]=await Promise.all([
      api('/players/nfl/trending/add?lookback_hours=24&limit=40').catch(()=>[]),
      api('/players/nfl/trending/drop?lookback_hours=24&limit=40').catch(()=>[])
    ]);
    state.trending={adds:Array.isArray(adds)?adds:[],drops:Array.isArray(drops)?drops:[]};
    return state.trending;
  })().finally(()=>state.trendingPromise=null);
  return state.trendingPromise;
}
function pctText(value){return value==null?'—':`${(value*100).toFixed(0)}%`;}
function deltaText(value){
  if(value==null)return '';
  const pts=value*100;
  return `<em class="${pts>=0?'luck-good':'luck-bad'}">${pts>0?'+':''}${pts.toFixed(0)} pts</em>`;
}
function usageCardHtml(playerId){
  const entry=usageForPlayer(playerId);
  if(!entry)return '';
  const trend=usageTrend(entry.weeks);
  if(!trend)return '';
  const line=(label,metric)=>`<div class="usage-line"><small>${escapeHtml(label)}</small><b>${pctText(metric.recent)}</b><span>was ${pctText(metric.prior)}</span>${deltaText(metric.delta)}</div>`;
  return `<p class="eyebrow roster-pick-head">OPPORTUNITY · LAST ${trend.recentGames} GAMES VS EARLIER</p>
    <div class="usage-grid">
      ${line('Snap share',trend.snapPct)}
      ${line('Target share',trend.targetShare)}
      ${line('Air yards share',trend.airYardsShare)}
    </div>
    <div class="market-credit">Usage data from <a href="https://github.com/nflverse/nflverse-data" target="_blank" rel="noopener">nflverse</a>, free and open</div>`;
}
function renderTrendingPanel(){
  const wrap=$('assistant-trending');
  if(!wrap)return;
  if(!state.trending){wrap.innerHTML='';return;}
  const rosteredIds=rosteredPlayerIds();
  const ownerByPlayer=usageOwnerMap();
  const names=ownerNameMap();
  const describe=id=>{
    const info=playerInfo(id);
    const entry=usageForPlayer(id);
    const trend=entry?usageTrend(entry.weeks):null;
    return{name:info.name,meta:info.meta,trend};
  };
  const adds=crossReferenceTrending(state.trending.adds,{rosteredIds,ownerByPlayer,describe});
  const rising=state.usage?risingUsage(state.usage).slice(0,6):[];
  const fading=state.usage?fadingUsage(state.usage).slice(0,6):[];

  const trendBadge=trend=>{
    const delta=trend?.snapPct?.delta;
    if(delta==null)return '';
    return `<span class="usage-badge ${delta>=0?'usage-up':'usage-down'}">${delta>0?'+':''}${(delta*100).toFixed(0)} snap%</span>`;
  };
  const addRow=row=>`<div class="rank-row"><span>+</span><div><strong>${escapeHtml(row.name||row.playerId)}${trendBadge(row.trend)}</strong><small>${escapeHtml(row.meta||'')} • added in ${row.count.toLocaleString()} leagues today</small></div><b>${row.ownerId?escapeHtml(names[row.ownerId]||'rostered'):'FREE'}</b></div>`;
  const usageRow=(entry,dir)=>{
    const trend=usageTrend(entry.weeks);
    return `<div class="rank-row"><span>${dir==='up'?'▲':'▼'}</span><div><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.position||'')} ${escapeHtml(entry.team||'')} • snaps ${pctText(trend?.snapPct.prior)} → ${pctText(trend?.snapPct.recent)}</small></div><b class="${dir==='up'?'luck-good':'luck-bad'}">${trend?.snapPct.delta!=null?`${trend.snapPct.delta>0?'+':''}${(trend.snapPct.delta*100).toFixed(0)}`:'—'}</b></div>`;
  };

  wrap.innerHTML=`<article class="panel"><div class="panel-head"><div><p class="eyebrow">THE WIRE</p><h2>Trending &amp; Opportunity</h2></div></div>
    <p class="assistant-note">What the rest of Sleeper is doing in the last 24 hours, cross-referenced against who is actually available here, alongside real snap and target share movement.${state.usageError?` ${escapeHtml(state.usageError)}`:''}</p>
    <div class="arb-grid">
      <div><p class="eyebrow">TRENDING AND FREE IN THIS LEAGUE</p>${adds.available.length?adds.available.slice(0,6).map(addRow).join(''):'<div class="empty-cell">Nothing trending is unrostered here. Competitive league.</div>'}</div>
      <div><p class="eyebrow">TRENDING BUT ALREADY OWNED</p>${adds.rostered.length?adds.rostered.slice(0,6).map(addRow).join(''):'<div class="empty-cell">None.</div>'}</div>
    </div>
    ${state.usage?`<div class="arb-grid arb-split">
      <div><p class="eyebrow">ROLE GROWING</p>${rising.length?rising.map(e=>usageRow(e,'up')).join(''):'<div class="empty-cell">No clear risers yet this season.</div>'}</div>
      <div><p class="eyebrow">ROLE SHRINKING</p>${fading.length?fading.map(e=>usageRow(e,'down')).join(''):'<div class="empty-cell">No clear fallers yet this season.</div>'}</div>
    </div>`:''}
  </article>`;
}

// ---------------------------------------------------------------------------
// Playoff odds
// ---------------------------------------------------------------------------
async function loadRemainingSchedule(){
  const league=state.league;
  if(!league)return[];
  const playoffStart=Number(league.settings?.playoff_week_start||15);
  const current=Number(state.nflState?.week||1);
  const from=state.nflState?.season_type==='pre'?1:current;
  const ownerByRoster=Object.fromEntries((state.rosters||[]).map(r=>[Number(r.roster_id),r.owner_id]));
  const weeks=[];
  for(let week=from;week<playoffStart;week++)weeks.push(week);
  const games=[];
  await Promise.all(weeks.map(async week=>{
    const rows=await api(`/league/${league.league_id}/matchups/${week}`).catch(()=>[]);
    const groups={};
    (Array.isArray(rows)?rows:[]).forEach(m=>{if(m.matchup_id!=null)(groups[m.matchup_id]||=[]).push(m);});
    for(const pair of Object.values(groups)){
      if(pair.length!==2)continue;
      // Only weeks with no score yet are still to be played.
      if(Number(pair[0].points||0)>0||Number(pair[1].points||0)>0)continue;
      const a=ownerByRoster[Number(pair[0].roster_id)],b=ownerByRoster[Number(pair[1].roster_id)];
      if(a&&b)games.push({week,a,b});
    }
  }));
  return games.sort((x,y)=>x.week-y.week);
}
async function ensureOdds(){
  if(state.odds)return state.odds;
  if(state.oddsPromise)return state.oddsPromise;
  state.oddsPromise=(async()=>{
    await ensureEfficiency();
    const season=String(state.league?.season||'');
    const seasonWeeks=(state.efficiency?.teamWeeks||[]).filter(r=>r.season===season);
    if(!seasonWeeks.length)throw new Error('no scored weeks yet this season');
    const league=leagueScoringProfile(seasonWeeks.map(r=>r.actual));
    const schedule=await loadRemainingSchedule();
    const names=ownerNameMap();
    const teams=(state.rosters||[]).filter(r=>r.owner_id).map(roster=>{
      const ownerId=roster.owner_id;
      const scores=seasonWeeks.filter(r=>r.ownerId===ownerId).map(r=>r.actual);
      const profile=scoringProfile(scores,league);
      const settings=roster.settings||{};
      return{ownerId,manager:names[ownerId]||ownerId,wins:Number(settings.wins||0),losses:Number(settings.losses||0),
        pointsFor:scoreSettings(settings,'fpts'),mean:profile.mean,sd:profile.sd,games:profile.games,weight:profile.weight};
    });
    const playoffTeams=Number(state.league?.settings?.playoff_teams||6);
    const byes=Math.max(0,teams.length&&playoffTeams>4?playoffTeams-4:0);
    const odds=simulatePlayoffOdds({teams,schedule,iterations:10000,playoffTeams,byes,rng:makeRng(20260828)});
    state.odds={odds,teams,schedule,playoffTeams,byes,league};
    state.oddsError=null;
    return state.odds;
  })().catch(e=>{state.oddsError=`Playoff odds unavailable: ${e.message}`;return null;})
    .finally(()=>state.oddsPromise=null);
  return state.oddsPromise;
}
function renderOdds(){
  const wrap=$('odds-content');
  if(state.oddsError){$('odds-loading').innerHTML=escapeHtml(state.oddsError);return;}
  if(!state.odds)return;
  const {odds,teams,schedule,playoffTeams,byes}=state.odds;
  const byOwner=new Map(teams.map(t=>[t.ownerId,t]));
  const rows=[...odds.values()].sort((a,b)=>b.playoffPct-a.playoffPct||b.titlePct-a.titlePct);
  const bar=(value,cls)=>`<div class="odds-bar"><i class="${cls}" style="width:${Math.max(1,Math.min(100,value*100))}%"></i><span>${(value*100).toFixed(1)}%</span></div>`;
  $('odds-table').innerHTML=rows.map((row,i)=>{
    const team=byOwner.get(row.ownerId)||{};
    return `<tr><td class="rank big-rank">${i+1}</td><td><strong>${escapeHtml(team.manager||row.ownerId)}</strong><span class="tap-hint">${team.wins}-${team.losses} • ${Math.round(team.mean)} avg</span></td><td>${bar(row.playoffPct,'odds-playoff')}</td><td>${byes?bar(row.byePct,'odds-bye'):'—'}</td><td>${bar(row.titlePct,'odds-title')}</td><td>${row.avgWins.toFixed(1)}</td><td>${row.avgSeed.toFixed(1)}</td></tr>`;
  }).join('');
  const thin=teams.filter(t=>t.weight<1).length;
  $('odds-note').innerHTML=`10,000 simulations of the ${schedule.length} remaining game${schedule.length===1?'':'s'}, sampling each team's weekly score from its own distribution. ${playoffTeams} playoff spots${byes?`, ${byes} first-round bye${byes===1?'':'s'}`:''}. Ties break on points for.${thin?` ${thin} team${thin===1?'':'s'} still have a thin sample and are shrunk toward the league average.`:''}`;
  $('odds-loading').classList.add('hidden');wrap.classList.remove('hidden');
}
async function loadOdds(){
  $('odds-loading').classList.remove('hidden');$('odds-content').classList.add('hidden');
  $('odds-loading').innerHTML='<span class="spinner"></span>Simulating the rest of the season…';
  await ensureOdds();
  renderOdds();
}

// ---------------------------------------------------------------------------
// Waivers, drafts and the report card (Manager Lab tabs)
// ---------------------------------------------------------------------------
async function ensureWaivers(){
  if(state.waiversLoaded)return;
  const seasons=state.history.map(item=>String(item.league.season));
  for(const season of seasons)await loadTradeIndexForSeason(season);
  await loadPlayerMap();
  state.waiversLoaded=true;
}
function waiverRows(){
  const index=state.efficiency&&state.archive?.playerIndex;
  if(!index)return[];
  const names=ownerNameMap();
  const rows=[];
  for(const [season,claims] of state.waiversBySeason.entries()){
    if(state.labSeason!=='all'&&season!==state.labSeason)continue;
    for(const claim of claims){
      const ownerId=tradeOwnerId(claim.item,claim.rosterId);
      if(!ownerId)continue;
      const totals=realizedForSide(index,[claim.playerId],ownerId,Number(season),claim.leg||null);
      rows.push({...claim,ownerId,manager:names[ownerId]||ownerId,name:playerInfo(claim.playerId).name,points:totals.started});
    }
  }
  return rows;
}
function draftRows(){
  const index=state.archive?.playerIndex;
  if(!index)return[];
  const names=ownerNameMap();
  const rows=[];
  for(const [key,resolution] of state.draftResolutions.entries()){
    const season=String(resolution.season);
    if(state.labSeason!=='all'&&season!==state.labSeason)continue;
    const item=tradeSeasonItem(season);
    const ownerId=item?tradeOwnerId(item,resolution.originalRoster):null;
    if(!ownerId||!resolution.playerId)continue;
    const totals=realizedForSide(index,[String(resolution.playerId)],ownerId,Number(season),null);
    rows.push({ownerId,manager:names[ownerId]||ownerId,season,round:resolution.round,slot:resolution.slot,
      playerId:resolution.playerId,name:resolution.playerName||playerInfo(resolution.playerId).name,points:totals.started});
  }
  return rows;
}
function renderLabWaivers(){
  const rows=waiverRows();
  if(!rows.length){$('lab-waivers').innerHTML='<div class="empty-cell">No waiver claims found in this range.</div>';$('lab-waiver-extremes').innerHTML='';return;}
  const board=waiverLeaderboard(rows),{hits,busts}=waiverExtremes(rows);
  $('lab-waivers').innerHTML=`<div class="table-wrap"><table><thead><tr><th>#</th><th>Manager</th><th>Claims</th><th>FAAB Spent</th><th>Points</th><th>Pts / $</th><th>Best Pickup</th></tr></thead><tbody>${board.map((r,i)=>`<tr><td class="rank">${i+1}</td><td><strong>${escapeHtml(r.manager)}</strong></td><td>${r.claims}</td><td>$${Math.round(r.spend)}</td><td>${r.points.toFixed(1)}</td><td class="gold-score">${r.pointsPerDollar!=null?r.pointsPerDollar.toFixed(1):'—'}</td><td>${r.best?escapeHtml(r.best.name):'—'}</td></tr>`).join('')}</tbody></table></div>`;
  const card=(title,list,tone)=>`<div><p class="eyebrow">${title}</p>${list.length?list.map(x=>`<div class="rank-row"><span>${tone==='hit'?'▲':'▼'}</span><div><strong>${escapeHtml(x.name)}</strong><small>${escapeHtml(x.manager||'')} • ${escapeHtml(String(x.season))} W${x.week||x.leg||'?'} • $${Math.round(x.bid)}</small></div><b>${(Number(x.points)||0).toFixed(1)}</b></div>`).join(''):'<div class="empty-cell">None.</div>'}</div>`;
  $('lab-waiver-extremes').innerHTML=`<div class="arb-grid">${card('BEST PICKUPS EVER',hits,'hit')}${card('MONEY BURNED',busts,'bust')}</div>`;
}
function renderLabDrafts(){
  const rows=draftRows();
  if(!rows.length){$('lab-drafts').innerHTML='<div class="empty-cell">No resolved draft picks in this range. Open the Trades view once to load draft results.</div>';$('lab-draft-extremes').innerHTML='';return;}
  const graded=gradeDraftPicks(rows,draftSlotBaselines(rows));
  const board=draftLeaderboard(graded);
  $('lab-drafts').innerHTML=`<div class="table-wrap"><table><thead><tr><th>#</th><th>Manager</th><th>Picks</th><th>Points</th><th>vs Round Avg</th><th>Per Pick</th><th>Best</th></tr></thead><tbody>${board.map((r,i)=>`<tr><td class="rank">${i+1}</td><td><strong>${escapeHtml(r.manager)}</strong></td><td>${r.picks}</td><td>${r.points.toFixed(1)}</td><td class="${r.delta>=0?'luck-good':'luck-bad'}">${r.delta>0?'+':''}${r.delta.toFixed(1)}</td><td>${r.deltaPerPick>0?'+':''}${r.deltaPerPick.toFixed(1)}</td><td>${r.best?escapeHtml(r.best.name):'—'}</td></tr>`).join('')}</tbody></table></div>`;
  const steals=graded.slice(0,5),reaches=[...graded].reverse().slice(0,5);
  const card=(title,list)=>`<div><p class="eyebrow">${title}</p>${list.map(x=>`<div class="rank-row"><span>R${x.round}</span><div><strong>${escapeHtml(x.name)}</strong><small>${escapeHtml(x.manager)} • ${escapeHtml(x.season)} • round average ${x.baseline.toFixed(0)}</small></div><b class="${x.delta>=0?'luck-good':'luck-bad'}">${x.delta>0?'+':''}${x.delta.toFixed(0)}</b></div>`).join('')}</div>`;
  $('lab-draft-extremes').innerHTML=`<div class="arb-grid">${card('BIGGEST STEALS',steals)}${card('BIGGEST REACHES',reaches)}</div>`;
}
function renderLabReportCard(){
  const scope=labFilter();
  if(!scope)return;
  const eff=efficiencyLeaderboard(scope),luck=luckTable(scope),coaching=coachingRecord(scope.games);
  const waivers=waiverLeaderboard(waiverRows());
  const drafts=draftLeaderboard(gradeDraftPicks(draftRows(),draftSlotBaselines(draftRows())));
  const ownerIds=[...new Set(scope.teamWeeks.map(r=>r.ownerId))];
  if(!ownerIds.length){$('lab-report').innerHTML='<div class="empty-cell">Not enough history yet.</div>';return;}
  const map=(rows,key)=>new Map(rows.map(r=>[r.ownerId,r[key]]));
  const coachMap=new Map([...coaching.values()].map(r=>[r.ownerId,r.actualWins-r.optimalWins]));
  const cards=reportCard(ownerIds,[
    {key:'eff',label:'Lineup efficiency',weight:2,values:map(eff,'efficiency')},
    {key:'allplay',label:'All-play win rate',weight:2.5,values:map(luck,'allPlayPct')},
    {key:'coach',label:'Coaching (games not thrown)',weight:1,values:coachMap},
    {key:'waiver',label:'Waiver return',weight:1,values:map(waivers,'pointsPerDollar')},
    {key:'draft',label:'Draft value per pick',weight:1.5,values:map(drafts,'deltaPerPick')},
    {key:'luck',label:'Luck (lower is better)',weight:0.5,higherIsBetter:false,values:map(luck,'luck')}
  ]);
  const names=scope.names;
  const grade=score=>score>=85?'A+':score>=75?'A':score>=65?'B+':score>=55?'B':score>=45?'C+':score>=35?'C':score>=25?'D':'F';
  $('lab-report').innerHTML=cards.map((row,i)=>`<article class="report-card"><div class="report-head"><div><span>#${i+1}</span><strong>${escapeHtml(names[row.ownerId]||row.ownerId)}</strong></div><b>${grade(row.overall)}</b></div><div class="report-bars">${row.breakdown.map(b=>`<div class="report-bar"><small>${escapeHtml(b.label)}${b.missing?' (no data)':''}</small><div class="window-bar"><i style="width:${Math.max(2,Math.min(100,b.score))}%"></i></div><em>${Math.round(b.score)}</em></div>`).join('')}</div></article>`).join('');
}
async function showLabTab(tab){
  state.labTab=tab;
  if(state.route?.view==='lab'&&state.route.tab!==tab){
    state.route={...state.route,tab};
    const hash=routeHash(state.route);
    if(location.hash!==hash)history.replaceState(null,'',hash);
    renderSubNav(state.route);
  }
  $$('.lab-tab').forEach(b=>b.classList.toggle('active',b.dataset.labTab===tab));
  $$('.lab-panel').forEach(p=>p.classList.add('hidden'));
  $(`lab-${tab}-panel`).classList.remove('hidden');
  if(tab==='waivers'||tab==='drafts'||tab==='report'){
    $('lab-tab-loading').classList.remove('hidden');
    $('lab-tab-loading').innerHTML='<span class="spinner"></span>Loading transaction and draft history…';
    await ensureWaivers();
    for(const season of state.history.map(i=>String(i.league.season)))await loadDraftResolutionsForSeason(season);
    $('lab-tab-loading').classList.add('hidden');
  }
  if(tab==='waivers')renderLabWaivers();
  if(tab==='drafts')renderLabDrafts();
  if(tab==='report')renderLabReportCard();
}

// ---------------------------------------------------------------------------
// Player pages
// ---------------------------------------------------------------------------
function playerSearchResults(query){
  const q=String(query||'').trim().toLowerCase();
  if(q.length<2)return[];
  const index=state.archive?.playerIndex;
  if(!index)return[];
  const out=[];
  for(const id of index.keys()){
    const info=playerInfo(id);
    if(!info.name.toLowerCase().includes(q))continue;
    out.push({id,name:info.name,meta:info.meta,weeks:index.get(id).length});
    if(out.length>=40)break;
  }
  return out.sort((a,b)=>b.weeks-a.weeks).slice(0,15);
}
function renderPlayerPage(playerId){
  state.selectedPlayer=playerId?String(playerId):null;
  const wrap=$('player-detail');
  if(!state.selectedPlayer){wrap.innerHTML='<div class="empty-cell">Search for a player to see their full history in this league.</div>';return;}
  const index=state.archive?.playerIndex;
  const games=index?.get(state.selectedPlayer)||[];
  const info=playerInfo(state.selectedPlayer);
  if(!games.length){wrap.innerHTML=`<div class="empty-cell">No scoring history for ${escapeHtml(info.name)} in the loaded archive.</div>`;return;}
  const stints=summarizeStints(games);
  const total=games.reduce((n,g)=>n+(Number(g.points)||0),0);
  const startedTotal=games.filter(g=>g.started).reduce((n,g)=>n+(Number(g.points)||0),0);
  const best=[...games].sort((a,b)=>b.points-a.points)[0];
  const trades=[...state.tradesBySeason.values()].flat()
    .filter(t=>Object.prototype.hasOwnProperty.call(t.adds||{},state.selectedPlayer))
    .sort((a,b)=>Number(a.created||0)-Number(b.created||0));
  wrap.innerHTML=`<article class="panel">
    <div class="panel-head"><div><p class="eyebrow">PLAYER DOSSIER</p><h2>${escapeHtml(info.name)}</h2><p>${escapeHtml(info.meta||'')}</p></div><strong class="market-total">${total.toFixed(1)}</strong></div>
    <div class="profile-metrics"><div><span>Weeks rostered</span><strong>${games.length}</strong></div><div><span>Weeks started</span><strong>${games.filter(g=>g.started).length}</strong></div><div><span>Points started</span><strong>${startedTotal.toFixed(1)}</strong></div><div><span>Best week</span><strong>${best?best.points.toFixed(1):'—'}</strong></div><div><span>Owners</span><strong>${new Set(games.map(g=>g.ownerId)).size}</strong></div><div><span>Times traded</span><strong>${trades.length}</strong></div></div>
    ${usageCardHtml(state.selectedPlayer)}
    <p class="eyebrow roster-pick-head">OWNERSHIP TIMELINE</p>
    <div class="rank-list">${stints.map((s,i)=>`<div class="rank-row"><span>${i+1}</span><div><strong>${escapeHtml(s.manager)}</strong><small>${escapeHtml(String(s.from.season))} W${s.from.week} → ${escapeHtml(String(s.to.season))} W${s.to.week} • ${s.weeks} week${s.weeks===1?'':'s'}, ${s.started} started</small></div><b>${s.startedPoints.toFixed(1)}</b></div>`).join('')}</div>
    ${trades.length?`<p class="eyebrow roster-pick-head">TRADE HISTORY</p><div class="rank-list">${trades.map(t=>{const to=rosterTradeIdentity(t.item,Number(t.adds[state.selectedPlayer]));const date=tradeDateISO(t)||`${t.season} W${t.leg||'?'}`;return `<div class="rank-row"><span>⇄</span><div><strong>Traded to ${escapeHtml(to)}</strong><small>${escapeHtml(date)} • ${tradeAssetCount(t)} assets in the deal</small></div><b>${escapeHtml(String(t.season))}</b></div>`;}).join('')}</div>`:''}
  </article>`;
}
function renderPlayerSearch(){
  const results=playerSearchResults(state.playerQuery);
  $('player-results').innerHTML=results.length
    ?results.map(r=>`<button type="button" class="player-result" data-player-id="${escapeHtml(r.id)}"><div><strong>${escapeHtml(r.name)}</strong><small>${escapeHtml(r.meta||'')}</small></div><b>${r.weeks} wk</b></button>`).join('')
    :(state.playerQuery.trim().length<2?'<div class="empty-cell">Type at least two letters.</div>':'<div class="empty-cell">No player in the archive matches that.</div>');
  $$('.player-result').forEach(btn=>btn.addEventListener('click',()=>{renderPlayerPage(btn.dataset.playerId);$('player-detail').scrollIntoView({behavior:'smooth',block:'start'});}));
}
async function loadPlayers(){
  $('players-loading').classList.remove('hidden');$('players-content').classList.add('hidden');
  $('players-loading').innerHTML='<span class="spinner"></span>Loading the scoring archive…';
  await ensureEfficiency();
  await ensureWaivers().catch(()=>{});
  await ensureUsage().catch(()=>null);
  $('players-loading').classList.add('hidden');$('players-content').classList.remove('hidden');
  renderPlayerSearch();
  renderPlayerPage(state.selectedPlayer);
}

async function ensureEfficiency(){
  if(state.efficiency)return state.efficiency;
  if(state.efficiencyPromise)return state.efficiencyPromise;
  state.efficiencyPromise=(async()=>{
    await loadAllMatchups();
    await loadPlayerMap();
    state.efficiency=buildEfficiencyArchive();
    return state.efficiency;
  })().finally(()=>state.efficiencyPromise=null);
  return state.efficiencyPromise;
}
function buildEfficiencyArchive(){
  const slots=lineupSlots();
  const teamWeeks=[],weekBuckets=new Map(),games=[];
  const names=ownerNameMap();
  for(const item of state.history){
    const season=String(item.league.season);
    const ownerByRoster=Object.fromEntries(item.rosters.map(r=>[Number(r.roster_id),r.owner_id]));
    for(const {week,data} of item.matchups){
      const key=`${season}|${week}`;
      const scores=new Map(),opponents=new Map(),optimalByOwner=new Map();
      const groups={};
      for(const m of data){
        const ownerId=ownerByRoster[Number(m.roster_id)];
        if(!ownerId)continue;
        const players=Object.entries(m.players_points||{}).map(([id,pts])=>({
          id:String(id),points:Number(pts)||0,pos:playerInfo(id).position
        }));
        const starters=(m.starters||[]).map(String);
        const row=weekEfficiency({players,startedIds:starters,slots});
        teamWeeks.push({season,week,ownerId,manager:names[ownerId]||ownerId,...row,
          emptySlots:countEmptySlots(starters),
          zeroStarters:countZeroStarters(starters,m.players_points||{})});
        scores.set(ownerId,row.actual);
        optimalByOwner.set(ownerId,row.optimal);
        if(m.matchup_id!=null)(groups[m.matchup_id]||=[]).push({ownerId,actual:row.actual,optimal:row.optimal});
      }
      for(const pair of Object.values(groups)){
        if(pair.length!==2)continue;
        opponents.set(pair[0].ownerId,pair[1].ownerId);
        opponents.set(pair[1].ownerId,pair[0].ownerId);
        games.push({season,week,a:pair[0].ownerId,b:pair[1].ownerId,aActual:pair[0].actual,bActual:pair[1].actual,aOptimal:pair[0].optimal,bOptimal:pair[1].optimal});
      }
      if(scores.size)weekBuckets.set(key,{season,week,scores,opponents});
    }
  }
  return{teamWeeks,weeks:[...weekBuckets.values()],games,names};
}
function labSeasons(){
  const seasons=[...new Set((state.efficiency?.teamWeeks||[]).map(r=>r.season))].sort((a,b)=>Number(b)-Number(a));
  return seasons;
}
function labFilter(){
  const season=state.labSeason;
  const eff=state.efficiency;
  if(!eff)return null;
  const keep=r=>season==='all'||r.season===season;
  return{
    teamWeeks:eff.teamWeeks.filter(keep),
    weeks:eff.weeks.filter(keep),
    games:eff.games.filter(keep),
    names:eff.names
  };
}
function efficiencyLeaderboard(scope){
  const rows=new Map();
  for(const tw of scope.teamWeeks){
    if(!(tw.optimal>0))continue;
    const row=rows.get(tw.ownerId)||{ownerId:tw.ownerId,manager:tw.manager,actual:0,optimal:0,left:0,weeks:0,perfect:0};
    row.actual+=tw.actual;row.optimal+=tw.optimal;row.left+=tw.left;row.weeks++;
    if(tw.left===0)row.perfect++;
    rows.set(tw.ownerId,row);
  }
  return[...rows.values()].map(r=>({...r,efficiency:r.optimal?r.actual/r.optimal:0,leftPerWeek:r.weeks?r.left/r.weeks:0}))
    .sort((a,b)=>b.efficiency-a.efficiency);
}
function luckTable(scope){
  const allPlay=accumulateAllPlay(scope.weeks.map(w=>[...w.scores.entries()].map(([ownerId,points])=>({ownerId,points}))));
  const actual=new Map();
  for(const g of scope.games){
    for(const side of ['a','b']){
      const id=g[side];
      const row=actual.get(id)||{wins:0,losses:0,ties:0};
      const mine=side==='a'?g.aActual:g.bActual,theirs=side==='a'?g.bActual:g.aActual;
      if(mine>theirs)row.wins++;else if(mine<theirs)row.losses++;else row.ties++;
      actual.set(id,row);
    }
  }
  const out=[];
  for(const [ownerId,ap] of allPlay){
    const real=actual.get(ownerId)||{wins:0,losses:0,ties:0};
    out.push({
      ownerId,manager:scope.names[ownerId]||ownerId,
      wins:real.wins,losses:real.losses,
      allPlayWins:ap.wins,allPlayLosses:ap.losses,allPlayPct:ap.winPct,
      expectedWins:ap.expectedWins,luck:luckIndex(real.wins,ap.expectedWins)
    });
  }
  return out.sort((a,b)=>b.luck-a.luck);
}
function renderLab(){
  const scope=labFilter();
  if(!scope)return;
  const eff=efficiencyLeaderboard(scope),luck=luckTable(scope),coaching=coachingRecord(scope.games);

  $('lab-efficiency').innerHTML=eff.length?eff.map((r,i)=>`<tr><td class="rank big-rank">${i+1}</td><td><strong>${escapeHtml(r.manager)}</strong></td><td class="gold-score">${(r.efficiency*100).toFixed(1)}%</td><td>${r.left.toFixed(1)}</td><td>${r.leftPerWeek.toFixed(1)}</td><td>${r.perfect}</td><td>${r.weeks}</td></tr>`).join(''):'<tr><td colspan="7" class="empty-cell">No scored weeks in this range.</td></tr>';

  const worst=[...scope.teamWeeks].sort((a,b)=>b.left-a.left).slice(0,8);
  $('lab-blunders').innerHTML=worst.length?worst.map((r,i)=>`<div class="rank-row"><span>${i+1}</span><div><strong>${escapeHtml(r.manager)}</strong><small>${r.season} W${r.week}${r.topMiss?` • benched ${escapeHtml(playerInfo(r.topMiss.id).name)} (${r.topMiss.points.toFixed(1)})${r.topMissReplaced?` for ${escapeHtml(playerInfo(r.topMissReplaced.id).name)} (${r.topMissReplaced.points.toFixed(1)})`:''}`:''}</small></div><b>−${r.left.toFixed(1)}</b></div>`).join(''):'<div class="empty-cell">Nothing to see here.</div>';

  $('lab-luck').innerHTML=luck.length?luck.map(r=>`<tr><td><strong>${escapeHtml(r.manager)}</strong></td><td>${r.wins}-${r.losses}</td><td>${r.allPlayWins}-${r.allPlayLosses}</td><td>${pct(r.allPlayPct)}</td><td>${r.expectedWins.toFixed(1)}</td><td class="${r.luck>=0?'luck-good':'luck-bad'}">${r.luck>0?'+':''}${r.luck.toFixed(1)}</td></tr>`).join(''):'<tr><td colspan="6" class="empty-cell">No completed games in this range.</td></tr>';

  const coachRows=[...coaching.values()].map(r=>({...r,manager:scope.names[r.ownerId]||r.ownerId,swing:r.optimalWins-r.actualWins})).sort((a,b)=>b.swing-a.swing);
  $('lab-coaching').innerHTML=coachRows.length?coachRows.map(r=>`<tr><td><strong>${escapeHtml(r.manager)}</strong></td><td>${r.actualWins}-${r.actualLosses}</td><td>${r.optimalWins}-${r.optimalLosses}</td><td class="${r.swing>0?'luck-bad':'luck-good'}">${r.swing>0?'+':''}${r.swing}</td><td>${r.flipped.length}</td></tr>`).join(''):'<tr><td colspan="5" class="empty-cell">No games to replay.</td></tr>';

  renderScheduleSwap(scope);
}
function renderScheduleSwap(scope){
  const sel=$('lab-swap-manager'),managers=[...new Set(scope.teamWeeks.map(r=>r.ownerId))].map(id=>({id,name:scope.names[id]||id})).sort((a,b)=>a.name.localeCompare(b.name));
  const previous=sel.value;
  sel.innerHTML=managers.map(m=>`<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
  if(previous&&managers.some(m=>m.id===previous))sel.value=previous;
  const owner=sel.value;
  if(!owner){$('lab-swap').innerHTML='<div class="empty-cell">No managers in this range.</div>';return;}
  const rows=managers.map(m=>({...scheduleSwap(scope.weeks,owner,m.id),name:m.name}))
    .sort((a,b)=>b.wins-a.wins||a.losses-b.losses);
  const own=rows.find(r=>r.scheduleOwnerId===owner);
  $('lab-swap').innerHTML=rows.map(r=>`<div class="rank-row${r.scheduleOwnerId===owner?' swap-own':''}"><span>${r.scheduleOwnerId===owner?'★':''}</span><div><strong>${escapeHtml(r.name)}${r.scheduleOwnerId===owner?' (actual)':''}</strong><small>${r.scheduleOwnerId===owner?'the schedule you really played':`with ${escapeHtml(r.name)}'s schedule`}</small></div><b>${r.wins}-${r.losses}</b></div>`).join('');
  $('lab-swap-note').textContent=own?`Actual record ${own.wins}-${own.losses}. Best possible schedule would have gone ${rows[0].wins}-${rows[0].losses}, worst ${rows[rows.length-1].wins}-${rows[rows.length-1].losses}.`:'';
}
async function loadLab(){
  $('lab-loading').classList.remove('hidden');$('lab-content').classList.add('hidden');
  $('lab-loading').innerHTML='<span class="spinner"></span>Replaying every lineup in league history…';
  try{
    await ensureEfficiency();
    const seasons=labSeasons(),sel=$('lab-season');
    sel.innerHTML='<option value="all">All seasons</option>'+seasons.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    sel.value=state.labSeason;
    renderLab();
    $('lab-loading').classList.add('hidden');$('lab-content').classList.remove('hidden');
  }catch(e){
    $('lab-loading').innerHTML=`Manager Lab could not load: ${escapeHtml(e.message)}`;
  }
}

// ---------------------------------------------------------------------------
// FantasyPros expert consensus
//
// Market values are crowd sentiment: what your leaguemate will accept.
// Expert consensus is a different question: who is actually better. Neither
// replaces the other, and the gap between them is the interesting part.
// ---------------------------------------------------------------------------
async function ensureEcr(){
  if(state.ecr)return state.ecr;
  if(!CONFIG.proxyBase){state.ecrError='No proxy configured. Set CONFIG.proxyBase to enable expert rankings.';return null;}
  if(state.ecrPromise)return state.ecrPromise;
  state.ecrPromise=(async()=>{
    await Promise.all([loadPlayerMap(),ensureMarketData().catch(()=>false)]);
    const season=String(state.league?.season||new Date().getFullYear());
    // The free tier caps each response at 10 players, but the cap is per
    // request. Asking position by position returns the top 10 at each, which is
    // where positional disagreement actually shows up.
    // Ask for the full board first. On a capped tier the response comes back
    // flagged as limited and we fall back to per-position fan-out, which is the
    // only way to see past 10 players there.
    const base=CONFIG.proxyBase.replace(/\/$/,'');
    const common=`type=dynasty&scoring=${encodeURIComponent(ecrScoring())}&season=${season}`;
    let url=`${base}?${common}&position=ALL&limit=600`;
    const response=await fetch(url,{headers:{Accept:'application/json'}});
    if(!response.ok)throw new Error(`proxy returned HTTP ${response.status}`);
    let payload=await response.json();
    if(payload.public_api_limited===true){
      const fan=await fetch(`${base}?${common}&positions=QB,RB,WR,TE`,{headers:{Accept:'application/json'}});
      if(fan.ok)payload=await fan.json();
    }
    const rows=payload.players||payload.rankings||[];
    if(!Array.isArray(rows)||!rows.length)throw new Error('no rankings returned');
    const {matched,unmatched}=matchRankings(rows,buildNameIndex(state.playerMap||{}));
    state.ecrCoverage=coverageSummary(payload);
    state.ecrUnmatched=unmatched.length;
    state.ecr=matched;
    state.ecrError=null;
    return matched;
  })().catch(e=>{state.ecrError=`Expert rankings unavailable: ${e.message}`;return null;})
    .finally(()=>state.ecrPromise=null);
  return state.ecrPromise;
}
function ecrScoring(){
  const rec=Number(state.league?.scoring_settings?.rec||0);
  return rec>=1?'PPR':rec>0?'HALF':'STD';
}
function marketRankMap(){
  const players=[];
  for(const [id,p] of state.marketPlayers.entries()){
    players.push({id:String(id),position:(p?.position||playerInfo(id).position||'').toUpperCase(),value:marketValueForPlayer(id)});
  }
  return marketPositionRanks(players);
}
function arbitrageRows(){
  if(!state.ecr)return[];
  const {minPool,minDelta}=arbitrageThresholds(state.ecrCoverage||{});
  return arbitrage({ecr:state.ecr,marketRanks:marketRankMap(),minPool,minDelta});
}
function ecrBadge(playerId){
  const row=state.ecr?.get(String(playerId));
  if(!row?.positionRank)return '';
  return `<span class="ecr-badge" title="Expert consensus">${escapeHtml(row.position)}${row.positionRank}${row.tier?` · T${row.tier}`:''}</span>`;
}
function arbitrageCardHtml(rows,signal,limit=6){
  const filtered=rows.filter(r=>r.signal===signal).slice(0,limit);
  if(!filtered.length)return '<div class="empty-cell">No meaningful disagreement at this threshold.</div>';
  return filtered.map(r=>`<div class="arb-row"><div><strong>${escapeHtml(r.name)}</strong><small>${escapeHtml(r.position)}${r.team?` · ${escapeHtml(r.team)}`:''} • market ${escapeHtml(r.position)}${r.marketRank} vs experts ${escapeHtml(r.position)}${r.positionRank}</small></div><b class="arb-${signal}">${r.delta>0?'+':''}${r.delta}</b></div>`).join('');
}
/**
 * Weekly projections. Kept deliberately separate from dynasty market value:
 * projections answer "who should I start this week", market value answers "what
 * will my leaguemate accept". Blending them would make both worse.
 */
async function ensureProjections(){
  if(state.projections)return state.projections;
  if(!CONFIG.proxyBase){state.projectionsError='No proxy configured.';return null;}
  if(state.projectionsPromise)return state.projectionsPromise;
  state.projectionsPromise=(async()=>{
    await loadPlayerMap();
    const week=Number(state.nflState?.week||0);
    if(!week||state.nflState?.season_type==='pre'){state.projectionsError='Projections start in week 1.';return null;}
    const base=CONFIG.proxyBase.replace(/\/$/,'');
    const season=String(state.league?.season||new Date().getFullYear());
    const url=`${base}?endpoint=projections&season=${season}&week=${week}&positions=QB,RB,WR,TE&scoring=${encodeURIComponent(ecrScoring())}`;
    const response=await fetch(url,{headers:{Accept:'application/json'}});
    if(!response.ok)throw new Error(`proxy returned HTTP ${response.status}`);
    const payload=await response.json();
    const rows=payload.players||payload.projections||[];
    if(!Array.isArray(rows)||!rows.length)throw new Error('no projections returned');
    const {projections,fields,missing,inexactScoring}=matchProjections(rows,buildNameIndex(state.playerMap||{}),ecrScoring());
    if(!projections.size){
      throw new Error(`none of the ${rows.length} rows had a recognised points field. Check extractProjectedPoints in fantasypros.js against the payload.`);
    }
    state.projectionFields=fields;
    state.projectionsMissing=missing;
    state.projectionsInexact=inexactScoring;
    state.projections=projections;
    state.projectionsError=null;
    return projections;
  })().catch(e=>{state.projectionsError=`Projections unavailable: ${e.message}`;return null;})
    .finally(()=>state.projectionsPromise=null);
  return state.projectionsPromise;
}
function renderStartSit(){
  const wrap=$('assistant-startsit');
  if(!wrap)return;
  if(state.projectionsError){wrap.innerHTML=`<article class="panel"><div class="panel-head"><div><p class="eyebrow">THIS WEEK</p><h2>Start / Sit</h2></div></div><p class="assistant-note">${escapeHtml(state.projectionsError)}</p></article>`;return;}
  if(!state.projections){wrap.innerHTML='';return;}
  const ownerId=$('assistant-manager').value;
  const roster=currentRosterForOwner(ownerId);
  if(!roster){wrap.innerHTML='';return;}
  const players=(roster.players||[]).map(id=>{
    const projection=state.projections.get(String(id));
    return{id:String(id),pos:playerInfo(id).position,points:Number(projection?.points)||0,name:playerInfo(id).name,injury:projection?.injury||playerInfo(id).injury_status||null};
  }).filter(p=>p.pos);
  const byId=new Map(players.map(p=>[p.id,{...p,sleeperId:p.id}]));
  const best=optimalLineup(players,lineupSlots());
  const advice=startSitAdvice({optimalIds:best.chosenIds,startedIds:(roster.starters||[]).map(String),byId});
  const week=Number(state.nflState?.week||0);
  const unprojected=players.filter(p=>!state.projections.has(p.id)).length;
  const row=(p,kind)=>`<div class="startsit-row"><span class="startsit-tag startsit-${kind}">${kind==='start'?'START':'SIT'}</span><div><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.position||p.pos||'')}${p.injury?` · <em class="injury">${escapeHtml(p.injury)}</em>`:''}</small></div><b>${p.points.toFixed(1)}</b></div>`;
  wrap.innerHTML=`<article class="panel"><div class="panel-head"><div><p class="eyebrow">THIS WEEK</p><h2>Start / Sit · Week ${week}</h2></div><strong class="market-total">${advice.delta>0?`+${advice.delta.toFixed(1)}`:'Optimal'}</strong></div>
    <p class="assistant-note">Your set lineup against the best projected one. This is a points projection, unlike everything else in the app, which is dynasty market value.${unprojected?` ${unprojected} rostered player${unprojected===1?'':'s'} had no projection and count as zero.`:''}${state.projectionsInexact?` ${state.projectionsInexact} used an approximated scoring variant.`:''}</p>
    ${advice.start.length||advice.sit.length
      ? `<div class="startsit-list">${advice.start.map(p=>row(p,'start')).join('')}${advice.sit.map(p=>row(p,'sit')).join('')}</div>`
      : '<div class="empty-cell">Your lineup already matches the best projected one.</div>'}
    <div class="market-credit">Projections by <a href="https://www.fantasypros.com" target="_blank" rel="noopener">FantasyPros</a></div>
  </article>`;
}

function coverageNoteHtml(){
  const c=state.ecrCoverage;
  if(!c?.limited)return '';
  const per=Object.entries(c.perPosition||{}).filter(([,v])=>v?.returned).map(([pos,v])=>`${escapeHtml(pos)} top ${v.returned}${v.total?` of ${v.total}`:''}`).join(' • ');
  return `<div class="coverage-note"><strong>Limited coverage.</strong> The FantasyPros free tier returns the top 10 per position, so this compares only the top of each board${per?`: ${per}`:''}. Disagreements deeper in the rankings are not visible at this tier.</div>`;
}
function renderEcrPanel(){
  const wrap=$('assistant-ecr');
  if(!wrap)return;
  if(state.ecrError){wrap.innerHTML=`<article class="panel"><div class="panel-head"><div><p class="eyebrow">EXPERT CONSENSUS</p><h2>Market vs Experts</h2></div></div><p class="assistant-note">${escapeHtml(state.ecrError)}</p></article>`;return;}
  if(!state.ecr){wrap.innerHTML='';return;}
  const rows=arbitrageRows();
  const owned=rosteredPlayerIds();
  const mine=$('assistant-manager').value;
  const roster=new Set((currentRosterForOwner(mine)?.players||[]).map(String));
  const yours=rows.filter(r=>roster.has(String(r.sleeperId)));
  const available=rows.filter(r=>!owned.has(String(r.sleeperId)));
  wrap.innerHTML=`<article class="panel"><div class="panel-head"><div><p class="eyebrow">EXPERT CONSENSUS</p><h2>Market vs Experts</h2></div><small>${state.ecr.size} ranked${state.ecrUnmatched?` • ${state.ecrUnmatched} unmatched`:''}</small></div>
    ${coverageNoteHtml()}
    <p class="assistant-note">Where crowd trade value and expert consensus disagree. A positive number means the experts think more of a player than the market does.</p>
    <div class="arb-grid">
      <div><p class="eyebrow">BUY LOW (LEAGUE-WIDE)</p>${arbitrageCardHtml(rows,'buy')}</div>
      <div><p class="eyebrow">SELL HIGH (LEAGUE-WIDE)</p>${arbitrageCardHtml(rows,'sell')}</div>
    </div>
    <div class="arb-grid arb-split">
      <div><p class="eyebrow">ON YOUR ROSTER</p>${yours.length?arbitrageCardHtml(yours,'sell',4)+arbitrageCardHtml(yours,'buy',4):'<div class="empty-cell">No flagged players on this roster.</div>'}</div>
      <div><p class="eyebrow">UNROSTERED AND UNDERVALUED</p>${arbitrageCardHtml(available,'buy',4)}</div>
    </div>
    <div class="market-credit">Expert rankings by <a href="https://www.fantasypros.com" target="_blank" rel="noopener">FantasyPros</a> • market values by <a href="https://statsguyfantasy.com" target="_blank" rel="noopener">Stats Guy Fantasy</a></div>
  </article>`;
}

function assistantManagers(){return tradeLabManagers();}
function rosterPositionSnapshot(ownerId){
  const cached=memo.snapshot.get(ownerId);if(cached)return cached;
  const built=buildRosterPositionSnapshot(ownerId);
  memo.snapshot.set(ownerId,built);
  return built;
}
function buildRosterPositionSnapshot(ownerId){
  const pool=playerAssetPool(ownerId),positions=['QB','RB','WR','TE'];
  const rooms=positions.map(pos=>({pos,value:positionGroupValue(pool,pos),players:pool.filter(a=>a.pos===pos).sort((a,b)=>b.value-a.value)}));
  rooms.forEach(room=>{const leagueValues=assistantManagers().map(m=>positionGroupValue(playerAssetPool(m.ownerId),room.pos));room.rank=rankAmong(leagueValues,room.value);room.leagueSize=leagueValues.length;});
  return rooms;
}
function managerLabel(ownerId){return assistantManagers().find(m=>m.ownerId===ownerId)?.name||managerName(ownerUser(ownerId))||'Franchise';}
function pickAssetPool(ownerId){const roster=currentRosterForOwner(ownerId);return roster?currentDraftCapital(roster.roster_id).map(p=>({id:`pick:${p.season}:${p.round}:mid|orig:${p.originalRoster}`,label:`${p.season} ${['','1st','2nd','3rd','4th','5th'][p.round]||`Round ${p.round}`}`,value:Number(p.value||0),surplus:Number(p.value||0),type:'pick'})).sort((a,b)=>b.value-a.value):[];}
function balanceTradePackage(sendPlayers,receivePlayers,ownerId,partnerId){
  const send=[...sendPlayers],receive=[...receivePlayers];let sendValue=send.reduce((n,a)=>n+a.value,0),receiveValue=receive.reduce((n,a)=>n+a.value,0);
  // Market value still decides whether a deal is *acceptable* to the other
  // manager; surplus decides whether it is *useful*. Both are reported.
  const addPick=(fromOwner,toList,targetGap)=>{const picks=pickAssetPool(fromOwner).filter(p=>p.value>0);if(!picks.length)return null;return [...picks].sort((a,b)=>Math.abs(a.value-targetGap)-Math.abs(b.value-targetGap))[0]||null;};
  if(sendValue<receiveValue*.88){const p=addPick(ownerId,send,receiveValue-sendValue);if(p){send.push(p);sendValue+=p.value;}}
  else if(receiveValue<sendValue*.88){const p=addPick(partnerId,receive,sendValue-receiveValue);if(p){receive.push(p);receiveValue+=p.value;}}
  const sendSurplus=assetsSurplusTotal(send),receiveSurplus=assetsSurplusTotal(receive);
  return{send,receive,sendValue,receiveValue,sendSurplus,receiveSurplus,surplusDelta:receiveSurplus-sendSurplus,gap:Math.abs(sendValue-receiveValue)/((sendValue+receiveValue)/2||1)*100};
}
function bestTradeFramework(ownerId,partnerId,userStrength,userWeak,partnerStrength,partnerWeak){
  const mine=playerAssetPool(ownerId),theirs=playerAssetPool(partnerId);
  const myWindow=franchiseWindow(ownerId),theirWindow=franchiseWindow(partnerId);
  const myDirective=myWindow?.directive,theirDirective=theirWindow?.directive;
  const offers=mine.filter(a=>a.pos===userStrength&&a.value>0).sort((a,b)=>b.value-a.value);
  const targets=theirs.filter(a=>a.pos===userWeak&&a.value>0).sort((a,b)=>b.value-a.value);
  if(!offers.length||!targets.length)return null;
  let best=null;
  for(const target of targets.slice(0,4))for(const offer of offers.slice(0,5)){
    let pkg=balanceTradePackage([offer],[target],ownerId,partnerId);
    if(pkg.gap>18)continue;
    // A deal only closes if the assets suit both windows: the target has to be
    // something we should be buying, and the offer something they should want.
    const wantFit=assetWindowFit(target,myDirective);
    const shedFit=assetSellFit(offer,myDirective);
    const theirWantFit=assetWindowFit(offer,theirDirective);
    const windowPenalty=-(wantFit*10+shedFit*6+theirWantFit*8);
    // Total surplus is conserved in a straight swap, so "who gains surplus" is
    // not a meaningful test. What is meaningful: are BOTH sides receiving a
    // player who clears replacement at the position they need? That can be
    // true for both at once, and it is what separates a real deal from two
    // managers swapping bench depth.
    const targetSurplus=assetSurplus(target),offerSurplus=assetSurplus(offer);
    const mutual=Math.min(targetSurplus,offerSurplus);
    const surplusBonus=-Math.min(mutual,4000)/300;
    const score=pkg.gap+(offer.value>target.value*1.6?15:0)+windowPenalty+surplusBonus;
    if(!best||score<best.score)best={...pkg,target,offer,score,wantFit,shedFit,theirWantFit,targetSurplus,offerSurplus,mutual};
  }
  return best;
}
function generateTradeSuggestions(ownerId){
  const myRooms=rosterPositionSnapshot(ownerId),myWeak=[...myRooms].sort((a,b)=>b.rank-a.rank)[0],myStrong=[...myRooms].sort((a,b)=>a.rank-b.rank)[0];
  const myWindow=franchiseWindow(ownerId);
  const suggestions=[];
  for(const partner of assistantManagers().filter(m=>m.ownerId!==ownerId)){
    const rooms=rosterPositionSnapshot(partner.ownerId),partnerAtNeed=rooms.find(r=>r.pos===myWeak.pos),partnerNeedsMine=rooms.find(r=>r.pos===myStrong.pos);
    if(!partnerAtNeed||!partnerNeedsMine)continue;
    const complementary=(myWeak.rank-partnerAtNeed.rank)+(partnerNeedsMine.rank-myStrong.rank);
    if(complementary<3)continue;
    const framework=bestTradeFramework(ownerId,partner.ownerId,myStrong.pos,myWeak.pos,partnerAtNeed.pos,partnerNeedsMine.pos);if(!framework)continue;
    // Positional shape is necessary but not sufficient. A contender and a
    // rebuilder want opposite things, which is what actually closes deals.
    const partnerWindow=franchiseWindow(partner.ownerId);
    const fit=windowComplement(myWindow,partnerWindow);
    suggestions.push({partner,partnerWindow,framework,windowFit:fit,score:complementary*10+fit*35-framework.gap,myWeak,myStrong,partnerAtNeed,partnerNeedsMine});
  }
  return suggestions.sort((a,b)=>b.score-a.score).slice(0,4);
}
function bestTradePartnerMatch(ownerId){
  const mine=rosterPositionSnapshot(ownerId),leagueSize=mine[0]?.leagueSize||assistantManagers().length||1;
  const myWindow=franchiseWindow(ownerId);
  let best=null;
  for(const partner of assistantManagers().filter(m=>m.ownerId!==ownerId)){
    const theirs=rosterPositionSnapshot(partner.ownerId);
    for(const giveRoom of mine){
      const theirNeed=theirs.find(r=>r.pos===giveRoom.pos);if(!theirNeed)continue;
      const supplyGap=theirNeed.rank-giveRoom.rank;if(supplyGap<=0)continue;
      for(const needRoom of mine){
        if(needRoom.pos===giveRoom.pos)continue;
        const theirSupply=theirs.find(r=>r.pos===needRoom.pos);if(!theirSupply)continue;
        const needGap=needRoom.rank-theirSupply.rank;if(needGap<=0)continue;
        const framework=bestTradeFramework(ownerId,partner.ownerId,giveRoom.pos,needRoom.pos,theirSupply.pos,theirNeed.pos);if(!framework)continue;
        const maxGap=Math.max(1,leagueSize-1),fit=Math.min(1,(supplyGap+needGap)/(2*maxGap));
        const balance=Math.max(0,1-Math.min(framework.gap,20)/20);
        const pickFlex=Math.min(1,(pickAssetPool(ownerId).length+pickAssetPool(partner.ownerId).length)/8);
        const windowFit=windowComplement(myWindow,franchiseWindow(partner.ownerId));
        const matchScore=Math.max(1,Math.min(99,Math.round(fit*35+balance*30+windowFit*25+pickFlex*10)));
        const candidate={partner,framework,matchScore,giveRoom,needRoom,theirNeed,theirSupply,supplyGap,needGap,fit,balance,pickFlex,windowFit,partnerWindow:franchiseWindow(partner.ownerId)};
        if(!best||candidate.matchScore>best.matchScore||(candidate.matchScore===best.matchScore&&framework.gap<best.framework.gap))best=candidate;
      }
    }
  }
  return best;
}
function renderBestTradePartner(ownerId){
  const el=$('assistant-best-partner');if(!el)return;const match=bestTradePartnerMatch(ownerId),name=managerLabel(ownerId);
  if(!match){el.innerHTML='<div class="best-partner-empty"><span>BEST TRADE PARTNER</span><strong>No obvious matchmaking edge right now</strong><p>Your roster does not currently have a strong two-way positional fit with another franchise at a reasonable market-value range.</p></div>';return;}
  const f=match.framework,partner=match.partner.name,avg=(f.sendValue+f.receiveValue)/2||1;
  const balanceText=f.gap<=5?'Excellent value balance':f.gap<=10?'Good value balance':'Workable value balance';
  el.innerHTML=`<article class="best-partner-card"><div class="best-partner-score"><span>MATCH SCORE</span><strong>${match.matchScore}</strong><small>/ 100</small></div><div class="best-partner-copy"><span class="best-partner-kicker">BEST TRADE PARTNER</span><h3>${escapeHtml(partner)}</h3><p><strong>${escapeHtml(name)}</strong> is stronger at ${match.giveRoom.pos} (#${match.giveRoom.rank}) while ${escapeHtml(partner)} is weaker there (#${match.theirNeed.rank}). ${escapeHtml(partner)} is stronger at ${match.needRoom.pos} (#${match.theirSupply.rank}), your #${match.needRoom.rank} room. That creates the league's cleanest two-way roster fit right now.</p><div class="best-partner-reasons"><span>${match.giveRoom.pos} surplus ↔ ${match.needRoom.pos} need</span><span>${balanceText}</span><span>${escapeHtml(franchiseWindow(ownerId)?.label||'—')} ↔ ${escapeHtml(match.partnerWindow?.label||'—')}</span><span>${pickAssetPool(ownerId).length+pickAssetPool(match.partner.ownerId).length} combined future picks</span></div></div><div class="best-partner-framework"><small>SAMPLE FRAMEWORK</small><div>${assetListHtml(f.send)}<b>⇄</b>${assetListHtml(f.receive)}</div><span>${escapeHtml(name)} ${gradeLetter((f.receiveValue-f.sendValue)/avg*100)} · ${escapeHtml(partner)} ${gradeLetter((f.sendValue-f.receiveValue)/avg*100)}</span></div></article>`;
}
function rosteredPlayerIds(){const ids=new Set();state.rosters.forEach(r=>(r.players||[]).forEach(id=>ids.add(String(id))));return ids;}
function marketFreeAgents(){const owned=rosteredPlayerIds(),format=dynastyFormat(),out=[];for(const [id,p] of state.marketPlayers.entries()){if(owned.has(String(id)))continue;const value=Number(p?.value?.[format]||0);if(!value)continue;const info=playerInfo(id);out.push({id:String(id),name:p.name||info.name,pos:p.position||info.position,team:p.team||'',value,age:info.age,type:'player'});}return out.sort((a,b)=>b.value-a.value);}
// Minimum bodies a roster needs at each position to fill its strict lineup
// slots, so the Assistant never suggests cutting the last startable QB.
function requiredPositionCounts(){
  const counts={};
  lineupSlots().filter(s=>s.length===1).forEach(([pos])=>{counts[pos]=(counts[pos]||0)+1;});
  return counts;
}
function cutCandidatePool(ownerId){
  const roster=currentRosterForOwner(ownerId);if(!roster)return[];
  const starters=new Set((roster.starters||[]).map(String)),taxi=new Set((roster.taxi||[]).map(String)),reserve=new Set((roster.reserve||[]).map(String));
  const all=(roster.players||[]).map(id=>{const p=playerInfo(id);return{id:String(id),name:p.name,pos:p.position||(p.meta||'').split(' • ')[0],meta:p.meta,value:marketValueForPlayer(id),age:p.age,yearsExp:p.yearsExp};});
  const required=requiredPositionCounts(),held={};
  all.forEach(a=>{held[a.pos]=(held[a.pos]||0)+1;});
  // A 21-year-old on the bench is a stash, not a cut. Only surface one if the
  // market says the asset is genuinely worthless.
  const isStash=a=>a.value>0&&((a.yearsExp!=null&&a.yearsExp<=1)||(a.age!=null&&a.age<=23));
  const isScarce=a=>required[a.pos]&&held[a.pos]<=required[a.pos];
  return all
    .filter(a=>!starters.has(a.id)&&!taxi.has(a.id)&&!reserve.has(a.id))
    .filter(a=>!isStash(a)&&!isScarce(a))
    .sort((a,b)=>a.value-b.value);
}
function medianValue(rows){
  const vals=rows.map(r=>Number(r.value)||0).sort((a,b)=>a-b);
  if(!vals.length)return 0;
  const mid=Math.floor(vals.length/2);
  return vals.length%2?vals[mid]:(vals[mid-1]+vals[mid])/2;
}
function generateFreeAgentUpgrades(ownerId){
  const cuts=cutCandidatePool(ownerId),free=marketFreeAgents(),out=[],usedCuts=new Set();
  // Thresholds scale with the roster rather than hard-coded points, so they
  // hold across scoring formats and value-service scales.
  const benchMedian=medianValue(cuts);
  const minGain=Math.max(benchMedian*0.75,1);
  for(const fa of free.slice(0,120)){
    if(!fa.pos)continue;
    const cut=cuts.filter(c=>c.pos===fa.pos&&!usedCuts.has(c.id)).sort((a,b)=>a.value-b.value)[0];if(!cut)continue;
    const gain=fa.value-cut.value;
    if(gain<minGain||fa.value<cut.value*1.25)continue;
    out.push({fa,cut,gain});usedCuts.add(cut.id);if(out.length>=5)break;
  }
  // A rebuilding roster should see the young upgrade first even when a slightly
  // bigger raw gain sits behind an older player.
  const directive=franchiseWindow(ownerId)?.directive;
  return out.sort((a,b)=>(b.gain+assetWindowFit(b.fa,directive)*benchMedian*0.4)-(a.gain+assetWindowFit(a.fa,directive)*benchMedian*0.4));
}
function assetListHtml(items){return items.map(a=>`<span class="assistant-asset"><strong>${escapeHtml(a.label||a.name)}</strong><small>${Math.round(a.value||0).toLocaleString()}</small></span>`).join('');}
function renderRosterAssistant(){
  const ownerId=$('assistant-manager').value;if(!ownerId)return;const name=managerLabel(ownerId),rooms=rosterPositionSnapshot(ownerId),strong=[...rooms].sort((a,b)=>a.rank-b.rank)[0],weak=[...rooms].sort((a,b)=>b.rank-a.rank)[0];
  $('assistant-team-name').textContent=name;$('assistant-strength').textContent=`${strong.pos} · #${strong.rank}`;$('assistant-weakness').textContent=`${weak.pos} · #${weak.rank}`;
  const win=franchiseWindow(ownerId);
  $('assistant-window-label').textContent=win?win.label:'—';
  $('assistant-window').innerHTML=windowCardHtml(ownerId);
  renderBestTradePartner(ownerId);
  renderStartSit();
  renderTrendingPanel();
  renderEcrPanel();
  const trades=generateTradeSuggestions(ownerId);$('assistant-trades').innerHTML=trades.length?trades.map((x,i)=>{const f=x.framework,avg=(f.sendValue+f.receiveValue)/2||1,edge=(f.receiveValue-f.sendValue)/avg*100;return `<article class="assistant-card"><div class="assistant-card-head"><div><span>PARTNER ${i+1}</span><strong>${escapeHtml(x.partner.name)}</strong></div><b>${Math.abs(edge)<=5?'Balanced':`${Math.abs(edge).toFixed(0)}% value gap`}</b></div><p>You are #${x.myStrong.rank} at ${x.myStrong.pos} and #${x.myWeak.rank} at ${x.myWeak.pos}. ${escapeHtml(x.partner.name)} has the complementary roster shape${x.partnerWindow?` and is ${escapeHtml(x.partnerWindow.label.toLowerCase())} to your ${escapeHtml((win?.label||'position').toLowerCase())}`:''}.</p><div class="assistant-window-tags"><span>${escapeHtml(win?.label||'—')}</span><b>⇄</b><span>${escapeHtml(x.partnerWindow?.label||'—')}</span><small>${Math.round((x.windowFit||0)*100)}% window fit</small></div><div class="assistant-deal"><div><small>OFFER</small>${assetListHtml(f.send)}</div><span>⇄</span><div><small>TARGET</small>${assetListHtml(f.receive)}</div></div><div class="assistant-grades"><span>${escapeHtml(name)} <b>${gradeLetter((f.receiveValue-f.sendValue)/avg*100)}</b></span><span>${escapeHtml(x.partner.name)} <b>${gradeLetter((f.sendValue-f.receiveValue)/avg*100)}</b></span><span class="assistant-surplus">Surplus ${fmtDelta(f.surplusDelta||0)}</span></div></article>`;}).join(''):'<div class="empty-cell">No strong complementary trade match found right now. That is better than manufacturing a bad trade idea.</div>';
  const upgrades=generateFreeAgentUpgrades(ownerId);$('assistant-free-agents').innerHTML=upgrades.length?upgrades.map(x=>`<article class="assistant-card fa-upgrade"><div class="assistant-card-head"><div><span>FREE AGENT UPGRADE</span><strong>Add ${escapeHtml(x.fa.name)}</strong></div><b>+${Math.round(x.gain).toLocaleString()}</b></div><p>${escapeHtml(x.fa.pos)}${x.fa.team?` · ${escapeHtml(x.fa.team)}`:''} is currently unrostered and carries more dynasty value than a fringe asset on this roster.</p><div class="assistant-swap"><div><small>ADD</small><strong>${escapeHtml(x.fa.name)}</strong><span>${Math.round(x.fa.value).toLocaleString()} value</span></div><div>→</div><div><small>CUT CANDIDATE</small><strong>${escapeHtml(x.cut.name)}</strong><span>${Math.round(x.cut.value).toLocaleString()} value</span></div></div></article>`).join(''):'<div class="empty-cell">No meaningful same-position free-agent upgrade clears the current threshold.</div>';
  const cuts=cutCandidatePool(ownerId).slice(0,4);$('assistant-cuts').innerHTML=cuts.length?cuts.map((c,i)=>`<div class="cut-row"><span>${i+1}</span><div><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(c.meta||c.pos)} · bench only; starters, taxi, reserve, young stashes and scarce-position depth are protected</small></div><b>${Math.round(c.value).toLocaleString()}</b></div>`).join(''):'<div class="empty-cell">No eligible bench cut candidates found.</div>';
}
async function loadRosterAssistant(){
  $('assistant-loading').classList.remove('hidden');$('assistant-content').classList.add('hidden');await Promise.all([ensureMarketData(),loadPlayerMap(),api(`/league/${CONFIG.primaryLeagueId}/traded_picks`).then(x=>{state.currentTradedPicks=Array.isArray(x)?x:[];clearRosterMemo();}).catch(()=>{state.currentTradedPicks=[];clearRosterMemo();})]).catch(()=>{});
  const managers=assistantManagers(),sel=$('assistant-manager'),old=sel.value;sel.innerHTML=managers.map(m=>`<option value="${escapeHtml(m.ownerId)}">${escapeHtml(m.name)}</option>`).join('');if(old&&managers.some(m=>m.ownerId===old))sel.value=old;
  renderRosterAssistant();$('assistant-loading').classList.add('hidden');$('assistant-content').classList.remove('hidden');
  if(CONFIG.proxyBase){
    ensureEcr().then(()=>renderEcrPanel()).catch(()=>renderEcrPanel());
    ensureProjections().then(()=>renderStartSit()).catch(()=>renderStartSit());
    ensureUsage().then(()=>renderTrendingPanel()).catch(()=>renderTrendingPanel());
  }
  ensureTrending().then(()=>renderTrendingPanel()).catch(()=>{});
}

async function ensureArchive(){if(!state.matchupsLoaded){$('h2h-loading').classList.remove('hidden');$('franchise-loading').classList.remove('hidden');$('records-loading').classList.remove('hidden');await loadAllMatchups();$('h2h-loading').classList.add('hidden');$('records-loading').classList.add('hidden');}renderH2HSelectors();renderFranchiseHall();renderTeamRecords();renderCareerRecords();renderSeasonExplorer(Number($('explorer-season').value||0));}

function renderNav(){
  $('nav').innerHTML=NAV.map(group=>`<button class="nav-item" data-group="${escapeHtml(group.key)}"><span class="nav-icon">${group.icon}</span><span>${escapeHtml(group.label)}</span></button>`).join('');
  $$('.nav-item').forEach(button=>button.addEventListener('click',()=>{
    const group=NAV.find(g=>g.key===button.dataset.group);
    const first=group?.items?.[0];
    if(first)goTo({group:group.key,view:first.view,tab:first.tab||null});
  }));
}
function renderSubNav(route){
  const items=itemsForGroup(route.group);
  const current=routeId(route);
  $('subnav').innerHTML=items.map(item=>`<button class="subnav-item${item.id===current?' active':''}" data-route="${escapeHtml(item.id)}">${escapeHtml(item.label)}</button>`).join('');
  $$('.subnav-item').forEach(button=>button.addEventListener('click',()=>{
    const target=items.find(i=>i.id===button.dataset.route);
    if(target)goTo({group:route.group,view:target.view,tab:target.tab||null});
  }));
}
function activateView(route){
  state.route=route;state.view=route.view;
  $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.group===route.group));
  $$('.view').forEach(v=>v.classList.toggle('active-view',v.id===`${route.view}-view`));
  renderSubNav(route);
}
/** Move to a destination, update the hash so it can be shared, then load it. */
async function goTo(target,{replace=false}={}){
  const route=resolveRoute(target);
  const hash=routeHash(route);
  if(location.hash!==hash){
    if(replace)history.replaceState(null,'',hash);
    else history.pushState(null,'',hash);
  }
  await navigate(route);
}
async function navigate(target){
  const route=typeof target==='string'?resolveRoute(parseRoute(target)):resolveRoute(target);
  activateView(route);
  const name=route.view;
  try{if(['franchises','headtohead','records','season'].includes(name))await ensureArchive();if(name==='franchises')enhanceFranchiseMarket().catch(()=>{});if(name==='trades')await loadTrades();if(name==='tradelab')await loadTradeLab();if(name==='assistant')await loadRosterAssistant();if(name==='lab')await loadLab();if(name==='odds')await loadOdds();if(name==='pulse')await loadPulse();if(name==='players')await loadPlayers();if(name==='headtohead')renderH2H();if(name==='records')await showRecordView(state.recordView);
    if(route.tab&&name==='lab')await showLabTab(route.tab);
  }catch(e){showError(`Historical analytics could not finish loading: ${e.message}`);}}

// Full reload used to be location.reload(), which threw away the player
// directory cache and every loaded season. Drop only the volatile state and
// re-run the current view.
async function refreshAll(){
  state.archive=null;state.matchupsLoaded=false;state.matchupsPromise=null;
  state.tradesBySeason.clear();state.tradePromisesBySeason.clear();
  state.tradeGradesBySeason.clear();state.tradeGradePromises.clear();
  state.draftResolutions.clear();state.draftResolutionSeasons.clear();
  state.marketLoaded=false;state.marketPromise=null;state.marketPlayers.clear();state.marketPicks.clear();
  state.currentTradedPicks=null;state.tradeRelationshipsLoaded=false;state.tradeRelationshipsPromise=null;
  state.tradeLabRendered=false;state.pickValueWarned=false;
  state.lineageReady=false;state.lineagePromise=null;state.lineageByTrade.clear();
  state.efficiency=null;state.efficiencyPromise=null;state.odds=null;state.oddsPromise=null;state.oddsError=null;state.usage=null;state.usagePromise=null;state.usageError=null;state.trending=null;state.waiversBySeason.clear();state.waiversLoaded=false;state.ecr=null;state.ecrPromise=null;state.ecrError=null;state.projections=null;state.projectionsPromise=null;state.projectionsError=null;
  clearRosterMemo();
  await load();
  await navigate(state.route);
}

/** Open whatever the URL asks for, so shared links land in the right place. */
async function openInitialRoute(){
  const route=resolveRoute(parseRoute(location.hash));
  await goTo(route,{replace:true});
}

async function load(){clearError();setApiState('loading','Connecting to Sleeper');$('league-meta').textContent='Loading league...';try{state.league=await api(`/league/${CONFIG.primaryLeagueId}`);[state.users,state.rosters,state.nflState]=await Promise.all([api(`/league/${CONFIG.primaryLeagueId}/users`),api(`/league/${CONFIG.primaryLeagueId}/rosters`),api('/state/nfl').catch(()=>null)]);renderCurrentLeague();await renderCurrentWeek();stampLiveUpdate();startLiveRefresh();setApiState('','Live Sleeper data');try{await loadHistory();setApiState('','Live + history ready');$('overview-legends').innerHTML='<div class="mini-award"><span>Historical Analytics</span><strong>Ready on demand</strong><small>Open H2H, Franchises or Records to load the deep archive.</small></div>';}catch(e){showError(`Current league loaded, but history could not finish: ${e.message}`);}}catch(e){showError(`Could not load Sleeper league ${CONFIG.primaryLeagueId}: ${e.message}`);}}

renderNav();
activateView(resolveRoute(parseRoute(location.hash)));
window.addEventListener('popstate',()=>navigate(resolveRoute(parseRoute(location.hash))));
window.addEventListener('hashchange',()=>{
  const route=resolveRoute(parseRoute(location.hash));
  if(routeId(route)!==routeId(state.route))navigate(route);
});
$$('[data-jump]').forEach(b=>b.addEventListener('click',()=>goTo(resolveRoute(parseRoute(b.dataset.jump)))));$('season-select').addEventListener('change',e=>renderStandingsSeason(Number(e.target.value)));$('explorer-season').addEventListener('change',e=>renderSeasonExplorer(Number(e.target.value)));$('franchise-select').addEventListener('change',e=>renderFranchiseProfile(e.target.value));$('trade-season').addEventListener('change',loadSelectedTradeSeason);$('trade-chain-toggle').addEventListener('click',()=>{setChainMode(!state.chainMode).catch(e=>showError(`Chain grades failed: ${e.message}`));});$('trade-lab-a').addEventListener('change',()=>{state.tradeLabSelections.a.clear();refreshTradeLabSides();});$('trade-lab-b').addEventListener('change',()=>{state.tradeLabSelections.b.clear();refreshTradeLabSides();});$('assistant-manager').addEventListener('change',renderRosterAssistant);$('lab-season').addEventListener('change',e=>{state.labSeason=e.target.value;renderLab();if(state.labTab!=='efficiency')showLabTab(state.labTab);});
$('player-search').addEventListener('input',e=>{state.playerQuery=e.target.value;renderPlayerSearch();});
$('pulse-season').addEventListener('change',e=>{state.pulseSeason=e.target.value;renderPulse();});$('lab-swap-manager').addEventListener('change',()=>{const scope=labFilter();if(scope)renderScheduleSwap(scope);});$('h2h-a').addEventListener('change',renderH2H);$('h2h-b').addEventListener('change',renderH2H);$$('.h2h-mode-tab').forEach(b=>b.addEventListener('click',()=>setH2HMode(b.dataset.h2hMode)));$('trade-partner-manager').addEventListener('change',()=>{renderTradeRelationships();hydrateSelectedTradeRelationship();});$('trade-partner-opponent').addEventListener('change',()=>{renderTradeRelationships();hydrateSelectedTradeRelationship();});$$('.record-tab').filter(b=>!b.classList.contains('h2h-mode-tab')).forEach(b=>b.addEventListener('click',()=>showRecordView(b.dataset.recordView)));$('refresh-btn').addEventListener('click',()=>{refreshAll().catch(e=>showError(`Refresh failed: ${e.message}`));});
load().then(()=>openInitialRoute()).catch(()=>{});
