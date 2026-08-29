# Changelog

## v10.5.0 — league hero cards

My Leagues was a list. It is now a set of hero cards, each a real entry point
into that league rather than just a way to select it.

### Added
- **League crests.** `league.avatar` had been sitting unused since multi-league
  shipped; leagues now carry their own artwork, with an initial as fallback.
- **Format badges** on every card: size, superflex, scoring format, dynasty or
  keeper, IDP. What kind of league this is, at a glance.
- **Playoff position read.** "6th of 12" says nothing on its own. Cards now say
  "Last playoff spot", "First team out" or "Top seed", which is the reading that
  actually matters in October.
- **Live matchup state** as up or down by a margin, rather than two raw scores.
- **A luck read.** Scoring third but sitting ninth is worth saying out loud;
  a small gap between the two is not, and stays quiet.
- **Scoring rank next to record**, since the two disagreeing is the story.
- **Deep links per card** to that league's Home, Power Rankings, Assistant and
  Trades. Each switches league first, so a card is an entry point rather than a
  selector.
- Sixteen tests covering avatars, badges, playoff reads, matchup state and luck.
  Suite is now 227.

### Fixed
- **Standard scoring displayed as "STD"**, an API code leaking into the
  interface. It reads "Standard" now, in the card badges and the league header.
- Two dead imports in `app.js`, both found by the regression suite rather than
  by reading.

### Changed
- The regression suite understands `import { a as b }` aliasing, which it needed
  once `league.js` grew an `avatarUrl` that collides with the one already in
  `app.js`.

## v10.4.1 — removing leagues

### Fixed
- **The league you were viewing could not be removed**, which is the one you are
  most likely to want gone after opening it by mistake. Removing the open league
  now hands over to the next one in your list, or to the configured default if
  it was the last.
- **The header selector kept showing removed leagues** until a reload, because
  the list re-rendered without refreshing the dropdown.
- **Forgetting a league left its cached transactions in localStorage** under
  `dol:tx:{league_id}:*`. Those are now cleared with it.
- **A removed league could come back on reload** if it was the one stored as
  last opened. That pointer now moves to whatever remains.

### Added
- A confirmation naming the league before it is removed, and a "Forget all
  leagues" control for clearing a batch import.
- Wording in the view making clear that removal is local only: it clears the
  name, id and season stored on this device and nothing on Sleeper changes.
- Six tests covering removal, handover order and the dropdown refresh, including
  regression checks that no control is suppressed for the active league and that
  cached data is cleared. Suite is now 215.

## v10.4.0 — league switching and a regression suite

### Fixed
- **The live card printed a hardcoded league id.** It had been sitting in the
  markup since before multi-league and showed the same id no matter which league
  was open.
- **Header controls overlapped.** The league and refresh buttons were added
  inline into a card whose buttons carry `padding:0` and no layout, so they
  collided. They now sit in a spaced row under a proper league selector.
- `attributionShare` was still imported by `app.js` after the chain walker moved
  into `analytics.js` in v8.5. Harmless, but dead. Found by the new suite.

### Changed
- **Switching leagues now works from anywhere.** The header carries a league
  selector rather than a link to the leagues page, so changing league is one
  interaction from whatever view you are on.
- **Username lookup offers a choice instead of importing everything.** Most
  people are in leagues they have no interest in seeing here, so the leagues
  found are presented as a checklist with a select-all, and nothing is added
  until you confirm.

### Added
- **A whole-app regression suite** covering the seams the unit tests cannot see,
  which is where this app has actually broken. It asserts that every element the
  app looks up exists in the markup, every navigable view has a section, every
  section is reachable, `navigate()` has a branch per view, every import
  resolves to a real export and is used, cache-buster versions agree across the
  markup, the module imports and `package.json`, no merge conflict markers
  survive, no id is declared twice, and no Sleeper id is hardcoded. Suite is now
  209 across twelve files.

## v10.3.1 — per-season lineup configuration

