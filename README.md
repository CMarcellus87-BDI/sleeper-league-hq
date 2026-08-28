# Dynasty of Legends

A mobile-friendly Sleeper dynasty league archive and trade analytics dashboard.

Default league is `1326583431680761856`. Any Sleeper league can be loaded with
`?league=<league_id>` in the URL.

## Run locally

The app uses ES modules and calls remote APIs, both of which browsers block on
`file://`. Serve it over HTTP:

```bash
npm run serve   # or: python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Test

```bash
npm test
```

Tests cover `analytics.js`, which holds the pure scoring and grading math with
no DOM or network dependencies.

## What it does

- **Overview / Standings / History** — live league state, linked season history,
  championship ledger, trophy wall.
- **Legends** — career franchise table, DOL index, pain index, rivalry index,
  and per-franchise profiles including current roster and draft capital.
- **Trades** — season-by-season trade archive with three independent grades per
  side (see below), award cards, and on-demand pick lineage tracing.
- **Trade Lab** — build a hypothetical deal from real current rosters and mapped
  future picks; reports market balance plus lineup, positional-rank and
  draft-capital impact.
- **Assistant** — competitive window read, positional strengths and weaknesses,
  window-aware trade partner matchmaking, free-agent upgrades, and protected cut
  candidates.
- **Manager Lab** — lineup efficiency, worst start/sit calls in league history,
  all-play records and a luck index, coaching record, and borrowed schedules.
- **H2H / Records / Seasons** — matchup archive, trade relationships, all-time
  team, career and player records, and a per-season explorer.

## How trades are graded

Each side of a trade gets up to three independent grades:

| Grade | Basis | Availability |
| --- | --- | --- |
| **THEN** | Market value at the trade date | Trades on or after 2025-09-01 |
| **NOW** | Market value of the resulting assets today, with resolved picks replaced by the player actually drafted | Any trade, when the value service responds |
| **SINCE TRADE** | Fantasy points the received assets scored *while in that manager's starting lineup*, from the trade forward | Any trade in the loaded matchup archive |
| **CHAIN** | The same, but credit follows each asset into whatever it was later flipped for | With "Follow the chain" enabled |

SINCE TRADE needs no market snapshot, so it grades the full history of the
league including trades that predate the value service. Ownership is read from
the weekly matchup snapshot, so a player who gets flipped again later stops
accruing to the original acquirer. Each card also shows what percentage of the
deal has actually settled: a trade built on picks two years out is mostly
unresolved, and the grade says so.

A grade renders as `—` when the underlying data is missing. It is never
substituted with a middling letter.

### Following the chain

SINCE TRADE stops counting the moment an asset is traded again. The **Follow the
chain** toggle on the Trades view continues past that point: when an asset is
flipped, credit carries forward into whatever came back, recursively, so a trade
is judged on what it ultimately became rather than on the first thing it turned
into.

When an asset leaves as part of a package, the return is split across everything
that went out, weighted by value. Because historical market snapshots only exist
from 2025-09-01, current market value is used as the proxy for value at the time
of each flip, and an even split is used where no values exist. Both are
approximations and the chain view labels them as such.

Recursion is capped at 6 hops and at 3% residual credit, and revisited trades are
guarded against, so cycles (a player traded away and later reacquired) terminate.
Each stint is bounded by the flip that ended it, so a reacquired player is never
counted twice against the same acquisition.

Enabling the toggle loads every season's trade history plus the scoring archive,
so the first activation takes a few seconds.

## The competitive window

The Assistant reads each franchise on two axes rather than a single
contend/rebuild number, because "strong but old" and "strong but young" call for
opposite behaviour.

- **Win-now strength** — starting lineup market value, record and points for,
  as league percentiles. Roster strength carries the score early and results
  earn weight as the sample grows, reaching a 45% share after six games.
- **Asset timeline** — value-weighted roster age (inverted, so younger is more
  future-leaning) plus future draft capital, again as percentiles.

The two axes give four quadrants:

| | Appreciating assets | Aging assets |
| --- | --- | --- |
| **Winning** | Contender | Window closing |
| **Losing** | Rebuilding | Hard reset |

Each quadrant carries a directive (buy or spend picks, target youth or proven
production, which ages to sell) and every suggestion is filtered through it. A
rebuilding roster is no longer told to trade picks for a 30-year-old just
because the positional shapes happened to complement.

Partner matchmaking now scores how well two windows *oppose* each other.
Contenders and rebuilders want opposite things, which is what actually closes a
deal; two teams in the same position are competing for the same assets.

Percentiles are used throughout rather than ordinal ranks. In a 12-team league
the gap between #1 and #2 is often nothing, and treating it the same as the gap
between #6 and #7 made the old matchmaking noisy.

## Value over replacement

Local valuations no longer sum raw market value. Three players worth 2,000 each
are not one player worth 6,000, because only the starting lineup scores and
roster spots are finite.

**Replacement level** is derived from this league's own rosters: the value of
the best player at each position who would *not* be starting if every team
started its best lineup. Starting slots include flex, allocated by how the flex
is actually being filled across the league right now rather than split evenly,
so a superflex that everyone fills with a QB counts as a second QB slot.

**Surplus** is value minus replacement, floored at zero. Below-replacement depth
contributes nothing, which is what makes consolidation grade correctly.

**Roster crunch** charges for the players a lopsided-count trade would force out.
The post-trade roster is compared against the league's roster limit and the
lowest-surplus players over the limit are priced as a loss.

These feed three places:

- **Trade Lab** now shows four dials: market balance, surplus over replacement,
  best-lineup value change, and roster crunch. A deal that is even on market
  value and lopsided on surplus is exactly the deal worth arguing about.
- **Assistant positional rooms** are measured in surplus, so a team hoarding six
  replaceable RBs no longer outranks one with an elite starter.
- **Suggested frameworks** reward deals where *both* sides receive a player who
  clears replacement at the position they need. Total surplus is conserved in a
  straight swap, so "who gains surplus" is not a meaningful test; both sides
  getting a real starter is.

Market balance is still shown alongside, because market value is what the other
manager will actually accept. Surplus tells you whether the deal is useful;
market value tells you whether it is agreeable.

Picks are not discounted against a replacement level, since they occupy no
lineup slot today. That slightly favours the side receiving picks in surplus
terms, which is why surplus sits next to market balance rather than replacing it.

## Manager Lab

Every team-week in the archive carries both `players_points` and `starters`,
which means the app knows not only what each team scored but what it *could*
have scored. That gap is the most argued-about number in fantasy.

- **Lineup efficiency** — points scored as a share of the best legal lineup
  available that week, with the worst individual start/sit calls in league
  history called out by name.
- **All-play and luck** — every team scored against every other team, every
  week. Expected wins come from that record; luck is the gap between it and the
  real one. This separates "am I bad" from "did I draw the high scorer".
- **Coaching record** — every matchup replayed with both managers fielding
  optimal lineups. Games flagged as thrown were winnable and left on the bench.
- **Borrowed schedules** — replay a season against any other manager's schedule.

The lineup optimiser fills the most restrictive slots first, which is optimal
for the nested slot families fantasy leagues use, with a swap pass as a
safety net. Players whose position is missing from the Sleeper directory are
skipped, so very old seasons may under-report the optimal lineup slightly.

## Expert consensus (FantasyPros)

Market values and expert rankings answer different questions and neither
replaces the other:

- **Market value** is crowdsourced trade sentiment. It tells you what your
  leaguemate will actually accept, which is what matters in a negotiation.
- **Expert consensus (ECR)** tells you who is actually better.

The interesting part is where they disagree. The Assistant surfaces the largest
gaps as buy-low and sell-high signals, league-wide, on your roster, and among
unrostered players. Positive means experts rank a player better than the market
does. Thin positional pools and gaps under five spots are filtered out as noise.

The FantasyPros free public tier returns only the top 10 players per request and
ignores `limit`, but the cap is per request rather than per key. The proxy
therefore fans out across QB, RB, WR and TE and merges the results, giving the
top 10 at each position. The panel reports this coverage honestly instead of
implying a full board, and the arbitrage thresholds loosen to suit a shallow
pool. A paid tier requires no code change: the note disappears and the
thresholds tighten on their own.

Players are matched between the two services by normalised name plus position,
since the services use different ID spaces. Ambiguous names are left unmatched
rather than guessed at, and the panel reports how many did not match.

### The proxy

The FantasyPros API requires an `x-api-key` header. This is a static site, so
anything in `app.js` is readable by anyone who opens devtools. The key therefore
lives in a proxy:

- `worker/fantasypros-proxy.js` — Cloudflare Worker, pairs with GitHub Pages.
- `api/fantasypros.js` — Vercel/Netlify serverless equivalent.

Both validate and allowlist every forwarded parameter, restrict origins, and
cache upstream responses for six hours so a twelve-person league is one upstream
call rather than twelve. Set `CONFIG.proxyBase` in `app.js` to the deployed URL.
Leaving it empty disables the ECR features cleanly.

**The API key never belongs in this repository.** See `.env.example`.

## Known limits

- Market values come from [Stats Guy Fantasy](https://statsguyfantasy.com) and
  their historical snapshots begin 2025-09-01. Visible source credit is shown in
  the UI as their public API terms require.
- THEN/NOW grades are zero-sum: one side's surplus is the other's deficit. Real
  dynasty trades can benefit both sides, and a future revision should grade each
  side against expectation instead of against each other.
- Chain following depends on Sleeper populating the `drops` map on trade
  transactions. Where it is absent the chain simply finds no flip and the grade
  falls back to the direct SINCE TRADE behaviour.
- Chain attribution uses present-day values to split historical packages, which
  will misweight deals whose participants have since moved a long way in value.
- Trade award cards (best/worst outcome, best gamble) still rank on market
  grades rather than chain grades.
- Trade Lab sums asset values linearly, so it under-rates consolidation. Value
  over replacement and a roster-spot cost are not yet modeled.
- Surplus treats every position's replacement level as league-wide. A team
  that is already three deep at a position gets no extra discount for a fourth.
- Trade frameworks are still one-for-one plus a balancing pick. Multi-asset
  consolidations and splits are not searched yet.
- Player ages come from the Sleeper directory and are absent for some historical
  and practice-squad players; those fall back to a league-average age.
- W-L displays intentionally exclude Sleeper tie counters.
- Browser-level live API execution is a deployment smoke test, not an automated
  one. The managed browser policy in the build environment blocks headless
  Chromium.

## Data sources

- **Sleeper public API** — league, users, rosters, history, matchups, brackets,
  transactions, drafts, traded picks, player directory.
- **Stats Guy Fantasy API** — dynasty player values, rookie pick values,
  historical trade-value snapshots.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup and view shells |
| `app.js` | Application module: data loading, state, rendering |
| `analytics.js` | Pure scoring/grading math, imported by both app and tests |
| `efficiency.js` | Lineup optimiser, all-play, luck, coaching record |
| `fantasypros.js` | ECR name matching and market-vs-expert arbitrage |
| `worker/`, `api/` | Proxy that holds the FantasyPros key |
| `styles.css` | All styling |
| `tests/` | `node --test` regression suite for `analytics.js` |

See `CHANGELOG.md` for version history.
