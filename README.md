# Dynasty of Legends — Sleeper League HQ

A no-backend GitHub Pages dashboard for Sleeper league `1326583431680761856`.

## v2 features

- Live current-season standings
- True historical champions from Sleeper's winners bracket
- Cleaner championship ledger: year / champion / record / trophy
- All-time championship leaders
- Cross-season manager head-to-head records and matchup history
- Highest individual player game scores across linked seasons
- Dynasty of Legends custom visual identity

## Deploy

This repo is designed for GitHub Pages. Serve the root of the `main` branch.

## Data source

The browser reads the public Sleeper API directly. `previous_league_id` is followed backward to build league history. Historical matchup pages are loaded for linked seasons; the Sleeper NFL player directory is loaded to convert player IDs into names.

No API key or backend is required.
