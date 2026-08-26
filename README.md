# Dynasty of Legends — Sleeper League HQ v4

A static, GitHub Pages-friendly fantasy football archive powered by Sleeper's public read-only API.

## League

Primary Sleeper league ID: `1326583431680761856`

## v4 features

- Current-season League HQ with standings and matchup board
- Trophy Room with true playoff-bracket champions and runners-up
- Historical standings for every linked Sleeper season
- Franchise Hall with all-time titles, finals, playoff appearances, W-L-T, PF, GOAT Index, Pain Index, and Rivalry Index
- Full cross-season head-to-head matchup archive
- Record Book for team-week, matchup, season, and individual-player records
- Season Explorer with champion, standings, weekly highs, and playoff summary
- Progressive historical loading so the live homepage renders before expensive archive analytics

## Deployment

Upload these files to the root of a GitHub repository and enable GitHub Pages from the `main` branch / root folder:

- `index.html`
- `styles.css`
- `app.js`
- `dynasty-crest.svg`

No backend, build process, or API token is required.

## Custom indexes

The DOL GOAT, Pain, and Rivalry indexes are custom league analytics calculated from Sleeper data. Their formulas are shown in the UI and are intended for entertainment, trash talk, and historical comparison.
