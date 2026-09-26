"use strict";

// ---------------------------------------------------------------------------
// Persistent name-operation transaction index (nmc-3.6.59).
//
// A disk-backed index of every name operation on chain, powering the
// names-vs-transactions count-mode toggle on the /utxo-set value-shape
// and DNS record filter tiles (nmc-3.6.59). The "Most updated names"
// leaderboards (last-36,000-blocks and all-time) are a SEPARATE later
// release (3.6.60): mostUpdatedNames/getBoards power the boards beneath
// the by-namespace breakdown on /utxo-set. A THIRD consumer landed in
// nmc-3.6.61: countNameOpsByNames returns per-name op counts in both
// scopes (trailing window + all time over the indexed region) for the
// /names/filter/<key> click-through pages, and the module-level
// countNameOpsForFilterPage slices one rendered page of a match list and
// counts exactly that page in a single batched call (never per-row).
//
// What gets indexed: namecoind surfaces name ops on
// `vout[].scriptPubKey.nameOp` with op one of:
//     "name_new"         - commitment hash only, carries NO name. Recorded
//                          with name=null: it counts toward the global
//                          countNameOpsSince() total but can never be
//                          attributed to a name, so per-name queries
//                          (countNameOpsByNamesSince / mostUpdatedNames)
//                          ignore it. Attributing a name_new would require
//                          recomputing the HASH160(rand||name) commitment
//                          when the firstupdate arrives; not worth the
//                          complexity for a count nothing displays.
//     "name_firstupdate" - reveals the name; first named op of a name.
//     "name_update"      - value change, transfer, AND renewal. Namecoin
//                          Core has no distinct "name_renewal" op: a
//                          renewal IS a name_update with an unchanged
//                          value, so renewals are counted as name_update.
// Any future/unknown op string is skipped (defensive).
//
// Storage (two files in config.filesystemCacheDir, alongside the existing
// names-filter-alltime.json snapshot):
//   names-tx-index-ops.log  - append-only op log, one JSON array per line:
//                             [height, opCode, name, txid]. opCode:
//                             0=name_new 1=name_firstupdate 2=name_update.
//   names-tx-index.json     - tiny cursor/state file rewritten per batch:
//                             { version, backfillDone, tipIndexed, tipHash,
//                               totalOps, namedOps, complete, updatedAt }.
//
// Backfill: full-chain, NEWEST-FIRST (recent data becomes useful
// immediately), resumable after restart via the cursor. Indexed region is
// always the contiguous range [backfillDone .. tipIndexed]: the backfill
// walks backfillDone downward to 0 while the tail indexer pushes
// tipIndexed upward as new blocks gain enough confirmations.
//
// Reorg strategy: the tail only indexes a block once it has
// `confirmations` blocks on top of it (default 6, ~1h on Namecoin), so
// routine 1-block reorgs never touch indexed data. On each tail advance
// the parent hash of the first new block is checked against the stored
// tip hash; a mismatch means a reorg deeper than the confirmation floor,
// which is not self-healable: the index pauses with lastError set and
// logs loudly (wipe the two index files + restart to rebuild).
//
// Memory: only windows and counters are held in RAM, per spec:
//   countByHeight      - Array<height -> op count> (all ops, for
//                        countNameOpsSince); ~1 small int per block.
//   allTimeByName      - Map<name -> packed total*2^32 + lastHeight>
//                        (one number per name; the all-time leaderboard).
//   windowByName       - Map<name -> {heights:[], last}> for named ops in
//                        the last `windowBlocks` blocks (tile tx counts +
//                        the 36k leaderboard).
//   windowHeightIndex  - Map<height -> Map<name -> count>> reverse index
//                        used to expire window entries as the tip moves.
// Everything else (txids, per-op rows) stays on disk in the op log.
//
// Window semantics (PINNED, tested): with tipIndexed = T the window covers
// the last `windowBlocks` blocks INCLUDING the tip, i.e. heights
// [T - windowBlocks + 1 .. T]. An op exactly windowBlocks older than the
// tip (height T - windowBlocks) is EXCLUDED. countNameOpsSince(height) and
// countNameOpsByNamesSince(nameSet, height) count ops with h >= height
// (inclusive lower bound), subject to the retention/completeness caveats:
//   - countNameOpsSince: counts ALL ops (incl. name_new) in
//     [max(height, backfillDone) .. tipIndexed]; while the backfill is
//     incomplete a height below backfillDone yields a partial count
//     (indexStatus().complete flags this).
//   - countNameOpsByNamesSince: exact for height >= windowStart; for an
//     older height the window is the only per-name data held in RAM, so
//     the count silently covers [windowStart .. tipIndexed] only. Callers
//     (the filter tiles) always pass windowStart itself.
//
// RPC load: the backfill fetches blocks via a LEAN path (getblockhash +
// getblock verbosity 2) that skips the coinbase getrawtransaction the
// user-facing rpcApi.getBlockByHash does, and bypasses the block LRU
// (backfill blocks are never re-read, so caching them would only evict
// hot blocks). Batches of `batchSize` blocks are fetched in parallel,
// then the loop sleeps `batchDelayMs` - this yields the event loop and
// leaves headroom for the 30-min name_scan summary walk, which must not
// be starved. Both knobs are env-overridable from app.js. On a fresh
// install the full-chain backfill is a one-time cost measured in hours;
// the boards and tx counts go live from partial data immediately.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const debug = require("debug");