### Fixed
- **Historical seasons were scored against the current lineup, not their own.**
  `roster_positions` describes the league as it is configured today. A league
  that started a kicker and defense in earlier years and later dropped them had
  those old weeks measured against today's shorter lineup, so the kicker and
  defense points counted in the actual but had no slot in the optimal. v10.3.0
  fixed leagues that still start K and DEF; this fixes leagues that used to.
  Each season now uses its own `roster_positions`.

### Added
- **Lineup configuration history.** When a league has changed its starting
  lineup, the Manager Lab lists which seasons used which configuration and notes
  that seasons with more slots are not directly comparable to seasons with
  fewer. That is a real limitation of the comparison, not a flaw to paper over.
- `slotSignature` and `summarizeSlotChanges`, pure, with 4 tests including a
  league that returns to an earlier configuration. Suite is now 194.

### Notes
- Career efficiency figures will move for anyone who played seasons with extra
  slots. Kicker and defense slots are easy to optimise, so those years were
  inflating the actual side of the ratio. The new numbers are lower and correct.

## v10.3.0 — full lineups

### Fixed
- **Lineup efficiency was wrong in any league with a kicker or defense.**
  Unmapped slots were dropped from the optimal lineup while their points still
  counted in the actual, so efficiency ran above 100%. A roster starting a QB
  for 22, a kicker for 11 and a defense for 14 scored 213% efficient. Every
  Manager Lab efficiency figure, the points-left column, the coaching record and
  the report card were affected in leagues with those slots.

### Added
- **Kicker, defense and IDP slot eligibility.** Analytics still cover only the
  four positions that carry dynasty value, but every slot a league actually
  starts is now filled by the lineup optimiser, which is what makes efficiency
  correct. IDP is mapped for the same reason, not because anything models it.
- **Superflex, WRRB and receiver flex** slot variants mapped explicitly rather
  than by pattern, including `WRRB_WRT` and `IDP_FLEX`.
- **An unmodeled-week flag.** If a league starts a slot type not in the map,
  efficiency is capped at 100% and the Manager Lab says how many weeks were
  affected, instead of silently reporting an impossible number.
- Three tests covering the kicker case, kicker/defense optimisation and a
  superflex second quarterback. Suite is now 190.

### Notes
- Superflex was already handled correctly throughout: slot eligibility,
  empirically derived QB replacement level, and the market value provider's
  format parameter. It now has explicit test coverage.

## v10.2.0 — scoring aware

Multi-league support meant leagues that are not PPR would start loading, and two
external sources were assuming PPR.

### Added
- **Scoring format detection**, read once from the league's own settings and
  shared by every source: full PPR, half PPR or standard. Shown in the league
  header alongside superflex, because "how is this scored" is the first thing
  worth confirming when you open a league that is not yours.
- **Half PPR derived for nflverse usage.** nflverse publishes standard and PPR
  points but not half. Half is exactly recoverable, since PPR is standard plus
  one point per reception, so it is computed rather than approximated. A
  half-PPR league was previously being served PPR numbers.
- **TE premium detection.** No external source publishes a TE-premium variant,
  so instead of being quietly slightly wrong, the Start/Sit panel now says which
  format the projections are in and how the league differs.
- `scoring.js`, pure, with 11 tests. Suite is now 187 across eleven modules.

### Notes
- Most of the app was already format-correct and stays untouched. Anything
  derived from Sleeper's `players_points` is scored by Sleeper in the league's
  own settings, so realized points, lineup efficiency, the trade archive and the
  whole historical record needed no adjustment. Only the external sources
  (FantasyPros rankings and projections, nflverse usage) had to be told.
- An unusual reception value such as 0.4 maps to the nearest published variant
  and is flagged as inexact rather than rejected.

## v10.1.0 — multi-league

The league was hardcoded at build time. It is now runtime state, which makes
the app work for any Sleeper league and for several at once.

