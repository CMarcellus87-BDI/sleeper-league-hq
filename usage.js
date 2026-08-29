// Opportunity metrics from nflverse, and Sleeper's trending add/drop feed.
//
// Market value tells you what a player is worth. Usage tells you *why* it is
// moving, and often tells you before the market does: snap share and target
// share lead fantasy production, they do not follow it.
//
// Pure module. The fetching lives in app.js and goes through the worker.

/**
 * Minimal RFC4180-ish CSV parser. nflverse ships plain CSV with quoted fields
 * containing commas, which is the only case that needs care.
 */
export function parseCsv(text = '') {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (char === '\r') continue;
    field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1)
    // Drop only genuinely blank lines. Filtering on column count would also
    // discard legitimate single-column rows.
    .filter(r => !(r.length === 1 && r[0].trim() === ''))
    .map(r => Object.fromEntries(header.map((key, i) => [key, r[i] ?? ''])));
}

const num = v => {
  if (v == null || v === '' || v === 'NA') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One weekly usage row, normalised across the stats and snap-count datasets. */
export function normalizeUsageRow(row = {}) {
  return {
    gsisId: row.player_id || row.gsis_id || null,
    name: row.player_display_name || row.player_name || row.player || '',
    position: String(row.position || '').toUpperCase(),
    team: row.recent_team || row.team || '',
    season: num(row.season),
    week: num(row.week),
    snapPct: num(row.offense_pct),
    snaps: num(row.offense_snaps),
    targets: num(row.targets),
    receptions: num(row.receptions),
    carries: num(row.carries),
    airYards: num(row.receiving_air_yards),
    targetShare: num(row.target_share),
    airYardsShare: num(row.air_yards_share),
    wopr: num(row.wopr),
    // Both published variants are kept so the league's own format can be
    // served, and half derived, rather than assuming PPR.
    pointsStd: num(row.fantasy_points),
    pointsPpr: num(row.fantasy_points_ppr),
    points: null
  };
}

/** Group weekly rows per player, newest last. */
export function aggregateUsage(rows = [], scorePoints = null) {
  const players = new Map();
  for (const raw of rows) {
    const row = normalizeUsageRow(raw);
    row.points = scorePoints ? scorePoints(row) : row.pointsPpr;
    if (!row.gsisId && !row.name) continue;
    const key = row.gsisId || `name:${row.name.toLowerCase()}|${row.position}`;
    const entry = players.get(key) || { key, gsisId: row.gsisId, name: row.name, position: row.position, team: row.team, weeks: [] };
    entry.team = row.team || entry.team;
    entry.weeks.push(row);
    players.set(key, entry);
  }
  for (const entry of players.values()) {
    entry.weeks.sort((a, b) => (a.season - b.season) || (a.week - b.week));
  }
  return players;
}

/**
 * Merge snap-count rows into stats rows. The two nflverse datasets use
 * different player ids, so snaps join on name, team and week.
 */
export function mergeSnapCounts(usage = new Map(), snapRows = []) {
  const byKey = new Map();
  for (const raw of snapRows) {
    const row = normalizeUsageRow(raw);
    if (!row.name || row.week == null) continue;
    byKey.set(`${row.name.toLowerCase()}|${row.week}`, row);
  }
  for (const entry of usage.values()) {
    for (const week of entry.weeks) {
      if (week.snapPct != null) continue;
      const match = byKey.get(`${entry.name.toLowerCase()}|${week.week}`);
      if (match) {
        week.snapPct = match.snapPct;
        week.snaps = match.snaps;
      }
    }
  }
  return usage;
}

const mean = values => {
  const nums = values.filter(v => v != null && Number.isFinite(v));
  return nums.length ? nums.reduce((n, v) => n + v, 0) / nums.length : null;
};

/**
 * Recent form against everything before it.
 *
 * A player whose snap share jumped from 40% to 80% over three weeks is a very
 * different asset from one who has been at 60% all year, and the season average
 * hides exactly that. Returns null deltas when there is no prior period to
 * compare against rather than inventing a trend from one week.
 */
export function usageTrend(weeks = [], recentCount = 3) {
  const played = weeks.filter(w => w.snapPct != null || w.targetShare != null);
  if (!played.length) return null;
  const recent = played.slice(-recentCount);
  const prior = played.slice(0, Math.max(0, played.length - recentCount));

  const field = key => ({
    recent: mean(recent.map(w => w[key])),
    prior: prior.length ? mean(prior.map(w => w[key])) : null
  });

  const build = key => {
    const { recent: r, prior: p } = field(key);
    return { recent: r, prior: p, delta: r != null && p != null ? r - p : null };
  };

  return {
    games: played.length,
    recentGames: recent.length,
    snapPct: build('snapPct'),
    targetShare: build('targetShare'),
    airYardsShare: build('airYardsShare'),
    wopr: build('wopr'),
    points: build('points')
  };
}

/**
 * Players whose opportunity is climbing fastest.
 *
 * Requires a real prior period and a meaningful current role, because a jump
 * from 5% to 15% of snaps is noise and a jump from 45% to 75% is a story.
 */
export function risingUsage(usage = new Map(), { minDelta = 0.12, minRecent = 0.4, minGames = 4 } = {}) {
  const rows = [];
  for (const entry of usage.values()) {
    const trend = usageTrend(entry.weeks);
    if (!trend || trend.games < minGames) continue;
    const snap = trend.snapPct;
    const share = trend.targetShare;
    const snapDelta = snap.delta ?? 0;
    const shareDelta = (share.delta ?? 0) * 2; // target share moves on a smaller scale
    const score = snapDelta + shareDelta;
    if (score < minDelta) continue;
    if (snap.recent != null && snap.recent < minRecent) continue;
    rows.push({ ...entry, trend, score });
  }
  return rows.sort((a, b) => b.score - a.score);
}

/** Same, inverted: players losing their role. */
export function fadingUsage(usage = new Map(), { minDrop = 0.12, minGames = 4 } = {}) {
  const rows = [];
  for (const entry of usage.values()) {
    const trend = usageTrend(entry.weeks);
    if (!trend || trend.games < minGames) continue;
    const score = (trend.snapPct.delta ?? 0) + (trend.targetShare.delta ?? 0) * 2;
    if (score > -minDrop) continue;
    rows.push({ ...entry, trend, score });
  }
  return rows.sort((a, b) => a.score - b.score);
}

/**
 * Cross-reference Sleeper's league-wide trending adds against this league.
 *
 * "Everyone is adding this guy" is only actionable if he is actually available
 * here, so rostered players are separated out rather than dropped: knowing a
 * leaguemate holds a surging player is useful too.
 */
export function crossReferenceTrending(trending = [], { rosteredIds = new Set(), ownerByPlayer = new Map(), describe = () => ({}) } = {}) {
  const available = [];
  const rostered = [];
  for (const item of trending) {
    const id = String(item?.player_id ?? item?.id ?? '');
    if (!id) continue;
    const row = {
      playerId: id,
      count: Number(item.count) || 0,
      ...describe(id)
    };
    if (rosteredIds.has(id)) rostered.push({ ...row, ownerId: ownerByPlayer.get(id) || null });
    else available.push(row);
  }
  return { available, rostered };
}
