# Dynasty of Legends v7.0

A mobile-friendly Sleeper dynasty league archive and trade analytics dashboard for league `1326583431680761856`.

## What's new in v7

- Current roster + draft-capital module inside Franchise Profiles
- Live dynasty market values using Stats Guy Fantasy's public API (Sleeper IDs are used directly)
- Trade Lab that builds deals from the league's real current rosters and mapped future picks
- Historical trade grading:
  - **THEN** uses the nearest historical market snapshot when available
  - **NOW** replaces resolved draft picks with the actual player drafted and values the resulting assets today
- Trade Hall of Fame / Hall of Shame cards (best outcome, worst outcome, best gamble, good process / bad result)
- On-demand asset lineage for resolved picks so mobile users don't load the full transaction archive unless they ask for it
- Season-by-season trade loading remains the default for performance

## Value-source notes

Market values are supplied by Stats Guy Fantasy (`https://api.statsguyfantasy.com/api/v1`). The app displays visible source credit as required by their public API terms. Historical snapshots currently begin on 2025-09-01, so older Sleeper trades can receive a current/outcome grade but may not have an at-the-time market grade.

## Run locally

Because browsers can restrict remote API requests from `file://`, serve the folder over HTTP:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Data sources

- Sleeper public API: league, users, rosters, history, matchups, brackets, transactions, drafts and traded picks
- Stats Guy Fantasy API: dynasty player values, rookie-pick values and historical trade-value snapshots

## v7.1 Trade Lab context

Trade Lab now evaluates more than raw market balance. For each proposed deal it simulates the post-trade rosters and reports:

- best legal starting-lineup market-value change based on the league roster slots
- QB/RB/WR/TE room value and league-rank movement
- future draft-capital value change
- future pick-count change
- a short contextual read such as contender move, future-focused move, or balanced roster move

The lineup metric is intentionally market-value based; it is not presented as a weekly fantasy-points projection.

## v7.2 additions

- Live matchup refresh: current Sleeper matchup scores refresh every 60 seconds while the page is visible.
- Live week tracking: the refresh also re-reads Sleeper NFL state, so Home advances with the NFL week automatically; preseason remains pinned to Week 1.
- Last-updated indicator in the live data card.
- Head to Head now includes a Trade Relationships mode.
- Select any manager to rank their most frequent trading partners across linked league history.
- Select a partner to view every bilateral trade across seasons, including resolved historical draft picks where available.
- Historical trade relationship loading remains lazy and only runs when Trade Relationships is opened.