### Added
- **My Leagues**, first item in the Now section: every league you have opened,
  with your record, rank, this week's matchup and — the actionable one — a
  warning when a lineup has unfilled slots. Leagues needing attention sort to
  the top.
- **Add a league** by pasting either the raw id or the URL from the Sleeper app,
  because the URL is what people actually copy.
- **Import every league on a Sleeper account** by username, in one step.
- **League switching** from the header, which resets all league-derived state
  and reloads without a page refresh.
- Recently opened leagues persist locally and can be individually forgotten.
- `league.js`, pure, with 16 tests. Suite is now 175 across ten modules.

### Changed
- `CONFIG.primaryLeagueId` is now only a fallback. The live league resolves from
  `?league=` first so links stay shareable, then the last league opened, then
  the configured default. Existing behaviour is unchanged for anyone who has
  only ever used one league.
- Switching leagues keeps the Sleeper player directory, market values and
  nflverse usage in memory, since all three are keyed to players rather than
  leagues and are expensive to refetch. Everything league-derived is cleared,
  including expert rankings and projections, because those depend on the
  league's scoring settings.

### Notes
- The cross-league dashboard is a deliberately light load: four requests per
  league and no archive crawl. Full history only loads for the league you open.

## v10.0.0 — navigable

Fourteen views had accumulated into a flat scrolling list where the best work
was the hardest to find. The Report Card lived in a tab inside Manager Lab, four
clicks from anywhere. Nothing about the analysis changed in this release; what
changed is whether anyone can find it.

### Added
- **Five top-level sections**, grouped by when you would open the app rather
  than by what kind of data they hold: **Now** (overview, power rankings,
  playoff odds, standings), **Team** (assistant, franchises), **Trades**
  (archive, trade lab), **History** (champions, head to head, records, season
  explorer) and **Lab** (efficiency, waivers, drafts, report card, players).
- **Sub-navigation** per section, which fits a phone without scrolling and
  makes every destination one tap from its group.
- **Deep links.** Every destination has a shareable hash — `#lab/lab:report`
  opens the report card directly. Back and forward work, and a link pasted into
  the league chat lands where it should.
- `routing.js`, pure, with 14 tests including a round-trip assertion that every
  destination survives being turned into a hash and parsed back. Suite is now
  159 across eight modules.

### Changed
- Manager Lab's internal tab bar is gone. Its four panels are real destinations
  in the Lab section instead of a second row of tabs inside one view.
- Navigation renders from the `NAV` structure rather than hand-written markup,
  so adding a view is a one-line change in one file.
- Selecting a Lab panel updates the URL without adding a history entry, so the
  back button leaves the section rather than stepping through tabs.
- The shell paints from the URL immediately on load, so a deep link shows the
  right view while its data is still arriving rather than after.

### Notes
- Old bare links like `#trades` still resolve, and an unrecognised hash falls
  back to the overview rather than leaving a blank screen. Both are tested.

## v9.2.0 — League Pulse

### Added
- **Power rankings** built on all-play record rather than standings, so schedule
  luck does not decide who looks strong. Weighted: all-play 40%, recent
  three-week form 25%, roster market value 25%, lineup efficiency 10%. Every
  component is shown alongside the score so the ranking can be argued with.
- **Week-over-week movement**, computed by re-running the same ranking with one
  fewer week rather than storing snapshots. Nothing to persist and no way for
  history to drift out of sync with the algorithm.
- **Manager engagement**, grouped as "worth a nudge", "quiet but fine" and
  "fully engaged", with the specific evidence listed under each name.
- `pulse.js`, pure, with 16 tests. Suite is now 145 across seven modules.

### Notes on the engagement feature
This one describes what the data shows, not what a manager intends, and it is
built to avoid accusing people wrongly:

- An **unfilled lineup slot** is unambiguous and flags on its own.
- **Making no moves is not evidence of anything.** A strong roster that never
  gets touched belongs to someone who is set, not someone who is gone. A quiet
  manager with good lineups is shown under "quiet but fine" and never flagged.
