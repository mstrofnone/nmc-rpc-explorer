##### nmc-3.6.27
###### 2026-05-07

**Latest Blocks default: 12 unconditionally (was 12-or-5 depending on `BTCEXP_SLOW_DEVICE_MODE`).**

The homepage `Latest Blocks` tile is the most-visited surface on the explorer; a
12-row table is the same vertical footprint as 10 rows on most displays and the
cost is one extra `getBlockByHeight` + `getBlocksStatsByHeight` pair per hit
(both cached 15 min via the in-memory LRU). With the `ttlAutopurge` fix from
3.6.26 the cache hit rate is healthy enough that even slow nodes serve the
homepage in <100ms steady-state, so the slow-device fallback to 5 rows is no
longer justified. `BTCEXP_UI_HOME_PAGE_LATEST_BLOCKS_COUNT` still overrides.

---

##### nmc-3.6.26
###### 2026-05-07

**Code health pass: concurrency, retries, observability, cache eviction.**

* New `utils.pMap(items, fn, { concurrency })` helper. Bounded-parallel
  async map with stable input-order results. `getBlocksByHeight` now
  uses it (default concurrency 8, override via `BTCEXP_BLOCK_FETCH_CONCURRENCY`)
  so a cold ask for hundreds of blocks doesn't fan out to namecoind in
  one shot. `getOldestActiveNames` uses it too for the per-batch
  `name_show` drain (capped at 8 in flight).

* New `nameShowActive(name)` wrapper distinguishes namecoind error code
  -4 ("name expired" / "never existed") from transient RPC failures and
  retries the latter once with a 200ms backoff. Used by
  `getOldestActiveNames`. Background scanners no longer silently miscount
  a network blip as an expired name.

* New `decorateNameRow` / `decorateNameRows` helpers in `nameApi`.
  `routes/baseRouter.js` no longer redefines a `_decorate` closure
  inline; all four "browse names" sections (expiringSoon,
  recentlyExpired, recentFirstUpdates, oldestActiveNames) go through
  the same code path.

* Homepage `Recent Name Operations` tile is now backed by a 30-second
  background refresh (`refreshRecentNameOps` in `app.js`). The
  `/snippet/recent-name-ops` endpoint reads `global.recentNameOps` and
  hands it back — no more per-request `getRawTransactions` fan-out on
  the homepage. Slow-path live-fetch still available via `?nocache=1`.

* New `BackgroundTask` registry (`app/backgroundTasks.js`). All five
  Namecoin-side refreshers (namesSummary, recentFirstUpdates,
  oldestActiveNames, nameTxStats, recentNameOps) register with it.
  Adds runs / successes / failures / lastDuration / lastError /
  nextRunAt tracking per task.

* New `/api/health`, `/api/background-tasks`, `/api/metrics` endpoints.
  Health + metrics bypass the no-RPC error page so they keep working
  during a namecoind reindex / restart. Metrics is plain Prometheus
  text exposition with per-task `nmcexplorer_bgtask_*` gauges plus
  tip-height and mempool-size.

* Fixed the LRU cache eviction class. `lru-cache` v10 honours per-call
  `ttl` only lazily — stale entries sit in memory until someone reads
  the key or `max` LRU pushes them out. Added `ttlAutopurge: true` +
  `allowStale: false` to `cacheUtils.lruCache(size)` so stale entries
  are reaped eagerly. Once deployed this lets us drop
  `BTCEXP_NO_INMEMORY_RPC_CACHE=true` on the server and recover the
  in-memory RPC cache hit rate.

---

##### nmc-3.6.25
###### 2026-05-07

**Three homepage / `/names` polishes:**

* `/names` *Oldest Active Names* now scans the entire chain (genesis → tip)
  by default instead of a 1-year window. Walk is interleaved with the
  per-name `name_show` active-filter and **early-exits** as soon as
  `listCap` actives have been confirmed — since the scan is oldest-first
  the first `listCap` actives ARE the oldest ever registered. Block
  fetches now batch through `getBlocksByHeight` (default 64 blocks per
  batch) for parallel cache fills on the cold first run. New env knobs:
  `BTCEXP_NAMES_OLDEST_FROM_HEIGHT` (explicit start height),
  `BTCEXP_NAMES_OLDEST_BATCH_SIZE`. The legacy
  `BTCEXP_NAMES_OLDEST_LOOKBACK_BLOCKS` still works if you want the old
  windowed behaviour.

* Homepage *Recent Name Operations* tile now reports the **TOTAL**
  mempool-name-op count and the total node mempool size (`getmempoolinfo`),
  not just the truncated row count. Caption now reads e.g.
  *"42 name ops pending in mempool (showing 15) (of 1,238 total mempool
  txs), 87 confirmed in last 6 blocks (showing 15)"*. Display is still
  capped to keep the tile compact.

* Homepage *Latest Blocks* default block count bumped from 10 → 12.
  Slow-device-mode default unchanged at 5. Override with
  `BTCEXP_UI_HOME_PAGE_LATEST_BLOCKS_COUNT`.

---

##### nmc-3.6.24
###### 2026-05-06

**`/name/<n>` history table — lifecycle expansion: stitch in the cycle's `name_firstupdate` and `name_new` ops.**

The `name_history` RPC returns a name's `name_update`s but is missing
two critical ops at the start of every name's life: the
`name_firstupdate` (which is returned but mis-labeled — the RPC
doesn't include the `op` field at all, so the explorer was rendering
it as `name_update`) and the `name_new` (never returned, since it
pre-commits a salted hash of (rand + name) and isn't visible by name
lookup). The chain-walk reconstruction stops at the firstupdate too.

New API: `nameApi.expandNameLifecycle(name, history, { coreApi })`
takes a name plus its existing history array and stitches in:
  1. The `name_firstupdate` op (verified via `getrawtransaction` on
     the oldest known history row to read its actual
     `scriptPubKey.nameOp.op`, then walked back through the vin chain
     to the firstupdate when the oldest row is itself a
     `name_update`).
  2. The `name_new` pre-commit, found by following the firstupdate's
     vin chain one step back to the `name_new` op output.

Returns ops oldest-first with kind set to `name_new` /
`name_firstupdate` / `name_update`, plus `cycleStartedAtNew` /
`cycleStartedAtFirstupdate` / `ageBlocks` so the view can label the
registration cycle.

View changes (`views/name.pug`):
- New "Current registration cycle" info banner above the History
  table, surfacing the firstupdate height (linked to the block-height
  page), the `name_new` height, the gap in blocks, and a clear note
  that prior expired-then-re-registered cycles are NOT shown here —
  exactly because `name_history` and the chain-walk both stop at
  the start of the current cycle. A fresh `name_new + name_firstupdate`
  pair is the on-chain signature of either a brand-new registration
  or a re-registration after a prior cycle expired.
- Lifecycle-expansion badge added next to the existing source method
  badge (`name_history RPC` / `chain-walk reconstruction`).
- New `name_new` / `name_firstupdate` op badges (info-cyan and
  success-green respectively) with hover tooltips explaining each
  op's role in the protocol.
- `name_new` rows render `(pre-commit) hash: <salted-hash>` instead
  of the empty value cell (since `name_new` has no value, only a
  salted commitment hash).
- Graceful warning surfaced when the lifecycle walk fails (e.g.
  upstream node has `-txindex` disabled or relevant txs are pruned).

---

##### nmc-3.6.23
###### 2026-05-06

**`/names` — new "Oldest Active Names" section at the bottom of the page.**

Answers "which names registered longest ago are still active right
now?" — a question `name_scan` cannot answer alone, since `name_scan`
only returns each name's LAST update height, not its original
`name_firstupdate` height. Those two heights are unrelated for any
name that has ever been renewed; the only way to know a name's true
registration block is to look at its `name_firstupdate` op directly.

New API: `nameApi.getOldestActiveNames({ windowBlocks, listCap,
perBlockCap, coreApi })` walks the last `windowBlocks` blocks of the
chain (default ~52,560 = 1 year at 144 blocks/day), collects every
`name_firstupdate` op, and for each candidate calls `name_show` with
`allowExpired: false` to filter down to the still-active set. Results
sort ascending by registration height so the OLDEST surviving names
bubble to the top. Block fetches reuse the existing 15-min
`coreApi.blockCache`, so the steady-state cost after the first refresh
is just the new-tip blocks plus a `name_show` per candidate.

