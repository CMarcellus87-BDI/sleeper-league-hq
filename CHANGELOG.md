# Changelog

## v8.8.0 — Manager Lab and expert consensus

### Added
- **Manager Lab**, a new view built entirely on data already being downloaded:
  - Lineup efficiency: points scored as a share of the best legal lineup
    available, per manager, per season or across league history.
  - Worst start/sit calls ever made, naming the benched scorer and the starter
    who should have made way.
  - All-play records and a luck index: expected wins from all-play versus the
    real record.
  - Coaching record: every matchup replayed with optimal lineups, with
    self-inflicted losses counted.
  - Borrowed schedules: replay a season against any other manager's schedule.
- **FantasyPros expert consensus rankings**, presented as arbitrage against
  crowd market value rather than as a replacement for it. Buy-low and sell-high
  signals league-wide, on the selected roster, and among unrostered players.
  ECR badges appear on Trade Lab assets.
- **Proxy for the FantasyPros key**: Cloudflare Worker plus a Vercel/Netlify
  equivalent, both parameter-allowlisted, origin-restricted and edge-cached.
- `efficiency.js` and `fantasypros.js`, both pure, with 30 new tests. Suite is
  now 71 tests across three modules.
- `.gitignore`, `.env.example`, `wrangler.toml` and a GitHub Actions workflow
  that runs the test suite on every push.

### Notes
- The lineup optimiser fills the most restrictive slots first, optimal for the
  nested slot families fantasy leagues use, with a swap pass as a safety net.
- Cross-service player matching normalises names (case, punctuation,
  generational suffixes, defense spellings) and refuses to guess on ambiguous
  names rather than risk a wrong match.

## v8.7.0 — value over replacement

### Added
- **Empirical replacement levels** per position, derived from this league's own
  rosters rather than an external baseline. Flex slots are allocated by observed
  usage across the league, so a superflex everyone fills with a QB counts as a
  second QB slot rather than a quarter each of four positions.
- **Surplus over replacement** as the basis for local valuation, floored at zero
  so below-replacement depth contributes nothing. This is what makes a 3-for-1
  consolidation grade correctly instead of losing on raw sums.
- **Roster crunch cost.** A lopsided-count trade forces drops; the post-trade
  roster is compared against the league limit and the lowest-surplus players
  over the line are priced as a loss.
- **Four dials in Trade Lab**: market balance, surplus over replacement, best
  lineup value change, and roster crunch, with the forced drops named.
- Suggested frameworks reward deals where both sides receive a player clearing
  replacement at the position they need.
- `starterSlotCounts`, `replacementLevels`, `surplusValue` and
  `rosterCrunchCost` in `analytics.js`, with 10 new tests including an
  end-to-end case proving a 3-for-1 that looks even on market value is not.
  Suite is now 41 tests.

### Fixed
- **The Trade Lab verdict was inverted.** `edge` was computed as (what A sends
  minus what A receives) but credited to A, so the headline named the side
  giving up more value as the winner. The per-side context panel had the sign
  right, so the two halves of the same screen disagreed.
- **Starting slots misaligned in leagues that start a kicker or defense.**
  Unknown slot types were dropped from the slot list while Sleeper's `starters`
  array still contained them, so flex detection read the wrong index. Slots are
  now built as a spec that preserves position for every non-bench slot.

### Changed
- Assistant positional room strength is measured in surplus rather than total
  room value. Summing raw value rewarded hoarding: six startable-but-replaceable
  backs used to outrank one elite one.
- `balanceTradePackage` reports surplus alongside market value. Market value
  still decides whether a deal is acceptable to the other manager; surplus
  decides whether it is useful.

## v8.6.0 — competitive window engine

### Added
- **Two-axis competitive window per franchise.** Win-now strength (lineup value,
  record and points for) and asset timeline (value-weighted age plus future pick
  capital), both as league percentiles, classified into four quadrants:
  Contender, Window closing, Rebuilding, Hard reset.
- **Window card on the Assistant**, showing both axes, the supporting facts
  (lineup value, value-weighted age, pick value, record) and the directive that
  follows from the quadrant.
- **Window-aware suggestions.** Every trade framework is now scored on whether
  the target is something this roster should be buying, the offer something it
  should be moving on from, and the offer something the partner should want.
- **Window-aware partner matchmaking.** Match score now includes how strongly
  two franchises' windows oppose each other, so contenders surface rebuilders
  instead of near-twins.
- Free-agent upgrades break ties toward youth for rebuilding rosters.
- `percentileRank`, `valueWeightedAge`, `strengthScore`, `timelineScore`,
  `classifyWindow`, `windowDirective` and `windowComplement` in `analytics.js`,
  with 7 new tests including one that guards the composition order. Suite is now
  31 tests.

### Changed
- Percentiles replace ordinal ranks in the window math. In a 12-team league the
  gap between #1 and #2 is often nothing, and the old scoring treated it the
  same as the gap between #6 and #7.
- Record and points for carry no weight before games are played and reach a 45%
  share of the strength score after six games, so preseason reads as pure roster
  strength rather than noise.
- Roster assets now carry player age and experience through to the Assistant.

## v8.5.0 — chain-following trade grades

### Added
- **CHAIN grade and the "Follow the chain" toggle.** Credit now follows each
  received asset forward through every subsequent trade by the same manager, so
  a deal is graded on what it ultimately became rather than on the first thing
  it turned into. Package flips split credit across everything that went out,
  weighted by value, with an even split as the fallback where no values exist.