const config = require("../config.js");
const utils = require("../utils.js");

const WINDOW_BLOCKS = 36000;
const DEFAULT_CONFIRMATIONS = 6;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_BATCH_DELAY_MS = 300;
const DEFAULT_BOARD_CACHE_MS = 60 * 1000;
const STATE_VERSION = 1;

const OP_CODES = { name_new: 0, name_firstupdate: 1, name_update: 2 };
const OP_NAMES = ["name_new", "name_firstupdate", "name_update"];

// allTimeByName packs {total, lastHeight} into one safe integer per name:
// total < 2^21 (2M updates for one name is absurd) and height < 2^32 fit
// comfortably below Number.MAX_SAFE_INTEGER.
const PACK_MULT = 2 ** 32;
function packTotalLast(total, lastHeight) { return total * PACK_MULT + lastHeight; }
function unpackTotal(packed) { return Math.floor(packed / PACK_MULT); }
function unpackLast(packed) { return packed % PACK_MULT; }

function createNameTxIndex(options = {}) {
	const opts = Object.assign({
		windowBlocks: WINDOW_BLOCKS,
		confirmations: DEFAULT_CONFIRMATIONS,
		batchSize: DEFAULT_BATCH_SIZE,
		batchDelayMs: DEFAULT_BATCH_DELAY_MS,
		boardCacheMs: DEFAULT_BOARD_CACHE_MS,
		statePath: path.join(config.filesystemCacheDir, "names-tx-index.json"),
		opsLogPath: path.join(config.filesystemCacheDir, "names-tx-index-ops.log"),
		// Injectable chain access (tests inject fakes; production defaults
		// below hit coreApi/rpcApi lazily to dodge circular imports).
		getBlockchainInfo: null,   // async () => ({ blocks: <tip height> })
		fetchBlockByHeight: null,  // async (height) => verbosity-2 block
		logger: null,              // fn(msg string)
		enabled: true,
	}, options);

	const log = (() => {
		const dbg = debug("btcexp:nameTxIndex");
		return (msg) => { if (opts.logger) opts.logger(msg); else dbg(msg); };
	})();

	// --- chain access defaults (lazy requires: nameApi/coreApi inter-require) ---
	const getBlockchainInfo = opts.getBlockchainInfo || (async () => {
		const coreApi = require("./coreApi");
		return coreApi.getBlockchainInfo();
	});
	const fetchBlockByHeight = opts.fetchBlockByHeight || (async (h) => {
		// Lean fetch: getblockhash + getblock <hash> 2. Deliberately NOT
		// rpcApi.getBlockByHeight, which adds a getrawtransaction for the
		// coinbase (fees/miner tagging the index does not need) and goes
		// through the block LRU the backfill would only thrash.
		const rpcApi = require("./rpcApi.js");
		const hash = await rpcApi.getRpcDataWithParams({ method: "getblockhash", parameters: [h] });
		return rpcApi.getRpcDataWithParams({ method: "getblock", parameters: [hash, 2] });
	});

	// --- durable cursor state ---
	const state = {
		backfillDone: null,   // lowest indexed height (inclusive); null until known
		tipIndexed: -1,       // highest indexed height; -1 = nothing indexed
		tipHash: null,        // block hash at tipIndexed (reorg linkage check)
		totalOps: 0,          // all ops indexed, incl. name_new
		namedOps: 0,          // ops carrying a name (firstupdate + update)
		complete: false,      // backfill reached height 0
		updatedAt: null,
		lastError: null,
	};

	// --- in-RAM aggregates (windows + counters only; op rows stay on disk) ---
	let countByHeight = [];                 // height -> all-op count
	const allTimeByName = new Map();        // name -> packed(total, lastHeight)
	const windowByName = new Map();         // name -> { heights: [], last }
	const windowHeightIndex = new Map();    // height -> Map(name -> count)

	let loaded = false;
	let loading = false;
	let stopped = false;
	let backfillRunning = false;
	let tailRunning = false;
	let boardsDirty = true;
	let boardsComputedAt = 0;
	let boardCache = { window: [], allTime: [] };

	function windowStart() {
		if (state.tipIndexed < 0) return 0;
		return Math.max(0, state.tipIndexed - opts.windowBlocks + 1);
	}

	// Extract name ops from a verbosity-2 block into compact [h, opCode,
	// name, txid] rows. Unknown/future op strings are skipped. Bare-string
	// txs (non-verbose shape) carry no nameOp metadata and are skipped.
	function extractOpsFromBlock(block) {
		const rows = [];
		if (!block || !Array.isArray(block.tx)) return rows;
		const h = block.height;
		for (const tx of block.tx) {
			if (!tx || !Array.isArray(tx.vout)) continue;
			for (const out of tx.vout) {
				const nameOp = out && out.scriptPubKey && out.scriptPubKey.nameOp;
				if (!nameOp || typeof nameOp.op !== "string") continue;
				const opCode = OP_CODES[nameOp.op];
				if (opCode === undefined) continue;
				rows.push([h, opCode, (nameOp.name != null ? nameOp.name : null), tx.txid || null]);
			}
		}
		return rows;
	}

	// Apply one op row to the in-RAM aggregates. `name` may be null
	// (name_new): counted globally, never per-name.
	function applyOp(h, opCode, name) {
		countByHeight[h] = (countByHeight[h] || 0) + 1;
		state.totalOps++;
		if (name == null) return;
		state.namedOps++;
		const packed = allTimeByName.get(name) || 0;
		const total = unpackTotal(packed) + 1;
		const last = Math.max(unpackLast(packed), h);
		allTimeByName.set(name, packTotalLast(total, last));
		if (h >= windowStart()) {
			let rec = windowByName.get(name);
			if (!rec) { rec = { heights: [], last: 0 }; windowByName.set(name, rec); }
			rec.heights.push(h);
			if (h > rec.last) rec.last = h;
			let bucket = windowHeightIndex.get(h);
			if (!bucket) { bucket = new Map(); windowHeightIndex.set(h, bucket); }
			bucket.set(name, (bucket.get(name) || 0) + 1);
		}
	}

	// Drop window entries below `newStart` (called as the tip advances).
	// Returns true when any per-name window state was dropped, so the
	// caller can dirty the board cache: a quiet stretch of op-less blocks
	// still slides the window, and the cached window board must not
	// outlive the entries it ranked.
	function expireWindowBelow(newStart) {
		let dropped = false;
		for (const [h, bucket] of windowHeightIndex) {
			if (h >= newStart) continue;
			dropped = true;
			for (const [name, cnt] of bucket) {
				const rec = windowByName.get(name);
				if (!rec) continue;
				if (cnt >= rec.heights.length) {
					windowByName.delete(name);
				} else {
					rec.heights = rec.heights.filter((x) => x !== h);
					if (rec.heights.length === 0) {
						windowByName.delete(name);
					} else if (rec.last === h) {
						let m = 0;
						for (const x of rec.heights) if (x > m) m = x;
						rec.last = m;
					}
				}
			}
			windowHeightIndex.delete(h);
		}
		return dropped;
	}

	function writeStateSync() {
		try {
			const dir = path.dirname(opts.statePath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(opts.statePath, JSON.stringify({
				version: STATE_VERSION,
				backfillDone: state.backfillDone,
				tipIndexed: state.tipIndexed,
				tipHash: state.tipHash,
				totalOps: state.totalOps,
				namedOps: state.namedOps,
				complete: state.complete,
				updatedAt: state.updatedAt,
			}));
		} catch (e) {
			log("nameTxIndex: state write failed: " + e.message);
		}
	}

	function loadStateSync() {
		try {
			if (!fs.existsSync(opts.statePath)) return false;
			const snap = JSON.parse(fs.readFileSync(opts.statePath, "utf8"));
			if (!snap || typeof snap !== "object") return false;
			if (typeof snap.backfillDone !== "number" || typeof snap.tipIndexed !== "number") return false;
			state.backfillDone = snap.backfillDone;
			state.tipIndexed = snap.tipIndexed;
			state.tipHash = snap.tipHash || null;
			state.complete = snap.complete === true;
			state.updatedAt = snap.updatedAt || null;
			return true;
		} catch (e) {
			log("nameTxIndex: state load failed (starting fresh): " + e.message);
			return false;
		}
	}

	// Rebuild the in-RAM aggregates by streaming the op log once. txids are
	// parsed but not retained (they exist on disk as the record of truth).
	async function streamLogIntoMemory() {
		countByHeight = [];
		allTimeByName.clear();
		windowByName.clear();
		windowHeightIndex.clear();
		state.totalOps = 0;
		state.namedOps = 0;
		if (!fs.existsSync(opts.opsLogPath)) return;
		const rl = readline.createInterface({
			input: fs.createReadStream(opts.opsLogPath),
			crlfDelay: Infinity,
		});
		for await (const line of rl) {
			if (!line) continue;
			let rec;
			try { rec = JSON.parse(line); } catch { continue; }
			if (!Array.isArray(rec) || rec.length < 3) continue;
			applyOp(rec[0], rec[1], rec[2]);
		}
		boardsDirty = true;
	}

	async function appendOpsToLog(rows) {
		if (!rows.length) return;
		const dir = path.dirname(opts.opsLogPath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		let buf = "";
		for (const r of rows) buf += JSON.stringify(r) + "\n";
		await fs.promises.appendFile(opts.opsLogPath, buf);
	}

	// Index one already-fetched block: extract ops, persist, aggregate.
	// Order matters: the op log is written BEFORE the in-RAM aggregates are
	// touched, so a crash leaves the log at least as complete as RAM (replay
	// at boot rebuilds RAM from the log, never the other way around).
	// Returns the number of ops indexed from this block.
	async function indexFetchedBlock(block) {
		const rows = extractOpsFromBlock(block);
		await appendOpsToLog(rows);
		for (const r of rows) applyOp(r[0], r[1], r[2]);
		if (rows.length) boardsDirty = true;
		return rows.length;
	}

	// Fresh start: cursor initialised so the indexed region
	// [backfillDone .. tipIndexed] is empty and the backfill begins at the
	// current confirmed tip, walking down.
	async function initFreshCursor() {
		const info = await getBlockchainInfo();
		const tip = info && typeof info.blocks === "number" ? info.blocks : 0;
		const confirmedTip = Math.max(0, tip - opts.confirmations);
		state.backfillDone = confirmedTip + 1;
		state.tipIndexed = confirmedTip;
		state.tipHash = null; // set when the tail first advances or backfill passes it
		state.complete = false;
		state.updatedAt = Date.now();
		writeStateSync();
		log(`nameTxIndex: fresh cursor at confirmed tip ${confirmedTip} (chain tip ${tip})`);
	}

	// One backfill batch: index up to `batchSize` blocks walking downward
	// from (backfillDone - 1). Returns false when the backfill is done.
	// ATOMIC: if any block in the batch fails to fetch, nothing is indexed
	// and the cursor does not move - the loop retries the same batch after
	// a backoff. The pre-fix behaviour (skip the failed block, advance
	// anyway) left permanent unindexed gaps in the op log on any transient
	// RPC hiccup, silently undercounting every query thereafter.
	async function backfillBatch() {
		if (state.backfillDone == null || state.backfillDone <= 0) {
			state.complete = true;
			return false;
		}
		const h1 = state.backfillDone - 1;
		const h0 = Math.max(0, h1 - opts.batchSize + 1);
		const heights = [];
		for (let h = h1; h >= h0; h--) heights.push(h);
		const blocks = await utils.pMap(heights, (h) => fetchBlockByHeight(h).catch((e) => {
			log(`nameTxIndex: backfill fetch failed at height ${h}: ${e.message}`);
			return null;
		}), { concurrency: opts.batchSize });
		if (blocks.some((b) => !b)) {
			throw new Error(`backfill batch heights ${h0}-${h1} incomplete (block fetch failed); will retry`);
		}
		// Cursor advances per block (with a state write each step) so a
		// crash mid-batch can duplicate at most one block's ops on resume
		// instead of a whole batch's.
		for (let i = 0; i < blocks.length; i++) {
			await indexFetchedBlock(blocks[i]);
			state.backfillDone = heights[i];
			state.updatedAt = Date.now();
			writeStateSync();
		}
		if (state.backfillDone === 0) state.complete = true;
		state.updatedAt = Date.now();
		writeStateSync();
		return !state.complete;
	}

	// The full-chain backfill loop: batches separated by batchDelayMs so
	// the event loop (and namecoind) keep headroom for the 30-min
	// name_scan summary walk. Runs once to completion; resumes from the
	// persisted cursor after a restart.
	async function backfillLoop() {
		if (backfillRunning) return;
		backfillRunning = true;
		try {
			while (!stopped && !state.complete && state.backfillDone != null && state.backfillDone > 0) {
				// Batch failures (transient RPC outages) are caught here so the
				// backfill survives them; a longer backoff replaces the normal
				// inter-batch delay to avoid hammering a struggling node.
				let delayMs = opts.batchDelayMs;
				try {
					await backfillBatch();
				} catch (e) {
					state.lastError = e.message;
					delayMs = Math.max(opts.batchDelayMs, 10000);
					log(`nameTxIndex: backfill batch error (retry in ${delayMs}ms): ${e.message}`);
				}
				if (state.complete) break;
				await new Promise((r) => setTimeout(r, delayMs));
			}
			if (state.complete) {
				log(`nameTxIndex: backfill complete: totalOps=${state.totalOps} namedOps=${state.namedOps} names=${allTimeByName.size}`);
			}
		} catch (e) {
			state.lastError = e.message;
			log("nameTxIndex: backfill error: " + e.message);
		} finally {
			backfillRunning = false;
		}
	}

	// Tail indexer: append newly confirmed blocks above tipIndexed. Safe to
	// call on a timer; no-ops while loading, while the cursor is unknown,
	// or when there is nothing new to confirm.
	async function indexNewBlocks() {
		if (!opts.enabled || loading || !loaded || stopped) return { skipped: "not-ready" };
		if (tailRunning) return { skipped: "in-flight" };
		if (state.backfillDone == null) return { skipped: "no-cursor" };
		tailRunning = true;
		try {
			const info = await getBlockchainInfo();
			const tip = info && typeof info.blocks === "number" ? info.blocks : null;
			if (tip == null) return { skipped: "no-tip" };
			const confirmedTip = Math.max(0, tip - opts.confirmations);
			if (state.tipIndexed > tip) {
				// Chain moved backwards past our indexed tip (chain swap,
				// regtest reset, or a reorg deeper than the confirmation
				// floor). Not self-healable: pause loudly. Checked BEFORE the
				// up-to-date short-circuit, which would otherwise always win
				// (confirmedTip < tipIndexed) and hide the condition forever.
				state.lastError = `indexed tip ${state.tipIndexed} is above chain tip ${tip}; index paused (wipe index files + restart to rebuild)`;
				log("nameTxIndex: " + state.lastError);
				return { ok: false, error: state.lastError };
			}
			if (confirmedTip <= state.tipIndexed) return { skipped: "up-to-date" };
			for (let h = state.tipIndexed + 1; h <= confirmedTip; h++) {
				const block = await fetchBlockByHeight(h);
				if (!block) throw new Error(`fetchBlockByHeight(${h}) returned null`);
				// Reorg linkage check: the first block above our indexed tip
				// must build on the stored tip hash. Subsequent blocks are
				// checked against the block we just indexed.
				if (state.tipHash && block.previousblockhash && block.previousblockhash !== state.tipHash) {
					state.lastError = `reorg deeper than ${opts.confirmations} confirmations detected at height ${h}; index paused (wipe index files + restart to rebuild)`;
					log("nameTxIndex: " + state.lastError);
					return { ok: false, error: state.lastError };
				}
				await indexFetchedBlock(block);
				state.tipIndexed = h;
				state.tipHash = block.hash || null;
				if (expireWindowBelow(windowStart())) boardsDirty = true;
				// Persist per block: a crash between blocks then re-indexes at
				// most one already-logged block on resume.
				state.updatedAt = Date.now();
				writeStateSync();
			}
			state.updatedAt = Date.now();
			writeStateSync();
			return { ok: true, tipIndexed: state.tipIndexed };
		} catch (e) {
			state.lastError = e.message;
			log("nameTxIndex: tail error: " + e.message);
			return { ok: false, error: e.message };
		} finally {
			tailRunning = false;
		}
	}

	// Boot: load the cursor, stream the op log into RAM, then kick the tail
	// catch-up and the backfill loop in the background (not awaited).
	async function start() {
		if (!opts.enabled || loaded || loading) return;
		loading = true;
		try {
			const hadState = loadStateSync();
			await streamLogIntoMemory();
			if (!hadState) {
				await initFreshCursor();
			} else {
				log(`nameTxIndex: resumed from cursor: backfillDone=${state.backfillDone} tipIndexed=${state.tipIndexed} totalOps=${state.totalOps} namedOps=${state.namedOps} complete=${state.complete}`);
			}
			loaded = true;
			loading = false;
			// Fire-and-forget: tail catch-up first (cheap), then the long
			// backfill. Errors are captured into state.lastError by the
			// callees; a crash here must never take down app boot.
			(async () => {
				try { await indexNewBlocks(); } catch { /* recorded */ }
				try { await backfillLoop(); } catch { /* recorded */ }
			})();
		} catch (e) {
			loading = false;
			state.lastError = e.message;
			log("nameTxIndex: start error: " + e.message);
		}
	}

	function stop() { stopped = true; }

	// --- query functions (pure against the in-RAM aggregates) ---

	// All name ops (incl. name_new) with height >= `height`, over the
	// indexed region only. Partial while the backfill is incomplete when
	// `height` is below backfillDone.
	function countNameOpsSince(height) {
		if (state.backfillDone == null || state.tipIndexed < 0) return 0;
		let sum = 0;
		const from = Math.max(height, state.backfillDone);
		for (let h = from; h <= state.tipIndexed; h++) sum += countByHeight[h] || 0;
		return sum;
	}

	// Named ops (firstupdate + update) for names in `nameSet` with
	// height >= `height`. Exact for height >= windowStart; older heights
	// are served from the retained window only (see header comment).
	function countNameOpsByNamesSince(nameSet, height) {
		if (!nameSet) return 0;
		const from = Math.max(height, windowStart());
		const wholeWindow = from <= windowStart();
		let sum = 0;
		for (const name of nameSet) {
			const rec = windowByName.get(name);
			if (!rec) continue;
			if (wholeWindow) {
				sum += rec.heights.length;
			} else {
				for (const h of rec.heights) if (h >= from) sum++;
			}
		}
		return sum;
	}

	// Per-name op counts for a set of names, in both scopes the
	// /names/filter/<key> pages display (nmc-3.6.61): the trailing window
	// (exact for the retained window) and all time (exact over the indexed
	// region [backfillDone .. tipIndexed]; partial until the backfill
	// completes). Every requested name appears in both maps, zero counts
	// included, so callers can render one row per name without existence
	// checks. name_new ops carry no name and are never counted here.
	function countNameOpsByNames(nameSet) {
		const window = {};
		const allTime = {};
		if (!nameSet) return { window, allTime };
		for (const name of nameSet) {
			let w = 0;
			const rec = windowByName.get(name);
			if (rec) w = rec.heights.length;
			window[name] = w;
			const packed = allTimeByName.get(name) || 0;
			allTime[name] = unpackTotal(packed);
		}
		return { window, allTime };
	}

	// Per-filter-key tx counts for the /utxo-set count-mode toggle.
	// `filterLists` is the summary's { key: [name, ...] } map; returns
	// { key: txCount }. Pure and injectable-friendly (takes the lists in).
	function countTxsForFilters(filterLists, height) {
		const out = {};
		if (!filterLists) return out;
		for (const key of Object.keys(filterLists)) {
			out[key] = countNameOpsByNamesSince(filterLists[key] || [], height);
		}
		return out;
	}

	// Rank names by op count, tie-broken by most-recent update height,
	// then by name ascending for determinism. sinceHeight=null ranks
	// all-time totals; otherwise ranks window counts from that height.
	function mostUpdatedNames({ sinceHeight = null, limit = 10 } = {}) {
		const out = [];
		if (sinceHeight == null) {
			for (const [name, packed] of allTimeByName) {
				out.push({ name, count: unpackTotal(packed), lastHeight: unpackLast(packed) });
			}
		} else {
			const from = Math.max(sinceHeight, windowStart());
			const wholeWindow = from <= windowStart();
			for (const [name, rec] of windowByName) {
				let c = 0;
				if (wholeWindow) {
					c = rec.heights.length;
				} else {
					for (const h of rec.heights) if (h >= from) c++;
				}
				if (c > 0) out.push({ name, count: c, lastHeight: rec.last });
			}
		}
		out.sort((a, b) => (b.count - a.count) || (b.lastHeight - a.lastHeight) || (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
		return out.slice(0, limit);
	}

	// Cached pair of leaderboards for the /utxo-set render path: recomputed
	// at most once per boardCacheMs while dirty (new ops arrive every block,
	// and the all-time sort walks every tracked name).
	function getBoards({ limit = 10 } = {}) {
		const now = Date.now();
		if (boardsDirty && (now - boardsComputedAt >= opts.boardCacheMs || boardsComputedAt === 0)) {
			boardCache = {
				window: mostUpdatedNames({ sinceHeight: windowStart(), limit }),
				allTime: mostUpdatedNames({ sinceHeight: null, limit }),
			};
			boardsComputedAt = now;
			boardsDirty = false;
		}
		return boardCache;
	}

	function indexStatus() {
		const ws = windowStart();
		const indexedBlocks = (state.backfillDone != null && state.tipIndexed >= 0)
			? (state.tipIndexed - state.backfillDone + 1) : 0;
		return {
			enabled: opts.enabled,
			loaded,
			loading,
			complete: state.complete,
			backfillDone: state.backfillDone,
			tipIndexed: state.tipIndexed,
			totalOps: state.totalOps,
			namedOps: state.namedOps,
			namesTracked: allTimeByName.size,
			windowBlocks: opts.windowBlocks,
			windowStart: ws,
			windowComplete: state.backfillDone != null && state.backfillDone <= ws,
			confirmations: opts.confirmations,
			percent: state.tipIndexed > 0 ? indexedBlocks / (state.tipIndexed + 1) : (state.complete ? 1 : 0),
			boardsComputedAt,
			lastError: state.lastError,
			updatedAt: state.updatedAt,
		};
	}

	return {
		start,
		stop,
		indexNewBlocks,
		indexFetchedBlock,   // exposed for tests (feed a block directly)
		countNameOpsSince,
		countNameOpsByNamesSince,
		countNameOpsByNames,
		countTxsForFilters,
		mostUpdatedNames,
		getBoards,
		indexStatus,
		windowStart,
		// test hooks
		_backfillBatch: backfillBatch,
		_backfillLoop: backfillLoop,
		_initFreshCursor: initFreshCursor,
		_loadOnly: async () => { const h = loadStateSync(); await streamLogIntoMemory(); loaded = true; return h; },
	};
}

// ---------------------------------------------------------------------------
// Shared-instance plumbing. app.js starts the singleton at boot; routes use
// the module-level delegates below, which return safe empty values until the
// singleton exists (or when the index is disabled via env).
// ---------------------------------------------------------------------------
let shared = null;

function startShared(options) {
	const enabled = process.env.BTCEXP_DISABLE_NAME_TX_INDEX !== "true";
	if (!shared) {
		shared = createNameTxIndex(Object.assign({ enabled }, options || {}));
	}
	if (enabled) {
		shared.start().catch(() => { /* error recorded in status */ });
	}
	return shared;
}

function getShared() { return shared; }

const EMPTY_STATUS = {
	enabled: false, loaded: false, loading: false, complete: false,
	backfillDone: null, tipIndexed: -1, totalOps: 0, namedOps: 0,
	namesTracked: 0, windowBlocks: WINDOW_BLOCKS, windowStart: 0,
	windowComplete: false, confirmations: DEFAULT_CONFIRMATIONS,
	percent: 0, boardsComputedAt: 0, lastError: null, updatedAt: null,
};

// nmc-3.6.61: one rendered page of a /names/filter/<key> match list plus
// the per-name tx counts for exactly that page, in a single batched count
// (never per-row queries, never raw log scans). offset is clamped into
// range and aligned down to a whole page; the returned page/pageCount are
// 1-based/total for the pager. Only the rendered page slice is passed to
// the counter: pagination never pays for names it does not display.
function countNameOpsForFilterPage(names, offset, limit) {
	const list = Array.isArray(names) ? names : [];
	const total = list.length;
	const lim = Math.max(1, limit | 0);
	const pageCount = Math.max(1, Math.ceil(total / lim));
	let off = Math.max(0, offset | 0);
	if (off >= total) off = (pageCount - 1) * lim;
	off = Math.floor(off / lim) * lim;
	const pageNames = list.slice(off, off + lim);
	const counts = module.exports.countNameOpsByNames(pageNames);
	return {
		pageNames,
		offset: off,
		limit: lim,
		total,
		pageCount,
		page: Math.floor(off / lim) + 1,
		end: off + pageNames.length,
		window: counts.window,
		allTime: counts.allTime,
	};
}

module.exports = {
	createNameTxIndex,
	startShared,
	getShared,
	WINDOW_BLOCKS,
	OP_CODES,
	OP_NAMES,
	indexStatus: () => (shared ? shared.indexStatus() : Object.assign({}, EMPTY_STATUS)),
	countNameOpsSince: (h) => (shared ? shared.countNameOpsSince(h) : 0),
	countNameOpsByNamesSince: (s, h) => (shared ? shared.countNameOpsByNamesSince(s, h) : 0),
	countNameOpsByNames: (s) => (shared ? shared.countNameOpsByNames(s) : { window: {}, allTime: {} }),
	countNameOpsForFilterPage,
	countTxsForFilters: (lists, h) => (shared ? shared.countTxsForFilters(lists, h) : {}),
	mostUpdatedNames: (o) => (shared ? shared.mostUpdatedNames(o) : []),
	getBoards: (o) => (shared ? shared.getBoards(o) : { window: [], allTime: [] }),
	indexNewBlocks: () => (shared ? shared.indexNewBlocks() : Promise.resolve({ skipped: "disabled" })),
};
