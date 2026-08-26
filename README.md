# Dynasty of Legends — Sleeper League HQ

A GitHub Pages-friendly dashboard for Sleeper league `1326583431680761856`.

## V3

- Live current-season standings
- Dynasty history by following Sleeper's `previous_league_id` chain
- Champions resolved from each season's winners bracket
- Cleaner history snapshot: Year → Champion → Record → Trophy
- All-time championship leaders
- Head-to-head rivalry archive across linked seasons, including playoffs
- Highest individual player scoring performances from historical matchup data
- Progressive loading: historical matchups and the Sleeper NFL player directory load only when needed
- Custom Dynasty of Legends SVG crest

## Hosting

This project is intentionally static: `index.html`, `styles.css`, `app.js`, and `dynasty-crest.svg`. It can run directly on GitHub Pages without a backend.

## Notes

Sleeper's player directory is a large endpoint, so the Records page loads it only on demand. If Sleeper rate-limits or temporarily fails, the current-season UI should still remain usable and error messages are shown inline.