- **"Show the value chain" per side**, rendering the full lineage tree: what was
  held and for how many points, where it was flipped, what share of that return
  was attributed here, and what came back at each hop.
- `traceAssetForward` lives in `analytics.js` with all league lookups injected
  through a context object, so the recursion is testable without a DOM.
- `realizedForPlayerWindow` and `attributionShare` in `analytics.js`.
- Six more regression tests covering chain following, package attribution,
  cycle guarding and depth capping. Suite is now 24 tests.

### Notes on correctness
- Each stint is bounded by the flip that ended it. Without that bound a player
  traded away and later reacquired would be counted twice against the same
  acquisition.
- Recursion is capped at 6 hops and 3% residual credit, and a visited set guards
  revisited trades, so cycles terminate.
- A trade drop index is built once per trade load rather than scanned per hop.

## v8.4.0 — realized-points grading

### Added
- **SINCE TRADE grade.** Every trade in league history is now graded on the
  fantasy points its assets actually produced in the acquirer's starting lineup,
  using the weekly matchup archive. No market snapshot required, so trades
  predating 2025-09-01 finally get a legitimate outcome grade.
- Settled percentage on each realized grade, so deals resting on unresolved
  future picks are labelled as unresolved rather than graded confidently.
- `analytics.js`: pure grading and scoring math, importable in Node.
- `tests/analytics.test.mjs`: 12 regression tests run via `npm test`.
- `?league=<id>` URL parameter; the league ID is no longer hardcoded.
- Player age, experience and injury status captured from the Sleeper directory.

### Fixed
- **Unplayed weeks polluted the all-time records.** Sleeper returns scheduled
  but unscored weeks as all-zero rows. These entered the archive as 0.00-margin
  games, producing a phantom "Closest Finish" and counting as nail-biters in the
  rivalry index. Such weeks are now dropped at ingest.
- **Ungradeable trades rendered as a confident "B".** A missing valuation
  response fell through as 0 vs 0, which graded out as an even split. Missing
  data now renders as `—`.
- **The 24-hour player cache never worked.** The full Sleeper player directory
  is several megabytes and always exceeded the localStorage quota, with the
  error swallowed. Cards are now slimmed to the fields actually used, and cache
  write failures are logged and surfaced.
- `/players` was fetched twice per session, once by the name resolver and once
  by the market loader. `ensureMarketData` now owns that call.
- Draft-pick market IDs failing to match silently valued every future pick at
  zero. A mismatch now warns once with sample keys from the service.
- `pickOwnerFor` scanned the traded-pick list on every call with a meaningless
  tie-break. Replaced with a prebuilt index.
- The Assistant suggested cutting rookie stashes and last-man-standing players
  at scarce positions. Both are now protected.
- Free-agent upgrade thresholds were hardcoded point values that would not hold
  across scoring formats. They now scale with the roster's median bench value.
- Avatar URLs were interpolated into `src` without escaping.

### Changed
- `app.js` is now an ES module importing from `analytics.js`.
- Roster assets, player pools and positional snapshots are memoized. The
  Assistant previously rebuilt every roster's draft capital thousands of times
  per render; this was the dominant cost on mobile.
- Refresh no longer calls `location.reload()`. It drops volatile state and
  re-runs the current view, keeping the player directory cache.
- The Trades view loads the scoring archive in the background so market grades
  render first and realized grades fill in after.
- README rewritten as a README. Version history moved here.
- Removed dead state keys: `tradesLoaded`, `tradesPromise`, `trades`,
  `draftResolutionsLoaded`, `draftResolutionsPromise`.

### Not changed
- Grade letter bands. On review the existing ladder is already width-symmetric
  (A+/F, A/D, A-/C, B+/B- are mirror pairs); only the naming differs on the
  negative side. Changing it would break comparability with grades the league
  has already seen.

## v8.3.1 — regression QA
- Fixed stale v8.2 CSS/JS cache-busters in the v8.3 package.
- Verified no duplicate function declarations or duplicate/missing DOM IDs.

## v8.2 — Roster Assistant
- Simplified Trade Center grades to letter grades.
- Best/worst trade outcome cards jump directly to the trade.
- Added Roster Assistant with complementary trade-partner frameworks,
  free-agent upgrades, and protected cut-candidate suggestions.

## v7.5.0 — reliability patch
- Two-layer player name resolution: market metadata first, then the cached
  Sleeper directory for historical and retired players.
- Historical trade grading isolated per trade; failed batches are recursively
  split so one unpriceable deal cannot erase a season.

## v7.4 — reliability patch
- Removed the automatic full-history matchup crawl on startup.
- Added a bounded Sleeper request queue, de-duplication, retries and caching.
- Made Trade Relationships progressive instead of blocking on all seasons.

## v7.3
- Live matchup refresh every 60 seconds while the page is visible.
- Live week tracking; preseason remains pinned to Week 1.
- Head to Head gained a Trade Relationships mode.

## v7.1
- Trade Lab reports lineup, positional room, draft-capital and pick-count
  impact alongside raw market balance.

## v7.0
- Current roster and draft-capital module in Franchise Profiles.
- Live dynasty market values, Trade Lab, THEN/NOW historical grading,
  Hall of Fame / Hall of Shame cards, on-demand asset lineage.