Background task: `refreshOldestActiveNames()` runs at boot and on a
60-min cadence (looser than the 30-min `refreshRecentFirstUpdates`
because of the per-candidate `name_show` cost). Same
`BTCEXP_DISABLE_NAMES_SUMMARY=true` kill switch as the other name
background tasks; tunable via `BTCEXP_NAMES_OLDEST_LOOKBACK_BLOCKS`
and `BTCEXP_NAMES_OLDEST_LIST_CAP`.

The new section renders below "New Names" and uses the same table
shape (Name, NS, Registered, Age, Expires-in, Value preview). Empty
and pending states are covered the same way as the other expiring/
recently-expired/new sections (placeholder copy + 60-min refresh
hint when the background walk is still in flight).

---

##### nmc-3.6.22
###### 2026-05-06

**`/name/<n>` history table — new Date column.**

The per-name history table on `/name/<n>` now shows a Date column
right after Height, using the same `+timestamp` mixin as every other
timestamp on the explorer (so it matches the user's timezone setting,
shrinks to time-only for "today" rows, and exposes the full UTC time
in the hover tooltip).

The chain-walk reconstruction path already populated `entry.blocktime`
from the raw tx, so it shows up for free there. The `name_history`
RPC path only returns `height`, so for those entries the route now
looks up the block header via `coreApi.getBlockHeaderByHeight`
(15-minute cached) and stamps `blocktime` onto each entry. Lookups
that fail stay silent and the cell renders an em-dash.

No new RPCs added; no new top-level config; no kill-switch needed.

---

##### nmc-3.6.21
###### 2026-05-05

**`/address/<addr>` no longer 500s on Namecoin addresses.**

Two independent bugs were ganged up on every Namecoin address page,
with the visible error depending on which encoding the address used.

*Bug 1 — `payout_addresses` indexed access on a config that lacks it.*
`global.miningPoolsConfigs` is the parsed JSON of every file under
`public/txt/mining-pools-configs/<COIN>/`. The Namecoin merge-mined
config (shipped in nmc-3.6.0) carries only `coinbase_tags` — pool
attribution rides on the BTC parent coinbase via the auxpow blob, so
we never built a Namecoin payout-address map. The address handler
then evaluated

    global.miningPoolsConfigs[i].payout_addresses[address]

which threw `TypeError: Cannot read properties of undefined (reading
'<addr>')` for every visit. `for...in` callers (in `app.js` boot and
`utils.js` miner-info lookup) silently no-op'd over the missing key,
so the bug only surfaced on the address handler's direct property
access.

Fix: guard `payout_addresses` with `&&` before indexing; pull the map
into a local `payouts` so future readers can see what's optional.

*Bug 2 — `tryParseAddress` mis-classified Namecoin base58 addresses.*
The old `b58prefix = /^[13].*$/` regex was Bitcoin-mainnet-specific.
It skipped Namecoin's `M` / `N` (P2PKH, version byte 0x34) and `6`
(P2SH, version byte 0x0d) addresses, which then fell through to
`bitcoinjs.address.fromBech32` — and the underlying bech32 library
explicitly throws `Mixed-case string` on any input that isn't strictly
all-lowercase or all-uppercase. So a search for `MyHsUFXoVgm3BPCP3GXjejQCDCnUc3JJ6a`
piled three errors onto the address page.

Fix: drop the chain-specific prefix regex — the version byte is
whatever the chain says it is, and `fromBase58Check` verifies the
checksum either way. Detect uniform case up front and only attempt
bech32/bech32m for uniform-case input; mixed-case goes straight to
base58. Bonus: bech32 (the modern segwit format) is now tried first
for uniform-case input, with base58 as the fallback.

Files touched:
  * `app/utils.js` — `tryParseAddress` rewritten as three guarded
    decoders selected by uniform-case detection.
  * `routes/baseRouter.js` — `payout_addresses` lookup guarded.

##### nmc-3.6.20
###### 2026-05-05

**Search for `d/<label>` (and any other `<namespace>/<label>` name) no
longer 404s behind Apache.**

`POST /search` with a Namecoin name redirected to
`/name/<encodeURIComponent(name)>`, which produced URLs like
`/name/d%2Ftestls`. Apache's default `AllowEncodedSlashes Off` rejects
any request whose path contains a percent-encoded slash with 404 before
Node ever sees it. The bug was invisible when hitting the explorer
directly on `:3002`, only reproducible through the `explore.testls.bit`
Apache vhost (and any other reverse-proxy deployment).

Fix: a new `utils.nameUrl(name)` helper splits the name on the FIRST
`/` (the namespace separator) and only percent-encodes the namespace
and label individually, leaving the path separator literal. The
`/name/(.+)` route regex captures multi-segment paths fine and
`decodeURIComponent` on the captured tail is a no-op for plain names.

Applied at the search redirect plus 14 in-template href builders
across views (homepage, transaction page, /names, /names/filter,
/mempool-name-ops, /utxo-set, name-op mixins, name detail page).
The homepage's client-side `renderNameOpRow` (JSON-driven recent
name-ops tile) ships a mirror copy of the helper so JSON hydration
produces the same reverse-proxy-safe URLs.

Files touched:
  * `app/utils.js` — `nameUrl(name)` helper + module export.
  * `routes/baseRouter.js` — `POST /search` Namecoin redirect.
  * `views/index.pug` — client-side `nameUrl` + `renderNameOpRow`.
  * `views/name.pug`, `views/names.pug`, `views/names-filter.pug`,
    `views/mempool-name-ops.pug`, `views/transaction.pug`,
    `views/snippets/utxo-set.pug`,
    `views/includes/name-op-mixins.pug`,
    `views/includes/shared-mixins.pug` — `href` builders.

##### nmc-3.6.19
###### 2026-05-05

**`/utxo-set` &ldquo;By namespace&rdquo;: same compact-with-disclosure
treatment as the `/names` page sections.**