- Softer signals — zero-scoring starters, low recent efficiency, a long gap
  since the last transaction — must **accumulate** before anyone is surfaced.
- The reasons are always displayed with the conclusion, so a manager can point
  at the specific week and explain it.

### Changed
- The efficiency archive now records empty lineup slots and zero-scoring
  starters per team-week, which is what the engagement signals read.
- Power score renormalises around missing components, so a league with no market
  value data still ranks sensibly instead of everyone scoring zero on roster
  strength.

## v9.1.0 — opportunity data

### Added
- **nflverse weekly usage**, free and open, routed through the worker for
  caching and column filtering: snap share, target share, air yards share and
  WOPR. Player dossiers now show recent form against everything earlier, so a
  role change is visible instead of buried in a season average.
- **Role growing / role shrinking** in the Assistant. Usage leads production
  rather than following it, so a snap share climbing from 40% to 80% is a signal
  the market has not priced yet.
- **Sleeper trending adds and drops**, cross-referenced against this league.
  "Added in 40,000 leagues today" is only actionable if he is free here, and
  players already rostered are shown separately with their owner named, because
  knowing a leaguemate holds a riser matters too.
- `usage.js`, pure, with 13 tests covering CSV parsing, the NA marker, snap
  merging, trend windows and signal thresholds. Suite is now 129 across six
  modules.

### Changed
- `gsis_id` restored to the slimmed player card. It is the exact join key
  nflverse uses, and one field buys exact id matching instead of name matching.
- The worker serves nflverse datasets without requiring an API key, since it is
  open data, and caches them for twelve hours so a whole league costs one
  upstream fetch.

### Notes
- nflverse marks missing values `NA`. Read naively that becomes zero, which
  would report a player with unknown target share as having none. Parsed as null
  and excluded from averages instead.
- Snap counts are a separate nflverse release. If it has not published yet, the
  app degrades to target share alone rather than failing.
- Rising-usage thresholds require both a real change and a real current role: a
  jump from 5% to 15% of snaps is noise, 45% to 75% is a story.

## v9.0.0 — the full archive

### Added
- **Playoff odds.** The remaining schedule replayed 10,000 times, sampling each
  team's weekly score from its own distribution, resolving standings and a
  reseeded bracket every run. Reports playoff, bye and title odds plus projected
  wins and seed. Thin samples are shrunk toward the league average, because four
  games is not enough to know a team's true mean and an unshrunk estimate makes
  early-season odds wildly overconfident.
- **Waiver and FAAB returns.** Claims were arriving in the same transaction
  responses the trade archive already fetches and were being discarded. Now kept
  at no extra network cost and graded on points produced in the starting lineup
  per dollar spent, with the best pickups and biggest money burned in league
  history.
- **Draft retrospective.** Every resolved pick graded against what its round has
  actually returned in this league, so a fourth-round hit is credited properly
  against a first-round one. Biggest steals and reaches called out.
- **Manager report card.** Lineup efficiency, all-play rate, coaching, waiver
  return, draft value and luck, each normalised within the league and weighted.
  Luck counts only lightly because it is not a skill, and a manager missing a
  category scores neutral in it rather than being punished.
- **Player dossiers.** Search any player in the archive and see every manager
  who rostered them, what they produced for each, and every trade they appeared
  in.
- Manager Lab now has tabs: Efficiency & Luck, Waiver Returns, Draft
  Retrospective, Report Card.
- `simulation.js` and `insights.js`, both pure, with 33 new tests. Suite is now
  116 across five modules.

### Fixed
- **`normalizeScores` scored missing data as the worst possible value.**
  `Number(null)` is `0`, which is finite, so nulls survived the guard and a
  manager with no waiver claims graded bottom instead of neutral. Caught by a
  test written before the wiring.

