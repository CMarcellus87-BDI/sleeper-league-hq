# Sleeper League HQ

A lightweight fantasy-football command center powered by Sleeper's public read-only API.

## Current prototype

- Live league metadata
- Live standings from rosters/users
- League leaders and points leaders
- Preseason-safe home matchup view: defaults to regular-season Week 1 until the NFL regular season begins
- Dynasty history traversal through `previous_league_id`
- Season selector
- Franchise profiles and career leaderboard
- League record book and head-to-head archive
- Trade Center with historical draft-pick resolution (`2024 1.04 → Player`) when Sleeper draft history supports the mapping
- W-L records intentionally ignore Sleeper tie counters for this league
- GitHub Pages-friendly: no backend and no build step

The prototype is currently configured for league ID `1326583431680761856`.

## Run locally

Do not double-click `index.html`; serve the directory over HTTP so browser API requests behave consistently.

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Deploy with GitHub Pages

1. Create a repository and add these files at the repository root.
2. In GitHub: Settings → Pages.
3. Choose **Deploy from a branch**, `main`, `/ (root)`.

## Next phase: BDI Fantasy HQ

Add a second league ID to configuration and merge both datasets into:

- Conference A / Conference B standings
- Combined 20-team power rankings
- Weekly awards
- Points-for playoff cut line (top 3 per conference)
- Weeks 15–17 custom 6 → 4 → 2 championship series
- All-time league records and head-to-head history

## Sleeper API

This app uses `https://api.sleeper.app/v1`. Sleeper's public API is read-only and does not require an API token.


## v6.2 performance update
- Trade Center now loads one season at a time instead of crawling the full dynasty archive.
- Current season is selected by default.
- Previously loaded seasons are cached in-memory for instant switching.
- Draft-pick resolution only loads draft seasons actually referenced by the selected season's trades.
- All Seasons remains available as an explicit slower opt-in.