A real Namecoin chain has 500+ ad-hoc namespace prefixes (most with
single-digit counts) sitting in the long tail of the `byNamespace`
breakdown. Rendering all 507 rows pushed every section below it
(including the by-namespace tooltip's own context) off-screen.

Fix: render only the top 10 namespaces by active count in the
landing view; wrap the remainder in a native HTML `<details>`
disclosure widget with a summary reading &ldquo;Show remaining
N (M namespaces total)&rdquo;. Same pattern as the `/names`
&ldquo;About to expire&rdquo; / &ldquo;Recently expired&rdquo;
sections shipped in nmc-3.6.18 — no JS, no AJAX, the hidden rows
ride along in the same payload.

Files touched:
  * `views/snippets/utxo-set.pug` — split the byNamespace `<tbody>`
    into a 10-row preview table plus a `<details>`-wrapped
    remainder table (same columns: NS / Active / Expired / Total /
    Description).

##### nmc-3.6.18
###### 2026-05-05

**`/names`: collapse all three sections to 10 rows by default with
a native disclosure widget for the rest.**

Follow-up to nmc-3.6.17. The page was loading clean but the
expiry tables (~500 capped entries each) plus the default 50-row
`name_scan` page made the landing view scroll forever. Compacted
so each section is one screen tall by default, with one click to
expand:

* **Browse** — default scan count drops from 50 to 10. Three
  quick-expand links (`Show 10 / 50 / 200`) below the table
  preserve the start cursor in the query string so users can
  widen the window without retyping.
* **About to expire** / **Recently expired** — first 10 rows
  render in a regular table; the remainder (up to the
  `expiringListCap`-of-500 cap) is wrapped in a native HTML
  `<details>` element with `<summary>` reading
  &ldquo;Show remaining N&rdquo;. No JS, no Bootstrap collapse;
  the disclosure widget is keyboard-accessible by default and
  the hidden rows ride along in the same HTML payload (no extra
  request to expand).

Files touched:
  * `views/names.pug` — split each expiry section into a preview
    table + `<details>`-wrapped remainder table; added Browse
    quick-expand links.
  * `routes/baseRouter.js` — default `/names?count=` from 50 to 10.

##### nmc-3.6.17
###### 2026-05-05

**`/names`: move expiry sections below "Browse", tighten window
to 2 weeks (2016 blocks).**

Follow-up to nmc-3.6.16. Two refinements based on usage:

* The expiry buckets are reference data, not the page entry point
  — the live `name_scan` paginator should be the first thing a
  visitor reaches. Moved both sections below "Browse".
* The 30-day window (4320 blocks) was overlong for an at-a-glance
  panel — 8.3k about-to-expire names is too many to scan. Tightened
  the default to 2 weeks (2016 blocks at 10 min/block) for both
  windows. Operators can still override via
  `BTCEXP_NAMES_EXPIRING_SOON_BLOCKS` /
  `BTCEXP_NAMES_RECENTLY_EXPIRED_BLOCKS`.

Files touched:
  * `views/names.pug` — expiry sections moved below the `name_scan`
    "Browse" block.
  * `app/api/nameApi.js` — default thresholds 4320 → 2016 for both
    `expiringSoonBlocks` and `recentlyExpiredBlocks`; doc comment
    updated.

##### nmc-3.6.16
###### 2026-05-05

**`/names`: surface "About to expire" and "Recently expired"
sections so operators can see, at a glance, which names lapse soon
and which just lapsed.**

Namecoin names live for 36,000 blocks (~250 days) after their last
`name_update` and lapse silently if no further update confirms.
Until now the only way to find names approaching that boundary was
to scan namespace-by-namespace via the chain or scrape
`name_scan` rows by hand. The `/names` page now ships two new
sections, both populated from the existing 30-min background
`name_scan` walk (`getNamesSummary`) at zero extra request-path
cost:

* **About to expire** — active names whose `expires_in` is between
  1 and `BTCEXP_NAMES_EXPIRING_SOON_BLOCKS` blocks (default 2016
  ≈ 2 weeks at 10 min/block). Closest-to-expiring first.
* **Recently expired** — expired names whose `expires_in` is
  between `-BTCEXP_NAMES_RECENTLY_EXPIRED_BLOCKS` and 0
  (default 2016 ≈ 2 weeks). Most-recently-expired first.

Both lists are capped at 500 entries to bound memory; `Total`
counts in the section header reflect the true number of matching
names before the cap. Each row links to `/name/<name>` and to the
last `name_update` block.

Both sections render below the existing "Browse" `name_scan`
UI — the live `name_scan` paginator stays the entry point for the
page; the expiry buckets are reference data underneath. If the background
scan is still pending on first boot, a placeholder message points
at the 30-min refresh interval. If the chain has zero names in
either bucket, both sections are suppressed (no empty tables).

Files touched:
  * `app/api/nameApi.js` — `getNamesSummary` now accepts
    `expiringSoonBlocks`, `recentlyExpiredBlocks`, `expiringListCap`
    options and returns `expiringSoon[]`, `recentlyExpired[]`,
    `expiringSoonTotal`, `recentlyExpiredTotal`,
    `expiringSoonBlocks`, `recentlyExpiredBlocks` fields. Both
    lists are sorted + capped after the scan finishes; populated
    inline during the existing `name_scan` walk so no extra RPC.
  * `app.js` — `refreshNamesSummary` honours
    `BTCEXP_NAMES_EXPIRING_SOON_BLOCKS` and
    `BTCEXP_NAMES_RECENTLY_EXPIRED_BLOCKS` env-var overrides; debug
    log line now includes the two new totals.
  * `views/names.pug` — two new `+contentSection` blocks render the
    lists when present, with a pending-scan placeholder when the
    background walk hasn't completed yet. Both tables share the
    same 4-column shape (Name / Namespace / Height / Expires-in)
    and reuse the existing `bg-warning` / `bg-danger` badges.

No schema migration; no new RPC. Background scan stays at one
`name_scan` walk every 30 min.

##### nmc-3.6.15
###### 2026-05-04

**Browser tab favicon: serve the Namecoin-branded icon at the root
paths browsers auto-probe (`/favicon.ico`, `/apple-touch-icon.png`,
`/apple-touch-icon-precomposed.png`) instead of leaving a stale
upstream Bitcoin icon there.**

The HTML head emitted by `views/layout.pug` references the branded
favicons under `./img/network-mainnet/...` and that's what most
browsers honour first. But all browsers ALSO probe the root paths
(`/favicon.ico`, `/apple-touch-icon.png`,
`/apple-touch-icon-precomposed.png`) without a `?v=` query, and
the explorer's `public/favicon.ico` was still the upstream
Bitcoin-orange icon (15086 bytes, MD5 a2fb267...) inherited from
btc-rpc-explorer. Two side effects:

* Some browsers (and platform shortcut/recents UIs) latched onto
  the orange Bitcoin icon for the explorer tab, while the
  TLSA-pinned `https://explore.testls.bit/` origin happened to
  pick up the Namecoin-blue one from the `<link rel="icon">`
  tags. Net result: same explorer, two different favicons
  depending on the URL.
* `/apple-touch-icon.png` and `/apple-touch-icon-precomposed.png`
  were 404ing constantly in the access log every time iOS Safari
  hit the explorer.

Fix: replace `public/favicon.ico` with the Namecoin-branded
`public/img/network-mainnet/favicon.ico` (4265 bytes, blue "N",
MD5 2ec8b40...), and stage matching
`public/apple-touch-icon{,-precomposed}.png` copies of the
branded `public/img/network-mainnet/apple-touch-icon.png` so
the root-path probes both succeed and brand correctly.

Note: browsers cache favicons aggressively per origin and the
root-path probes don't carry the cache-busting `?v=` query, so
existing visitors may see the stale icon until their browser's
internal favicon cache expires (or they hard-refresh).

##### nmc-3.6.14
###### 2026-05-03

**Fix `/block-height/N` + `/block/HASH` rendering as a blank "Block:
Error" page on Namecoin, and stop rounding the `Volume` column to an
integer.**

Root cause of the block-page failure: `rpcApi.getBlockByHash` calls
`getblock <hash> 2` on Namecoin so it can pull the auxpow blob along
with the block (NMC is merge-mined; the pool tag lives inside
`auxpow.tx.vin[0].coinbase`, which only verbosity 2 returns).
Verbosity 2 also returns `block.tx` as an array of fully-decoded
transaction OBJECTS rather than plain txid strings. Two call sites
in the codebase iterated `block.tx[i]` as if it were a string and
passed the raw object through to `getRawTransaction` /
`getRawTransactions`, which serialised it into the JSON-RPC params
as `[object Object]`, the node returned `null`, and the rejection
bubbled up as a falsy `null` reason that `awaitPromises` silently
swallowed. The route handler then dereferenced an undefined
`getblock.hash` and crashed.

`app/api/coreApi.js#getBlockByHashWithTransactions` — normalise
`block.tx[i]` to a txid string (`typeof entry === "string" ? entry
: entry.txid`) before pushing into the `txids` array.

`routes/baseRouter.js#/snippet/recent-name-ops` — same fix; this is
why the explorer log had a `recentNameOps01: undefined ... TypeError:
Cannot read properties of undefined (reading 'message')` pair every
time the homepage was hit (issue noted as outstanding in
explorer3.txt).

`routes/baseRouter.js` — both `/block-height/:blockHeight` and
`/block/:blockHash` now also defensively guard
`res.locals.result.getblock.hash` so a future inner-RPC failure
renders the "Failed loading block" warning surface (which `block.pug`
already supports) instead of crashing to a blank error page. The
hardcoded `Bitcoin Block` meta-title strings are now
`${coinConfig.name} Block`, matching the rest of the coin-aware
branding.

`app/api/rpcApi.js#getRawTransaction` — reject with a real `Error`
describing the txid + blockhash, instead of the raw `null` / RPC
error payload. The previous `Promise.reject(result)` with `result
== null` produced a falsy reason that…

`app/utils.js#awaitPromises` — … the diagnostic helper was
silently dropping (its `if (x.reason)` filter skipped falsy
rejections). Now it logs every rejection, substituting a
placeholder `Error("rejection with no reason")` when the reason is
falsy. Without this we couldn't see *which* inner promise had
failed; the bug had been rendering as a blank `Block: Error` page
for weeks with no log signal.

`views/includes/blocks-list.pug` — the `Volume` column on `/blocks`
was rounding the block volume down with `parseInt()` before passing
it to `valueDisplay`. On Bitcoin that loses less than 1 BTC out of
hundreds (invisible). On post-halving Namecoin, where most blocks
contain only the 6.25 NMC coinbase, every such block rendered as a
flat `6 NMC` and a 3-tx block at 31.2556 NMC rendered as `31 NMC`,
wiping the fee tail. Now the full-precision `Decimal` is passed
through; `formatCurrencyAmount` handles the trailing digits via
`parts.lessSignificantDigits`.

##### nmc-3.6.13
###### 2026-05-03

**Rebrand source-code link to the Namecoin fork; add masonry packing on /rpc-browser.**

Homepage hero buttons: "View Source" now points at
`https://github.com/namecoin/nmc-rpc-explorer` (this fork). A new
"View Upstream Source" button sits next to it, linking the upstream
`janoside/btc-rpc-explorer` repo. The Namecoin fork is now the
first-class source link from the homepage; the upstream is still
one click away.

`/rpc-browser` (no method selected) used a Bootstrap row of three
fixed columns, which made every logical row as tall as the tallest
card in it. With Wallet (68 methods) sitting next to Signer (1
method), most of the page was whitespace. Switched the section list
to a CSS multicolumn (`column-count: 1/2/3` with `break-inside:
avoid` on each section card) so cards flow into the shortest column
like a masonry grid. Each card's width and internal size are
unchanged — only the empty space between rows collapses. Total page
height on `/rpc-browser` index drops by roughly the difference
between the largest and smallest sections.

##### nmc-3.6.12
###### 2026-05-02

**Move the Squatter leaderboards above the By namespace section.**

Follow-up to nmc-3.6.11. Reorder the names breakdown area so the most
attention-grabbing signal — "who is squatting how many names right
now" — is the first thing the reader sees, with the per-namespace
totals as supporting detail directly below. Updated the all-time
squatter tooltip text from "By namespace section above" to "By
namespace section below" to match the new ordering.

##### nmc-3.6.11
###### 2026-05-02

**`/utxo-set` Biggest Current Squatter + Biggest All-time Squatter sections.**

Namecoin's open registration model means bulk squatters — typo-squat farms,
parking services, drainer farms, IPFS-gateway sinkholes, mass-mirrored
content operators — stand out clearly: they almost always reuse one
template `value` across thousands of registrations. Until now, that
pattern was invisible on the explorer.

The `/utxo-set` page now renders two new leaderboard sections directly
below the existing **By namespace** table:

- **Biggest current squatter** — top-N clusters of *currently active*
  names whose `value` is byte-for-byte identical, ranked by active count.
  This is the live picture of who's currently squatting how many names.
- **Biggest all-time squatter** — same per-value clustering, but ranked
  by total cluster size (active + expired). The all-time scope mirrors
  the Active+Expired+Total columns of the **By namespace** section above
  it, so it surfaces lapsed-but-still-indexed squatter farms that the
  current view doesn't see.

Each row shows the rank, a preview of the shared value (with the full
value revealed on hover for >80-byte values), the cluster's value byte
length, the namespaces it spans (top-4 + overflow), the active/expired/
total counts, and up to 5 sample names linking to their `/name/<name>`
page. Clusters with fewer than 2 matching names are excluded — a single
"cluster" of 1 is just a regular name, not a squatter pattern. Empty
values (newly-issued `name_new` placeholders that haven't received a
`name_firstupdate` yet) are skipped so they don't lump into a phantom
giant cluster.

Clustering is added to the same 30-min background `name_scan` walk that
already powers **By namespace**, **Value-shape filters**, and **DNS
record filters**, so the new sections cost zero additional RPC. Per-value
buckets accumulate in memory during the scan and are ranked at the end
— only the top-N clusters per leaderboard survive into the cached
summary. Hover the (?) icon next to either section header for a tooltip
explaining how the leaderboard is calculated.

The **By namespace** section header also gets a (?) tooltip now, so all
three leaderboard groupings (namespace / current squatter / all-time
squatter) are self-documenting on the page.

##### nmc-3.6.10
###### 2026-05-02

**Stop `/utxo-set` from showing hours-old data on slow-device-mode nodes.**

The `/utxo-set` page was rendering `Last Updated 00:17 UTC (1h56m ago)` (or worse) on production because of a two-layer caching bug:

1. `getUtxoSetSummary(useCache=true)` was returning the on-disk file cache (`cache/utxo-set.json`) without checking its age. So even when the file was hours stale, every render of `/utxo-set` happily returned the same old snapshot.
2. `refreshUtxoSetSummary()` (the 30-min background task that should have been overwriting that file cache) was being skipped on every tick when `BTCEXP_SLOW_DEVICE_MODE=true` AND the node didn't have `coinstatsindex` enabled. So the cache file was written ONCE at first boot and never updated.

The combined effect: the page silently shows whatever was true at the explorer's last boot, possibly hours or days ago, with no indication it's stale.

**Fix:**

- `getUtxoSetSummary()` now checks `cacheAgeMs < UTXO_FILE_CACHE_MAX_AGE_MS` (30 min) before returning the on-disk file cache. Older caches are treated as stale and force a fresh `gettxoutsetinfo` RPC call. Caches without a `lastUpdated` field (legacy) are also treated as stale.
- `refreshUtxoSetSummary()` no longer aborts under slow-device-mode. The slow `gettxoutsetinfo` call (~88s on a Namecoin node without coinstatsindex) runs on the dedicated **no-timeout RPC client** off the request path, on a 30-min interval, so it never blocks an interactive page load. The original early-return only made sense when the explorer had no other way to surface the data; with the file cache also stale-checked, the right behaviour is always-refresh-in-background.
- Wrapped the refresh in try/catch/finally so a transient RPC failure doesn't leave `utxoSetSummaryPending=true` stuck.

Operators who genuinely want zero `gettxoutsetinfo` load can still flip a future `BTCEXP_DISABLE_UTXO_SET_REFRESH` env (TODO if anyone asks) — but for the common case of "slow node that should still show fresh data once every 30 min", this is a no-config-change improvement.

##### nmc-3.6.9
###### 2026-05-02

**DNS record filters on `/utxo-set`** — expand the existing filter block with per-record-type tiles for every common DNS resource record published via ifa-0001 §map fields. Counts are click-through to the cached match list at `/names/filter/:filter`.

The `/utxo-set` filter section now splits in two:

*Value-shape filters* (existing) — Valid JSON, .onion, TLSA, IP addresses (combined v4+v6), Nostr, I2P.

*DNS record filters* (new) — ten tiles, one per RR type:

* **A** (IPv4) — `ip` field per ifa-0001, or any literal IPv4 in the value.
* **AAAA** (IPv6) — `ip6` field, or any literal IPv6 in the value.
* **CNAME** — `alias` / `translate` field redirecting to another name.
* **NS** — `ns` field delegating resolution authority to one or more nameservers.
* **MX** — `email` shorthand or `mx` array specifying mail exchange servers.
* **TXT** — `txt` field carrying arbitrary text data (SPF, DKIM, verification, ad-hoc metadata).
* **SRV** — `service` field locating host:port for named services (e.g. `_xmpp._tcp`).
* **SOA** — `soa` field declaring DNS zone authority.
* **DS** — Delegation signer (DNSSEC). The `ds` field anchors DNSSEC validation for a child zone.
* **DNSSEC** — cryptographic-validation marker. Names carrying any of `dnssec`, `rrsig`, `dnskey`, `nsec`, `nsec3`, or `ds`.

Under the hood:

* `nameApi.classifyNameValue()` extended with ten new tag detections; each runs in the same single-pass classifier loop as the existing six (no extra RPC, no re-walk of the JSON tree).
* `FILTER_KEYS`, `FILTER_LABELS`, `FILTER_DESCRIPTIONS` extended; `getNamesSummary()` now derives `filterCounts` / `filterLists` slot keys from `FILTER_KEYS` so future filters drop in without touching the scanner.
* The `/names/filter/:filter` route was already filter-key-agnostic (reads `nameApi.FILTER_KEYS` at request time), so the new tiles work end-to-end on the cached background scan with zero added RPC load.
* `views/snippets/utxo-set.pug` refactored to use a shared `+filterTile` mixin so the value-shape and DNS-record sections share rendering. Each tile carries an HTML tooltip describing the underlying ifa-0001 field convention.

##### nmc-3.6.8
###### 2026-05-02

**Filter block on `/utxo-set`** — above the by-namespace breakdown, surfaces a count of *active* names whose value carries each of six common shapes, with click-through to the matching list:

* **Valid JSON** — names whose value parses as JSON (the convention for any structured Namecoin record).
* **.onion** — names that publish a Tor v2/v3 onion address (NameID `tor`/`_tor` field, or any v3 .onion hostname embedded anywhere in the value).
* **TLS** — names that publish TLSA records (ifa-0001 §tls).
* **IP addresses** — names with `ip` / `ip4` / `ip6` fields, or any literal IPv4/IPv6 address embedded in the value.
* **Nostr** — names that publish a Nostr identity (single-pubkey `nostr.pubkey` or multi-identity `nostr.names` map).
* **I2P** — names with an `i2p` field or a `.b32.i2p` host embedded.

Clicking any tile lands on `/names/filter/:filter`, which renders the cached list of matching names as a 3-column grid of monospace name links. The list is capped at 5,000 entries per filter so a chain with millions of matches can't blow up memory; a banner surfaces the truncation when present.

Under the hood:

* New `nameApi.classifyNameValue(parsed, rawValue)` returns the set of shape labels for one name's value. Backed by a depth-bounded `_collectStrings()` walker (haystack → single regex sweep) and a `_hasKeyDeep()` checker so the same helper handles `tor`/`_tor`/`tls`/`tlsa`/`ip`/`ip4`/`ip6`/`nostr`/`i2p` without re-implementation.
* The existing 30-min `getNamesSummary()` walk now invokes the classifier on every active name and accumulates `filterCounts` + `filterLists` (capped) into `global.namesSummary`.
* The classifier runs only on active (unexpired) names — expired names are still in the index but have no operational meaning, so we don't pay the parse cost for them.
* New `/names/filter/:filter` route + `views/names-filter.pug` view render the matched list with cross-links to the other filters.

##### nmc-3.6.7
###### 2026-05-02

Two small touch-ups.

* **`/utxo-set` info-block: BTC → NMC** — the static "About the UTXO Set..." copy at the top of `views/utxo-set.pug` was upstream Bitcoin verbatim, so it talked about "a spendable unit of BTC", "all spendable BTC units", "every BTC node", and the example diagrams labelled the UTXOs as `1 BTC`, `0.25 BTC`, `0.75 BTC`. Renamed all eight occurrences to NMC. The dynamic numbers below (which already came through the coin-aware `coinConfig.baseCurrencyUnit` plumbing) were already correct — this just brings the static prose in sync with the rebranded chrome.

* **`/rpc-browser` index layout: 1 column → 3 columns** — when no method is selected, the page now puts the "About RPC Browser..." alert at the top (full-width, under the title) and lays the RPC method sections out in a responsive 3-column grid (`row-cols-1 row-cols-md-2 row-cols-lg-3`) below it, instead of stacking every section list in the narrow `col-md-3` sidebar next to a tiny info alert. Favorites and Recent (when present) sit between the alert and the grid. The two-column layout (main panel + right sidebar) is preserved when a method IS selected, since that's still the right shape for the per-method view.

##### nmc-3.6.6
###### 2026-05-02

Three small follow-ups to nmc-3.6.5.

* **Per-metric `(?)` infographics on `/tx-stats` Names + Currency cells** — every cell in the new Names and Currency sections now carries its own dotted-underlined `(?)` badge that, on hover, surfaces a min/pt-style HTML tooltip explaining what the metric is, how it is calculated (specific RPC + arithmetic), and how to read the number. The 'Active names', 'NMC locked in names', 'Name txs / 24h', 'Name op rate', 'Name ops by kind', 'Top namespaces', 'Currency NMC supply', 'Currency txs / 24h', 'Currency tx rate', and 'Total txs / 24h' cells all gain one. Replaces the section-level `+nameTxInfoBadge`/`+currencyTxInfoBadge` ad-hoc tooltips that explained the section as a whole but not the individual numbers.

* **Fix the `(truncated — hit per-prefix scan cap)` warning on `/utxo-set`** — turned out to be exposing TWO separate bugs in `getNamesSummary()`'s pagination: (1) Namecoin Core's `name_scan` cursor is INCLUSIVE — passing `start="d/foo"` returns `"d/foo"` as the first row, so every page after the first was double-counting one name; (2) when a page ended on a hex-encoded row (where `row.name` is undefined because only `name_encoding` is set), `last = rows[rows.length - 1].name` set the cursor to `undefined`, which `name_scan` interpreted as `""`, and the scan looped back to the START of the keyspace. The two combined turned a 787,747-name database into a phantom 9.96M with `truncated=true`. Three fixes: (a) drop `row[0]` of every page after the first, (b) walk backwards from the end of each page to find the last row whose `name` is a string, then break out if the cursor fails to advance or matches the previous one, (c) only flip `truncated` when the LAST page we saw was full (real cap-hit, not a partial-page rollover). Adds `pagesScanned` to the summary for diagnostics.
  Result: scan time drops from 110–220s to ~17s. Reported names go from inflated 9.96M back to honest 787,747 (active 373,078, expired 414,669, top namespaces `d/`, `u/`, `id/`, `nft/`, `i/`, `fp/`).

* **Enable RPC Terminal and RPC Browser on the public demo** — the routes have always been live; they just guard against unauthenticated access unless `BTCEXP_DEMO=true` (or `BTCEXP_BASIC_AUTH_PASSWORD` is set). The 23.158.233.10:3002 `.env` had `BTCEXP_DEMO=false`. Switched to `true` and patched `views/layout.pug` so it doesn't crash when the active coin module's `demoSiteUrlsByNetwork` is empty (which is the Namecoin module's case): the demo-sites navbar dropdown and the footer 'Public Demos' block now both gate on the URL map being populated, and the inner per-network row also skips entries whose `logoUrl`/`coinIcon`/`demoSiteUrl` is missing. Without these guards, `BTCEXP_DEMO=true` plus a non-Bitcoin coin module crashes every page render on `assetUrl(undefined).substring`. The `BTCEXP_DEMO=true` flag also enables the existing tx-list pagination caps that demo mode applies (a small DoS-protection win for a public read-only explorer).

##### nmc-3.6.5
###### 2026-05-02

Clarify the Namecoin metrics on `/utxo-set`, surface name vs currency tx mix on `/tx-stats`, and add a `/api/name/*` & `/api/names/*` family.

* **`/utxo-set` Namecoin breakdown rewrite** — the previous "Names (locked)" cell mixed two distinct metrics into one number, which is confusing. The block is now split into three labelled cells:
  * **Coins (currency NMC)** — the spendable money supply outside name registrations.
  * **NMC locked in names** — the sum of NMC sitting inside name outputs at the chain tip (NOT a count of names).
  * **Registered names** — the actual count of names returned by `name_scan` (active vs expired vs total).
  Each cell now has a tooltip explaining what it does and does NOT mean. Adds a per-namespace breakdown table (active / expired / total per namespace) so readers can see the chain's identity-vs-domain composition at a glance.

* **Background `name_scan` enumerator** — new `nameApi.getNamesSummary()` paginates `name_scan` and counts active / expired / total + per-namespace. Wired into `app.js` on the same 30-min interval used for the UTXO summary; cached to `global.namesSummary` and exposed to all views via `res.locals.namesSummary` (skipped under `slowDeviceMode`). The walk takes 1–2 minutes on a busy chain, so it lives off the request path.

* **`/tx-stats` Names + Currency sections** — a new pair of sections at the top of `/tx-stats`:
  * **Names** — active registered names, NMC locked in names, name txs over the last 24h, name-op rate per minute, op kind breakdown (`name_new` / `name_firstupdate` / `name_update`), top namespaces by active count.
  * **Currency** — currency NMC supply, currency tx count over the last 24h, currency tx rate per minute, total tx count for the same window.
  Both sections carry a min/pt-style hover infographic (`+nameTxInfoBadge`, `+currencyTxInfoBadge`) explaining how the numbers are calculated and how to read them. Backed by a new `refreshNameTxStats()` background task that walks the last 144 blocks every 10 min and classifies each tx by whether it carries a `nameOp`.

* **New `/api/name/*` and `/api/names/*` endpoints** — the public API was Bitcoin-flavoured only; nothing exposed Namecoin's identity surface. Added:
  * `GET /api/name/$NAME` — `name_show` enriched with decoded value, namespace, Nostr identities, NameID fields, and ifa-0001 imports.
  * `GET /api/name/$NAME/history` — `name_history` (full update chain).
  * `GET /api/names` — paginated `name_scan` (`start`, `count`, `prefix` query params).
  * `GET /api/names/summary` — the cached counts surfaced on `/utxo-set` and `/tx-stats`.
  * `GET /api/names/pending` — mempool-pending name ops (`name_pending`).
  * `GET /api/names/tx-stats` — the last-24h name vs currency split surfaced on `/tx-stats`.
  All six are documented in `docs/api.js` under a new `names` category and visible at `/api/docs`.

##### nmc-3.6.4
###### 2026-05-02

Surface name operations and the names they touch on `/next-block` and `/mempool-transactions`.

Until now the only mempool/next-block surface that revealed name operations was `/mempool-name-ops`. The general transaction lists hid them — a `name_firstupdate` was indistinguishable from any other tx in `/mempool-transactions`, and operators couldn't see at a glance which names were about to land in the next block.

* **`/next-block`** — the route now calls `name_pending` once and intersects by txid against the `getblocktemplate` candidate set. The view gains:
  * a “N name op(s)” badge on the Summary card,
  * a dedicated “Name operation(s)” content section above the transaction table, listing every (txid, op, name, decoded value) carried by the candidate block,
  * a small `bi-tag-fill` icon next to the txid in the existing transaction table for any tx that carries a name op.
  Cost: one extra `name_pending` RPC per `/next-block` render; the call is O(name-ops-in-mempool), not O(mempool size).

* **`/mempool-transactions`** — the route runs the existing `nameApi.collectNameOps()` over the visible page of verbose mempool transactions (no extra RPC — the data is already on `vout[].scriptPubKey.nameOp`). The shared `+txList` mixin gains a `nameOpsByTxid` option that:
  * shows an inline `name_*` badge + linked `d/...`/`id/...`/etc. name next to the txid,
  * adds an expanded “Name operation(s)” panel underneath the IO details for any affected tx, with namespace tag, decoded JSON value (truncated, scrollable), and (for `name_new`) the pre-image hash.
  An info banner at the top of the page summarises the count and links to `/mempool-name-ops` for the chain-wide view.

* **New shared mixin file** — `views/includes/name-op-mixins.pug` defines `+nameOpBadge`, `+nameOpInlineBadges`, and `+nameOpRowCompact`, included from `shared-mixins.pug` so any page that extends `layout` can render name ops with consistent visual language. Future pages (block detail, address detail) can plug in by passing a `nameOpsByTxid` map.

##### nmc-3.6.3
###### 2026-05-02

Fix `/utxo-set` (Namecoin Core response shape mismatch + page crash on missing data) and rebrand `/mempool-summary` fee-rate units from `sat/vB` to `swartz/vB`.

* **`/utxo-set`** — root cause: Namecoin Core's `gettxoutsetinfo` returns the totals nested under `amount` (`{ coins, names, total }`) instead of Bitcoin Core's flat `total_amount` field, so `coreApi.getUtxoSetSummary` always saw an undefined `total_amount`, returned `null`, and the page crashed in `views/snippets/utxo-set.pug` with `Cannot read properties of null (reading 'lastUpdated')`.
  * `app/api/coreApi.js`: when the response carries `amount` but no `total_amount`, surface `amount.total` as `total_amount` (and keep `amount.coins`/`amount.names` available as `total_coins_amount`/`total_names_amount` for views that want the breakdown).
  * `views/snippets/utxo-set.pug`: when `utxoSetSummary` is null, render a friendly warning panel that explains the two common causes (no `coinstatsindex` + slow scans, or `BTCEXP_SLOW_DEVICE_MODE=true`) and the recommended fix, instead of crashing the page render.
  * Add an optional Namecoin-only "Coins (currency) / Names (locked)" breakdown row beneath the standard summary when `coins`/`names` are available.
  * Rename the BTC-flavoured copy on the Coins summary item to NMC.

* **`/mempool-summary` units** — replace `sat/vB` with `swartz/vB` in all 8 callsites of `views/mempool-summary.pug` (column headers, summary items, custom-rate placeholder, fee-rate chart axis label). Other fee-rate views (`/next-block`, `/transaction`, `/block`, `/predicted-blocks`, `/block-analysis`, `/projected-blocks-old`, plus the index next-block snippet, `index-network-summary`, `blocks-list`, and `shared-mixins`) still say `sat/vB` — those are deliberately left alone in this PR; rename to follow.

##### nmc-3.6.2
###### 2026-05-02

Fix abrasive white background on JSON/value `<pre>` blocks under the dark themes.

* Bootstrap's `bg-body-tertiary` utility resolves to a near-white in our dark themes (`#f8f9fa`) which clashed with the rest of the page (`#112138` body, `#1a2433` cards) and reduced contrast against the near-white body text to nearly nothing — the value text was effectively invisible on `/mempool-name-ops`, `/name/...`, and `/tx/...`.
* Re-target `pre.bg-body-tertiary` to a dark surface that matches `.card-highlight` (`lighten($card-bg, 5%)` background, `lighten($card-bg, 10%)` border, `$body-color` text) in `dark.scss` and `dark-v1.scss`. Light theme is intentionally untouched — the original `bg-body-tertiary` is fine there.
* Bumps `package.json` to `3.6.2` (see `nmc-3.6.1` note: changed CSS asset must move the `?v=<cacheId>` URL).

##### nmc-3.6.1
###### 2026-05-02

Force browser-tab favicon refresh.

* Bump `package.json` version to `3.6.1` so the `?v=<cacheId>` query string baked into every static-asset URL (favicons, app CSS/JS, logos) changes. Browsers that cached the upstream Bitcoin-orange favicon under `?v=3.5.1` will now refetch the Namecoin coin glyph shipped in PR #21 (`feat(namecoin): replace Bitcoin-orange browser-tab favicons with Namecoin coin glyph`).
* No code or asset changes — this is a cache-busting metadata bump only.

##### nmc-3.6.0
###### 2026-05-01

Namecoin coin module: surface name operations and identity, and rebrand the chrome.

* **Mempool / name ops**
	* New `/mempool-name-ops` view: every name operation currently in the mempool, bucketed by `name_firstupdate` / `name_update` / `name_new`, backed by `name_pending` (O(name-ops), not O(mempool size)).
	* `/name/<name>` now shows a *Pending in mempool* panel for unconfirmed updates queued against that specific name.
	* Homepage *Recent Name Operations* tile folds in pending mempool ops alongside the recent-blocks scan, with a `pending` badge.
	* New *Pending Names* nav link (NMC mode only).
* **Detect and pretty-render `import` references** between names per [ifa-0001 §"import"](https://github.com/namecoin/proposals/blob/master/ifa-0001.md#import). Detection only — no recursive RPC fetch. All four spec-permitted shapes accepted (canonical `[[name, sel?]]` plus three short-hands), reported with the carrying node's path breadcrumb.
* **Link `id/` records and `d/<name>` to NameID + Nostr identities**:
	* Typed key/value rendering of NameID fields (`name`, `email`, `www`, `bitcoin`, `tor`, `pgp`/`gpg` fingerprint, etc.).
	* Nostr block detected in both shapes (single-identity `nostr.pubkey` and multi-identity `nostr.names` / `nostr.relays`).
	* Each hex pubkey encoded to NIP-19 `npub` (bech32) and linked to njump.me.
	* Implied `<localPart>@<label>.bit` NIP-05 identifiers rendered for `d/<name>` records.
* **Latest blocks**
	* New merge-mining-aware *Miner* column for Namecoin: scans the parent (Bitcoin) coinbase tag carried inside the AuxPow blob (`auxpow.tx.vin[0].coinbase`), then falls back to the NMC coinbase tag, then to the payout address. The match signal (parent coinbase tag, parent payout address, NMC coinbase tag, or NMC payout address) is surfaced in each row's tooltip.
	* Hover the *Miner* column header for an info bar explaining how merge-mining works and how this column is calculated.
	* Native value labels honour the active coin: `NMC`/`sat` instead of `BTC`/`sat` (`global.currencyTypes.btc` is re-labelled at boot when `BTCEXP_COIN !== "BTC"`).
* **Branding**
	* Top-left logo / favicon / PWA icon / share-preview / safari-pinned-tab SVGs swapped from the Bitcoin “₿” glyph to a Namecoin “N” on Namecoin brand-blue (`#1a78d8`).
	* New blue-heart *Donate to Namecoin* button on the homepage hero, sitting between the upstream red-heart *Donate* and *@BitcoinExplorer*.
* **Tx-stats infographic**
	* Hover any `min/pt`, `hr/pt`, or `day/pt` badge on `/tx-stats` for an explanation of what the unit means, how it's calculated (`(last block time − first) / (n_points − 1)`), and what to read into values relative to the 10-minute target.

##### v3.5.1
###### 2025-07-02

* Minor cleanup
* Fix self-identified version number


##### v3.5.0
###### 2025-06-23

* Fix for node details page display on 28.0+
* Tweak display of miner "notes" (disclaimer for Patoshi)
* Fix for display of JSON-data content
* New holidays and quotes
* Updated miner IDs (including removal of 3 probably false positives from the "Patoshi" list)
* Updated dependencies


##### v3.4.0
###### 2023-06-14

* Breaking changes to the API (see [./api/changelog](/api/changelog))
* Homepage
	* New "Next Halving" widget in Network Summary
	* Show difficulty ATH comparison
	* Show "Next Block" fullness
	* Progress bar for difficulty adjustment estimate
	* Include median fee rate for next-block estimates (also on [/next-block](./next-block))
	* Show a banner if 'today' is a Bitcoin 'Holiday' (see more below)
* Minor fixes for running against Bitcoin Core v23
* Block Analysis: include top "days destroyed" transactions
* URL change: /mining-template -> /next-block (redirect is included for compatibility)
* On Extended PubKey pages, include balance data for various address (if Electrum server is configured)
* New [/next-halving](./next-halving) tool
* Several new API actions/changes; see [/api/changelog](./api/changelog)
* New [/holidays](./holidays), a curated list of Bitcoin 'Holidays'
* Support for different view options on [/fun](./fun)
* On [/difficulty-history](./difficulty-history), make delta graph honor timespan filtering
* Proper use of production-ready MemoryStore for session data
* Support for serving static assets via a configurable CDN
* Misc fixes for erroneous data display on non-mainnet nodes
* Switch from fontawesome to bootstrap-icons v1.8.0
* Refreshed miner-identification database
* Refreshed "Dark" theme with blues toned down (legacy dark theme still available)
* UI/UX tweaks
* Misc minor fixes
* Updated dependencies


##### v3.3.0
###### 2021-12-07

* New tool for viewing the UTXO Set: [/utxo-set](./utxo-set)
* New API actions:
	* [/api/blockchain/utxo-set](./api/blockchain/utxo-set)
	* [/api/address/yourAddress](./api/address/yourAddress)
	* [/api/mining/next-block](./api/mining/next-block)
	* [/api/mining/next-block/txids](./api/mining/next-block/txids)
	* [/api/mining/next-block/includes/:txid](./api/mining/next-block/includes/yourTxid)
	* [/api/mining/miner-summary](./api/mining/miner-summary?since=1d)
* Major fixes for data displayed in [/tx-stats](./tx-stats) tool
* Updated miners, including identification of "Patoshi"-pattern blocks
* [/node-details](./node-details): Include `coinstatsindex` status
* Support querying UTXO Set even with slowDeviceMode=true, iff coinstatsindex is available
* Fix for difficulty adjustment estimate
* [/difficulty-history](./difficulty-history): Support for viewing different time ranges
* When viewing unconfirmed transaction details, show an info dialog if the transaction is predicted to be confirmed in the next block
* Performance improvements
	* Fix for performance degradation over time due to slow "estimatedSupply" function
	* Homepage speedup by making "Estimated Next Block" data load asynchonously
	* Caching for [/difficulty-history](./difficulty-history) data
* Unicode formatting for OP_RETURN and other similar data (with ascii+hex accessible via toggle)
* New `.env` options for setting defaults (see `.env-sample` for details):
	* BTCEXP_DISPLAY_CURRENCY (btc,sat,local)
	* BTCEXP_LOCAL_CURRENCY (usd,eur,gbp)
	* BTCEXP_UI_TIMEZONE (utc,local)
	* BTCEXP_UI_HIDE_INFO_PANELS (true,false)
* Support for displaying timestamps in local timezone (by using browser default, or setting a manual offset)
* Cleanup treatment of `locktime` on transaction details pages
* Unique favicon color based on the active network (mainnet=orange, testnet=green, signet=magenta, regtest=gray)
* Lots of minor styling improvements
* Error handling improvements
* Fix for `/api/quotes/all`
* Fix for incorrect date on "Diario El Salvador..." fun item (thanks [@Dirkson643](https://github.com/Dirkson643))
* New `Fun` items related to Taproot activation
* Performance log admin page at [/admin/perf-log](./admin/perf-log)
* Updated dependencies


##### v3.2.0
###### 2021-08-10

* Public API! See the docs at [/api/docs](./api/docs) (thanks [@pointbiz](https://github.com/pointbiz))
* XPUB pages: search for any xpub (ypub, zpub, etc) and see summary details and a list of associated addresses (thanks [@pointbiz](https://github.com/pointbiz))
* Homepage: add "Predicted Next Block" section
* Mempool Summary: add top-fee transactions table
* Improvements to transaction details UI, especially on smaller screens
* Cleanup support for Taproot/bech32m
* New [/mining-template](./mining-template) tool, showing structured output of `getblocktemplate` command
* Various improvements to charts and graphs throughout the tool (including lots of y-axis changes: linear->log)
* Better support for BIP9 soft forks shown on [/node-details](./node-details) (e.g. Taproot ST in 0.21.1) (Thanks [@Pantamis](https://github.com/Pantamis))
* New "Recent" and "Favorites" sections on [/rpc-browser](./rpc-browser)
* Block lists: show (min, avg, max) fee rates instead of just avg
* Random Bitcoin-related quote shown in footer on each page load
* New [/quotes](./quotes), curated list of Bitcoin-related quotes (each quote also having its own page like [this](`./quote/0`))
* Preemptive support for upcoming format change to `getrawtransaction` output (thanks [@xanoni](https://github.com/xanoni))
* Fix for incorrect homepage block count when using `BTCEXP_UI_HOME_PAGE_LATEST_BLOCKS_COUNT`
* Fix for inaccurate difficulty adjustment estimates
* Link to Tor v3 Hidden Service in footer
* Fix for `DEBUG` environment variable being ignored
* Fix for [/rpc-terminal](./rpc-terminal) not parsing non-int parameters properly
* Fix for edge case where txindex availability check fails at startup (add retries with exp. backoff)
* Fix for tiny-value display (i.e. 1e-8 -> 0.00000001)
* Misc UI/UX tweaks
* Cache busting for frontend resources
* Improved error handling in many places
* Updated dependencies


##### v3.1.1
###### 2021-04-20

* Fix SSO flow broken by v3.0.0 update
* Fix for regtest network errors on homepage
* Fix for server errors in Docker-based installs


##### v3.1.0
###### 2021-04-14

* Improvements to no-`txindex` support: now available for all versions of Bitcoin Core
* Move public sites to [BitcoinExplorer.org](https://bitcoinexplorer.org) (BIG thanks [@SatoshisDomains](https://twitter.com/SatoshisDomains))
* Add back the [/peers](./peers) tool in the "Tools" menu
	* Note: The map on the peers tool now requires users set their own `BTCEXP_MAPBOX_APIKEY` in `.env`
* Response compression
* Remove reference to unused `fonts.css`
* Increased static-files cache: 1hr -> 1mo
* Clearer UX around RPC connection failures (show the fact clearly, instead of flooding the log with cryptic errors)
* Fixed changelog for v3.0.0 release (added/clarified some issues)
* Updated favicons (Thanks [realfavicongenerator.net](https://realfavicongenerator.net))
* Fix for homepage error after failure to get AU exchange rate
* UX improvements on [/peers](./peers) page
* Graphs for top items in [/admin/stats](./admin/stats)
* Optional support for plausible.io analytics
* Fix to avoid displaying empty "Summary" section when we fail to get address txid list
* UX improvement around electrs too-many-txs-for-address errors


##### v3.0.0
###### 2021-04-08

* Major visual refresh!
	* All new design (layout, fonts, colors, etc)
	* Redesigned Dark Mode (now the default)
	* New app icon
* Support for pruned nodes and nodes with disabled `txindex`! (HUGE Thanks to [@shesek](https://github.com/shesek))
	* Note: Currently only Bitcoin Core versions 0.21+ are able to support this feature (a future improvement is planned to make it available to all versions)
* Mempool Summary improvements
	* Greatly improved performance for multiple loads via caching
	* Added: "Blocks Count" column by fee-rate bucket
	* Tool for estimating Block Depth of a transaction or a fee rate (Thanks [@pointbiz](https://github.com/pointbiz))
* Mining Summary: added doughnut chart for rev. breakdown, simplified table data
* Upgraded to Bootstrap 5 (currently beta3...)
* Update mapbox API (Thanks [@shesek](https://github.com/tyzbit))
	* Note: The map on the [/peers](./peers) page now requires that users set the env var `BTCEXP_MAPBOX_APIKEY` to their own API key
* Fix for 404 pages hanging (Thanks [@shesek](https://github.com/shesek))
* Add convenience redirect for baseUrl (Thanks [@shesek](https://github.com/shesek))
* Make url in logs clickable (Thanks [@shesek](https://github.com/shesek))
* Caching for static files (maxAge=1hr)
* Frontend performance optimizations
* Smarter performance/memory defaults for slow devices
* Major refactoring, modernization, and code-reuse improvements
* UX improvements and polish throughout
* URL changes
	* `/node-status` -> `/node-details`
	* `/unconfirmed-tx` -> `/mempool-transactions`
* Environment variable changes
	* The below changes were made to more clearly acknowledge that multiple Electrum-protocol implementations (e.g. ElectrumX, Electrs) can be used for address queries:
	* `BTCEXP_ADDRESS_API` value `electrumx` -> `electrum` (`electrumx` should still works)
	* `BTCEXP_ELECTRUMX_SERVERS` -> `BTCEXP_ELECTRUM_SERVERS` (`BTCEXP_ELECTRUMX_SERVERS` should still work)
* Updated dependencies
	* jQuery: v3.4.1 -> v3.6.0
	* highlight.js: v9.14.2 -> v10.7.1
	* fontawesome: v5.7.1 -> v5.15.3


##### v2.2.0
###### 2021-01-22

* New "Fun" item for the tx containing the whitepaper and new tool to extract the whitepaper and display it
* New fee rate data on `/block-analysis` pages
* New minor misc peer data available in Bitcoin Core RPC v0.21+
* New gold exchange rate on homepage
* Fix for SSO token generation URL encoding (Thanks [@shesek](https://github.com/shesek) and [@Kixunil](https://github.com/Kixunil))
* Fix for [/peers](./peers) map
* Fix for README `git clone` instructions (Thanks [@jonasschnelli](https://github.com/jonasschnelli))


#### v2.1.0
##### 2020-12-15

* Support for running on a configurable BASEURL, e.g. "/explorer/" (Thanks [@ketominer](https://github.com/ketominer), [@Kixunil](https://github.com/Kixunil), [@shesek](https://github.com/shesek))
* Support for SSO (Thanks [@Kixunil](https://github.com/Kixunil))
* Support for signet and taproot (Thanks [@guggero](https://github.com/guggero))
* Support for listening on 0.0.0.0 (Thanks [@lukechilds](https://github.com/lukechilds))
* Support for viewing list of block heights for each miner on `/mining-summary`
* Sanitizing of environment variables (Thanks [@lukechilds](https://github.com/lukechilds))
* Fix for XSS vulnerabilities (Thanks [@shesek](https://github.com/shesek))
* Fix for low severity lodash dependency vulnerability (Thanks [@abhiShandy](https://github.com/abhiShandy))
* Fix for zero block reward (eventually on mainnet, now on regtest) (Thanks [@MyNameIsOka](https://github.com/MyNameIsOka))
* Fix for cryptic error when running regtest with no blocks
* Fix for pagination errors on [/blocks](./blocks) (not displaying genesis block on the last page; error on last page when sort=asc)
* Electrum connect/disconnect stats on `/admin`
* Add P2SH bounty address `/fun` items (Thanks [@cd2357](https://github.com/cd2357))
* Misc cleanup (Thanks [@AaronDewes](https://github.com/AaronDewes))
* Add "Thanks" notes to changelog


#### v2.0.2
##### 2020-07-03

* Lots of improvements to connect/disconnect/error management with configured Electrum servers
* Include pending balance for addresses queried via ElectrumX, when available
* Include basic stats for Electrum queries on `/admin`
* Bug fixes
	* Fix for erroneous defaults for boolean env vars in some scenarios (slow device mode)
* Updated dependences and mining pools
* Misc cleanup (Thanks [@JosephGoulden](https://github.com/JosephGoulden))


#### v2.0.1
##### 2020-05-28

* Highlight coinbase spends in transaction I/O details
* Highlight very old UTXOs (5+ years) in transaction I/O details
* Transaction page: show "days destroyed"
* Bug fixes
	* Fix for "verifymessage" in RPC browser accepting multi-line messages
	* Fix to make "--slow-device-mode=false" work
	* Don't show errors on address page for bech32 due to trying to parse as base58
	* Fix "failure to render homepage when fee estimates are unavailable"
* Minor additions to "fun" data
* Updated dependences


#### v2.0.0
##### 2020-03-25

* New data points in homepage "Network Summary":
	* Fee estimates (estimatesmartfee) for 1, 6, 144, 1008 blocks
	* Hashrate estimate for 1+7 days
	* New item for 'Chain Rewrite Days', using 7day hashrate
	* New data based on UTXO-set summary. Note that UTXO-set querying is resource intensive and therefore disabled by default to protect slower nodes. Set `BTCEXP_SLOW_DEVICE_MODE` to `false` in your `.env` file to enjoy associated features:
		* UTXO-set size
		* Total coins in circulation
		* Market cap
	* 24-hour network volume (sum of tx outputs). This value is calculated at app launch and refreshed every 30min.
	* Avg block time for current difficulty epoch with estimate of next difficulty adjustment
* Tweaks to data in blocks lists:
	* Simpler timestamp formatting for easy reading
	* Include "Time-to-Mine" (TTM) for each block (with green/red highlighting for "fast"/"slow" (<5min / >15min) blocks)
	* Display average fee in sat/vB
	* Add total fees
	* Add output volume (if `getblockstats` rpc call is supported, i.e. 0.17.0+)
	* Show %Full instead of weight/size
* Block Detail page improvements
	* New data in "Summary" on Block pages (supported for bitcoind v0.17.0+)
		* Outputs total volume
		* Input / Output counts
		* UTXO count change
		* Min / Max tx sizes
	* New "Fees Summary" section (bitcoind v0.17.0+)
		* Fee rate percentiles
		* Fee rates: min, avg, max
		* Fee totals: min, avg, max
	* New "Technical Details" section. Items from "Summary" in previous versions have been moved here. This section is collapsible if desired.
* Improvements to transaction input/output displays
	* Change primary input data to be tx outpoint ("txid #voutIndex")
	* Zero-indexing for tx inputs/outputs (#173)
	* Labels for transaction input/output types
	* Inputs: when available, show "input address" below tx outpoint
	* Coinbase and OP_RETURN items: show ascii data inline with link to show hex data
* New tool `/block-stats` for viewing summarized block data from recent blocks
* New tool [/mining-summary](./mining-summary) for viewing summarized mining data from recent blocks
* New tool `/block-analysis` for analyzing the details of transactions in a block.
	* **IMPORTANT**: Use of `/block-analysis` can put heavy memory pressure on this app, depending on the details of the block being analyzed. If your app is crashing, consider setting a higher memory ceiling: `node --max_old_space_size=XXX bin/www` (where `XXX` is measured in MB).
* New tool [/difficulty-history](./difficulty-history) showing a graph of the history of all difficulty adjustments
* Change `/mempool-summary` to load data via ajax (UX improvement to give feedback while loading large data sets)
* Zero-indexing for tx index-in-block values
* Reduced memory usage
* Versioning for cache keys if using persistent cache (redis)
* Configurable UI "sub-header" links
* Start of RPC API versioning support
* Tweaked styling across site
* Homepage UI tweaks
	* Remove "Bitcoin Explorer" H1 (it's redundant)
	* Hide the "Date" (timestamp) column for recent blocks (the Age+TTM is more valuable)
* Updated miner configs
* Lots of minor bug fixes


#### v1.1.9
##### 2020-02-23

* Fix for unescaped user search query display (#183)
* More detailed network info on `/node-status`
* Updated bootstrap, jquery
* Disable stacktrace log output by default (#170)
* Updated miner configs


#### v1.1.8
##### 2020-01-09

* Fix for missing changelog file when installed via npm
* Updated miner configs


#### v1.1.5
##### 2019-12-22

* Fix startup issues when connecting to a node that's not ready to serve data (e.g. verifying blocks)
* Homepage header: show exchange rate in selected currency (rather than hardcoded USD)
* Homepage header: show sat/USD or sat/EUR


#### v1.1.4
###### 2019-12-04

* First-class support for testnet/regtest

#### v1.1.3
###### 2019-12-02

* Fixes related to running bitcoind 0.19.0.1
* Updated dependencies
* Version number in footer
* `/changelog` linked in footer

#### v1.1.2 
###### 2019-10-17

* Add back map on `/peers` that was lost with recent bug

#### v1.1.1
###### 2019-10-01

* Add new default blacklist items for some 'hidden' RPCs
* Print app version info to log on startup
* Remove LTC site from footer

#### v1.1.0
###### 2019-09-30

* Show spent/unspent status on tx detail pages
* Show mempool ancestor/descendant txs on tx detail pages
* Blacklist 'createwallet' by default
* Show RBF status for unconfirmed txs
* Faster, more reliable display of `/mempool-summary` and `/mempool-transactions` pages
* Fix for persisting arg values in UI on `/rpc-browser`
* Misc minor fixes and ux tweaks

#### v1.0.3
###### 2019-04-27

* Pluggable address API supporting different implementations
* Logging improvements
* Fix to avoid caching unconfirmed txs
* Identify destroyed fees
* Misc minor fixes and ux tweaks

#### v1.0.2
###### 2019-03-13

* Fix for background color on light theme

#### v1.0.1
###### 2019-03-13

* Dark theme
* Tx rate graph on homepage
* Improved caching
* Misc minor fixes and ux tweaks

#### v1.0.0
###### 2019-02-23

* Initial release