### Changed
- **Local configuration no longer gets overwritten by upgrades.** `proxyBase`
  and the worker origin allowlist now live in `config.local.js` and
  `wrangler.toml`, both gitignored and both excluded from release archives.
  `setup.ps1` creates them from the shipped examples and never overwrites an
  existing file.

## v8.9.1 — corrected against the live FantasyPros schema

Written after inspecting real premium-tier responses rather than guessing.

### Fixed
- **Projections use a different schema from rankings.** The projections endpoint
  returns `name` / `position_id` / `team_id` where rankings return
  `player_name` / `player_position_id` / `player_team_id`. Both now normalise
  through one function.
- **Scoring was being taken from the wrong field.** The endpoint echoes back
  `scoring: "STD"` regardless of what was requested and carries all three
  variants side by side under `stats`. Reading `stats.points` gave Jahmyr Gibbs
  17.47 in a PPR league instead of his actual 21.40. The scoring variant is now
  selected by field (`points_ppr`, `points_half`, `points`) from the league's
  own scoring settings, and any player forced onto a fallback variant is
  counted and reported in the UI.
- **`public_api_limited` is true even on premium.** The flag alone would have
  triggered an unnecessary per-position fan-out on a full board. A response is
  now treated as capped only when it actually comes back short of the count it
  reports.
- Projections are fetched per position, since that endpoint is positional.

### Notes
- Five more tests, written against the real payload shape rather than a guessed
  one, including the PPR-versus-standard case above. Suite is now 88.

## v8.9.0 — projections and full rankings (MVP tier)

### Added
- **Full ranking boards.** The client now asks for the complete board and only
  falls back to per-position fan-out if the response comes back flagged as
  capped. On an uncapped tier the coverage note disappears and the arbitrage
  thresholds tighten automatically, with no configuration.
- **Weekly projections** through the proxy, which now routes to any allowlisted
  upstream endpoint rather than rankings alone.
- **Start / Sit panel** in the Assistant: your set lineup against the best
  projected one, naming the swaps and the points at stake, with injury flags.
  It reuses the same lineup optimiser the Manager Lab uses for historical
  efficiency, run forward instead of backward.
- Seven more tests covering projection field detection, projection matching and
  start/sit advice. Suite is now 83.

### Notes
- FantasyPros has used several field names for projected points across API
  versions. `extractProjectedPoints` tries the known candidates, reports which
  one it found, and fails loudly if none match rather than silently projecting
  every player at zero.
- Projections are kept deliberately separate from dynasty market value.
  Projections answer "who do I start this week"; market value answers "what will
  my leaguemate accept". Trade valuation, VOR and the competitive window still
  run on market value, and the Start/Sit panel is labelled as the one place a
  points projection is used.
- Rostered players with no projection count as zero and the panel says how many.

## v8.8.1 — FantasyPros free-tier fan-out

The free FantasyPros public tier caps every response at 10 players out of
several hundred ranked, and ignores any `limit` parameter. The cap turned out to
be per request rather than per key, so:

### Added
- **Position fan-out in the proxy.** `positions=QB,RB,WR,TE` issues one upstream
  request per position in parallel, merges and dedupes the results, and caches
  the merged payload at the edge. One browser request, four upstream, 40 ranked
  players instead of 10.
- **Coverage reporting.** The panel states plainly that it is comparing only the
  top of each positional board, with per-position counts, rather than implying
  the arbitrage list is exhaustive.
- **Thresholds that scale with board depth.** A five-spot rank gap means
  something across 142 ranked backs and nothing across ten, so a limited board
  uses a smaller minimum pool and delta.
- Five more tests covering coverage summarisation, partial upstream failures and
  shallow-pool arbitrage. Suite is now 76.

### Notes
- A partially failed fan-out still returns what succeeded, with the failing
  position recorded in `coverage` rather than dropping the whole response.
- Upgrading the FantasyPros key to a paid tier requires no code change; the
  coverage note disappears and thresholds tighten automatically.

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
