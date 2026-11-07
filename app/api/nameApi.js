"use strict";

// Thin wrappers around Namecoin's name_* RPC methods plus helpers for
// surfacing name-op data attached to transaction outputs.
//
// namecoind decodes name operations server-side and exposes them on
// `vout[].scriptPubKey.nameOp` as an object with shape:
//
//     {
//       op: "name_new" | "name_firstupdate" | "name_update",
//       name: "<utf8 or hex>",                     // (firstupdate/update only)
//       name_encoding: "ascii" | "utf8" | "hex",   // (firstupdate/update only)
//       value: "<utf8 or hex>",                    // (firstupdate/update only)
//       value_encoding: "ascii" | "utf8" | "hex",  // (firstupdate/update only)
//       hash: "<sha256 hash hex>",                 // (name_new only)
//       rand: "<hex rand>",                        // (firstupdate only)
//     }
//
// We never have to parse raw scripts ourselves.

const rpcApi = require("./rpcApi.js");
const { bech32 } = require("bech32");
const config = require("../config.js");
const utils = require("../utils.js");

// Same debug namespace as app.js so index-wiring log lines land wherever
// the app's own "Refreshed names summary" lines already go.
const debugLog = require("debug")("btcexp:app");

// namecoind error codes we treat as authoritative "this name has no live
// record" answers.  -4 covers both "name expired" and "name never
// existed" (per namecoind src/wallet/rpcnames.cpp). Any OTHER error —
// transport/timeout/serialization — is treated as a transient blip and
// retried by `nameShowActive`.
const NAME_ABSENT_RPC_CODE = -4;

// Distinguish authoritative "name does not exist / is expired" answers
// from transient errors.  Used by background scanners that need to know
// whether to treat a failure as "definitely not active" (skip) vs "RPC
// blip" (retry once before skipping).
function isAuthoritativeAbsentError(err) {
	if (!err) return false;
	if (err.code === NAME_ABSENT_RPC_CODE) return true;
	// jayson sometimes surfaces the namecoind message without code mapping;
	// match the well-known prefixes too as a belt-and-braces check.
	const msg = String(err.message || "");
	return /name expired|name not found|never existed/i.test(msg);
}

// `nameShow` with allowExpired:false PLUS one retry on non-authoritative
// failures.  Returns:
//   { ok: true,  info }    — active record found
//   { ok: false, absent }  — absent==true means namecoind authoritatively
//                            said the name is expired/never-existed
//                            (skip without counting as error); absent==false
//                            means a transient RPC error survived the retry
//                            and the caller may want to log it.
async function nameShowActive(name, { retryDelayMs = 200 } = {}) {
	try {
		const info = await nameShow(name, { allowExpired: false });
		if (info && !info.expired) return { ok: true, info };
		return { ok: false, absent: true };
	} catch (err) {
		if (isAuthoritativeAbsentError(err)) return { ok: false, absent: true };
		// One backoff retry for transient blips (network reset, RPC overload,
		// JSON parse hiccup). If still failing, give up and propagate as
		// non-authoritative absent.
		await new Promise((r) => setTimeout(r, retryDelayMs));
		try {
			const info = await nameShow(name, { allowExpired: false });
			if (info && !info.expired) return { ok: true, info };
			return { ok: false, absent: true };
		} catch (err2) {
			if (isAuthoritativeAbsentError(err2)) return { ok: false, absent: true };
			return { ok: false, absent: false, error: err2 };
		}
	}
}

function nameShow(name, options = {}) {
	// Always pass `allowExpired: true` by default so /name/<n> can render
	// data for names that have expired but whose last record is still in
	// the chain index. Without this, namecoind returns RPC error -4 ("name
	// expired") and the entire page falls into the lookup-failure branch —
	// even though the chain still has the name's last value, history,
	// address, etc., all of which are useful to display. Callers that
	// specifically want the active-only behaviour can pass
	// `{ allowExpired: false }`.
	//
	// Also default `nameEncoding` and `valueEncoding` to `"utf8"`. Namecoin
	// Core's default is `"ascii"` which:
	//   * REJECTS the whole call with RPC error -1000
	//     ("Name/value is invalid for encoding ascii") when the `name`
	//     argument itself contains any non-ASCII byte -- e.g. `d/ç` is
	//     currently unlookupable on the explorer, even though it exists
	//     on-chain and the /name/<n> route decode-URI's it correctly.
	//   * Returns `value: null, value_encoding: "ascii"` for any value
	//     whose bytes aren't pure ASCII -- so any name whose JSON payload
	//     contains a UTF-8 character (é, Ω, emoji, CJK, etc.) rendered as
	//     an "Empty value" section on /name/<n>.
	// Requesting `utf8` accepts and returns valid-UTF-8 payloads verbatim;
	// payloads that are neither ASCII nor valid UTF-8 (typical `nft/*` binary
	// chunks) come back with `value_encoding: "hex"` for that specific field
	// so the UI can still surface the raw bytes.
	const opts = Object.assign({
		allowExpired: true,
		nameEncoding: "utf8",
		valueEncoding: "utf8",
	}, options);
	return rpcApi.getRpcDataWithParams({
		method: "name_show",
		parameters: [name, opts],
	}).catch((err) => {
		// Pre-0.19 (or otherwise strict) nodes may reject the options object.
		// Fall back to the legacy no-options form so we at least return
		// something for ASCII-only names on older servers. Callers that need
		// the extended options (e.g. `byHash`) will still surface the error.
		if (err && (err.code === -32602 || /unknown named parameter|invalid parameter/i.test(String(err.message || "")))) {
			return rpcApi.getRpcDataWithParams({
				method: "name_show",
				parameters: [name],
			});
		}
		throw err;
	});
}

function nameHistory(name) {
	// Request `nameEncoding: "utf8"` so this call succeeds for non-ASCII
	// names (namecoind's default `"ascii"` rejects them with RPC error
	// -1000). Request `valueEncoding: "hex"` so binary payloads round-trip
	// losslessly.
	//
	// Without an explicit `valueEncoding`, Namecoin Core returns `value: null`
	// and `value_encoding: "ascii"` for any update whose bytes aren't valid
	// ASCII -- which is the common case for `nft/*` chains that store a
	// chunked file across thousands of `name_update`s. That made the history
	// table on `/name/<n>` render most rows as "(empty)".
	//
	// Hex is preferred over utf8 here because history rows carry the FULL
	// range of values a name has ever held, including binary blobs that are
	// not valid UTF-8 (nft/* chunks). Hex round-trips every byte cleanly;
	// the view then decodes it as UTF-8 opportunistically and falls back to
	// a collapsible hex block for genuinely-binary rows.
	//
	// Older nodes that don't accept the options arg fall back to the no-arg
	// call (downstream gets `value`/`value_encoding` as-is).
	return rpcApi.getRpcDataWithParams({
		method: "name_history",
		parameters: [name, { nameEncoding: "utf8", valueEncoding: "hex" }],
	}).catch((err) => {
		// Fall back if a pre-0.19 node rejects the options object.
		return rpcApi.getRpcDataWithParams({
			method: "name_history",
			parameters: [name],
		});
	});
}

function nameScan(start, count, extraOptions) {
	// `nameEncoding: "utf8"` so rows for non-ASCII names come back with a
	// readable `.name` string instead of `name: null, name_encoding: "hex"`
	// (which would fall out of the cursor advance logic in getNamesSummary
	// and re-trigger the full-scan pagination bug documented in
	// explorer4.txt §1). `valueEncoding: "utf8"` so JSON values with UTF-8
	// characters (Ω, é, emoji, CJK) come back as decodable strings for the
	// value-shape classifier + filter tiles; binary values fall back to
	// `value_encoding: "hex"` per-row.
	//
	// name_scan's options object goes in the third position; the first two
	// are start (cursor) and count. `start` MUST be a string ("" = beginning
	// of keyspace), so we normalise here.
	const opts = Object.assign({
		nameEncoding: "utf8",
		valueEncoding: "utf8",
	}, extraOptions || {});
	const startArg = start == null ? "" : start;
	const countArg = count == null ? 10 : count;
	return rpcApi.getRpcDataWithParams({
		method: "name_scan",
		parameters: [startArg, countArg, opts],
	}).catch((err) => {
		// Fall back if a pre-0.19 node rejects the options object.
		const params = [];
		if (start != null) params.push(start);
		if (count != null) params.push(count);
		return rpcApi.getRpcDataWithParams({
			method: "name_scan",
			parameters: params,
		});
	});
}

// `name_pending` is Namecoin Core's RPC for inspecting name operations
// currently in the mempool. It returns an array of objects shaped like:
//
//   {
//     op:        "name_new" | "name_firstupdate" | "name_update",
//     name:      "<utf8 or hex>",   // omitted for name_new
//     name_encoding: "ascii" | ...,
//     value:     "<...>",
//     value_encoding: "ascii" | ...,
//     txid:      "<hex>",
//     vout:      <number>,
//     ismine:    <bool>     // wallet-relative; ignore for explorer
//   }
//
// If a name argument is provided, the RPC restricts results to that name.
function namePending(name) {
	// name_pending accepts the same {nameEncoding, valueEncoding} options as
	// name_show / name_history / name_scan. Default them to "utf8" so
	// pending ops for non-ASCII names come back with readable `.name` /
	// `.value` strings for the Pending Names page (/mempool-name-ops), the
	// per-name pending panel on /name/<n>, and the homepage tile pending
	// badge. Without this, a mempool `name_firstupdate` for `d/ç` would
	// render as `name: null, name_encoding: "hex"` and the pending row
	// would be silently dropped by any downstream code that filters on
	// `typeof row.name === "string"`.
	//
	// When a name filter is supplied it also needs `nameEncoding: "utf8"`
	// so the filter matches non-ASCII names on the way in.
	const opts = { nameEncoding: "utf8", valueEncoding: "utf8" };
	// name_pending's positional signature is (name, options); `name` is
	// optional. Namecoind's JSON-RPC positional-arg validator refuses to
	// promote an options object into slot 0 (returns error -3 "Wrong type
	// passed: Position 1 (name): expected string"), so when there is no
	// name filter we send explicit JSON `null` in slot 0 to hold the
	// position -- name_pending treats null the same as omitted and returns
	// every pending name op. Verified against namecoind on
	// 127.0.0.1:8336 via direct JSON-RPC call.
	const parameters = name != null ? [name, opts] : [null, opts];
	return rpcApi.getRpcDataWithParams({
		method: "name_pending",
		parameters,
	}).catch((err) => {
		// Pre-0.19 fallback: any complaint about the options object shape or
		// argument types drops us back to the legacy no-options form. We
		// lose UTF-8 for pending rows only; the pending panel still works.
		if (err && (err.code === -3 || err.code === -8 || err.code === -32602 || /unknown named parameter|invalid parameter|type mismatch|expected type|wrong type/i.test(String(err.message || "")))) {
			const legacyParams = [];
			if (name != null) legacyParams.push(name);
			return rpcApi.getRpcDataWithParams({
				method: "name_pending",
				parameters: legacyParams,
			});
		}
		throw err;
	});
}

// Pull out every name-op output across an array of transactions.
// Returns an array of { txid, vout, op, name, value, ... } in tx order.
function collectNameOps(transactions) {
	const ops = [];
	if (!Array.isArray(transactions)) return ops;

	for (const tx of transactions) {
		if (!tx || !Array.isArray(tx.vout)) continue;
		for (let i = 0; i < tx.vout.length; i++) {
			const out = tx.vout[i];
			const nameOp = out && out.scriptPubKey && out.scriptPubKey.nameOp;
			if (!nameOp) continue;
			ops.push({
				txid: tx.txid,
				blockhash: tx.blockhash || null,
				blocktime: tx.blocktime || tx.time || null,
				vout: i,
				op: nameOp.op,
				name: nameOp.name || null,
				name_encoding: nameOp.name_encoding || null,
				value: nameOp.value || null,
				value_encoding: nameOp.value_encoding || null,
				hash: nameOp.hash || null,
				rand: nameOp.rand || null,
			});
		}
	}
	return ops;
}

// Best-effort pretty rendering for a value, returns
//   { kind: "json"|"text"|"hex"|"empty", display: string, parsed?: any }
//
// `encoding` is the `value_encoding` field returned by namecoind (one of
// "ascii", "utf8", "hex"). When the caller requested `valueEncoding: "utf8"`
// (which nameShow/nameScan now do by default -- see their comments), plain
// text and JSON values come back as decoded strings and hit the JSON/text
// path below directly. `"hex"` still shows up when the payload is genuinely
// binary (e.g. nft/* file chunks) OR when the caller asked for hex
// explicitly (nameHistory does, for lossless round-trip). In that case we
// try to decode the hex as UTF-8 opportunistically -- if the result is valid
// UTF-8 with negligible control characters we render it as text/JSON; if
// not, we fall through to `kind: "hex"` so the view can render a
// collapsible hex block.
function renderNameValue(value, encoding) {
	if (value == null || value === "") {
		return { kind: "empty", display: "" };
	}
	if (encoding === "hex") {
		const decoded = _tryDecodeHexAsUtf8(String(value));
		if (decoded != null) {
			return renderNameValue(decoded, "utf8");
		}
		return { kind: "hex", display: value };
	}
	const trimmed = String(value).trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			return {
				kind: "json",
				display: JSON.stringify(parsed, null, 2),
				parsed: parsed,
			};
		} catch (_e) {
			// fall through to text
		}
	}
	return { kind: "text", display: value };
}

// Try to decode a hex string as UTF-8 text. Returns the decoded string when
// the bytes are valid UTF-8 AND look like printable text (< 5% control chars);
// otherwise returns null so the caller renders the raw hex. Mirrors the
// inline decoder in views/name.pug's per-history-row rendering so both
// surfaces treat UTF-8-in-hex the same way.
function _tryDecodeHexAsUtf8(hex) {
	if (!hex || typeof hex !== "string") return null;
	if (hex.length === 0 || hex.length % 2 !== 0) return null;
	if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
	try {
		const bytes = Buffer.from(hex, "hex");
		const asUtf8 = bytes.toString("utf8");
		// Node's Buffer.toString("utf8") replaces invalid sequences with U+FFFD
		// silently, so re-encode and byte-compare to detect that.
		const reenc = Buffer.from(asUtf8, "utf8");
		if (reenc.length !== bytes.length || !reenc.equals(bytes)) return null;
		const ctrls = (asUtf8.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g) || []).length;
		if (ctrls / Math.max(1, asUtf8.length) >= 0.05) return null;
		return asUtf8;
	} catch (_e) {
		return null;
	}
}

// Identify a Namecoin "namespace" (the prefix before the first slash) and the
// label after it. Used for display only; Namecoin itself doesn't enforce this.
function splitNamespace(name) {
	if (!name) return { namespace: null, label: null };
	const idx = name.indexOf("/");
	if (idx <= 0) return { namespace: null, label: name };
	return { namespace: name.substring(0, idx), label: name.substring(idx + 1) };
}

const KNOWN_NAMESPACES = {
	"d": "Domain (.bit)",
	"dd": "Domain data (sub-record / import target)",
	"id": "Identity (NameID)",
	"a": "Application data",
	"x": "Experimental",
	"dn": "Domain name (sub-record)",
};

function namespaceLabel(ns) {
	if (!ns) return null;
	return KNOWN_NAMESPACES[ns] || `Namespace "${ns}"`;
}

// ---------------------------------------------------------------------------
// ifa-0001 §"import" — import reference detection.
// https://github.com/namecoin/proposals/blob/master/ifa-0001.md#import
//
// Spec-permitted shapes for the `import` field (all in JSON):
//
//   "import": "d/foo"                           // single name
//   "import": ["d/foo"]                         // single name
//   "import": ["d/foo", "selector"]             // single name + subdomain selector
//   "import": [["d/foo"], ["d/bar", "sel"]]     // canonical: array of [name, selector?]
//
// The spec says importer items override imported items (including null,
// which suppresses inherited fields). Resolution recurses up to 4 levels.
// We don't resolve here — we just *detect* and *render* the references so
// the explorer can surface them.
// ---------------------------------------------------------------------------

// Returns { imports: [{ name, selector|null }, ...], malformed: bool }
// Always safe to call: returns { imports: [], malformed: false } if absent.
function parseImports(parsedValue) {
	const out = { imports: [], malformed: false };
	if (!parsedValue || typeof parsedValue !== "object") return out;

	const raw = parsedValue.import;
	if (raw == null) return out;

	// Short-hand 1: "import": "d/foo"
	if (typeof raw === "string") {
		out.imports.push({ name: raw, selector: null });
		return out;
	}

	if (!Array.isArray(raw)) {
		out.malformed = true;
		return out;
	}

	// Short-hand 2/3: ["d/foo"] or ["d/foo", "selector"]
	// Distinguish from canonical [["d/foo"], ...] by inspecting the first
	// element: a string => short-hand; an array => canonical.
	if (raw.length > 0 && typeof raw[0] === "string") {
		const name = raw[0];
		const selector = raw.length > 1 && typeof raw[1] === "string" ? raw[1] : null;
		if (name) out.imports.push({ name, selector });
		else out.malformed = true;
		return out;
	}

	// Canonical: array of [name, selector?] tuples.
	for (const entry of raw) {
		if (!Array.isArray(entry) || entry.length === 0) {
			out.malformed = true;
			continue;
		}
		const name = entry[0];
		if (typeof name !== "string" || !name) {
			out.malformed = true;
			continue;
		}
		const selector = entry.length > 1 && typeof entry[1] === "string"
			? entry[1]
			: null;
		out.imports.push({ name, selector });
	}
	return out;
}

// Walk a parsed Namecoin record's `map` tree and collect every `import`
// reference, including those nested under subdomains. Returns:
//   [{ path: ["map","relay"], imports: [...], malformed: bool }, ...]
// `path` is the canonical breadcrumb of the node carrying the import.
function collectAllImports(parsedValue, _depth = 0) {
	const results = [];
	if (!parsedValue || typeof parsedValue !== "object" || _depth > 8) return results;

	const top = parseImports(parsedValue);
	if (top.imports.length || top.malformed) {
		results.push({ path: [], ...top });
	}

	const map = parsedValue.map;
	if (map && typeof map === "object" && !Array.isArray(map)) {
		for (const [label, child] of Object.entries(map)) {
			if (!child || typeof child !== "object") continue;
			const childResults = collectAllImports(child, _depth + 1);
			for (const r of childResults) {
				results.push({ ...r, path: ["map", label, ...r.path] });
			}
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// ifa-0001 §"import" — full import RESOLUTION.
//
// Where parseImports/collectAllImports only *detect* references,
// resolveNameImports actually walks them: it name_show's each imported name
// (recursively), merges the records per the spec, and returns the effective
// value a resolver like ncdns would serve.
//
// Merge semantics (https://github.com/namecoin/proposals/blob/master/ifa-0001.md#import):
//   - The imported record provides DEFAULTS; the importer's own items
//     override, including items with an explicit value of null (the spec
//     counts a present-but-null item as present for precedence).
//   - Multiple imports apply in the order listed: the importer's own items
//     take ultimate precedence, then the first import's items, then the
//     second's, and so on.
//   - Plain objects (incl. `map` trees) merge key-by-key; scalars and
//     arrays override wholesale. (The spec text frames precedence per
//     top-level item but defers to per-item-type merge rules; key-by-key
//     object merging matches what resolvers do with nested `map` data.)
//   - A subdomain selector ["d/foo", "a.b"] imports only that subtree of
//     the target's (already import-resolved) record: labels walk the `map`
//     tree in reverse (DNS) order, falling back to "*" per label; a miss
//     fails that import edge only.
//   - The `import` key itself never appears in the merged result.
//
// Robustness: memoized per call, with a chain-based cycle guard (circular
// chains resolve best-effort: the closing edge contributes nothing) and a
// hard depth cap, mirroring resolveFilterTags in the summary builder.
// Missing / expired / unreadable / unselectable imports contribute nothing
// and surface a per-edge warning. Pure w.r.t. inputs: nothing is mutated.
// ---------------------------------------------------------------------------

const IMPORT_RESOLVE_MAX_DEPTH = 16;

function _isPlainObject(v) {
	return v != null && typeof v === "object" && !Array.isArray(v);
}

// Deep-merge `overlay` onto `base`: `base` supplies defaults, `overlay`
// wins. Two plain objects merge key-by-key (recursively); anything else
// (scalar, array, null, mismatched types) is replaced by `overlay`
// wholesale. Returns a fresh value; neither input is mutated.
function mergeImportedValue(base, overlay) {
	if (_isPlainObject(base) && _isPlainObject(overlay)) {
		const out = Object.assign({}, base);
		for (const [k, v] of Object.entries(overlay)) {
			out[k] = Object.prototype.hasOwnProperty.call(out, k)
				? mergeImportedValue(out[k], v)
				: v;
		}
		return out;
	}
	return overlay;
}

// Walk a resolved record's `map` tree per a subdomain selector. Labels
// process in reverse (DNS) order; a missing label retries as "*" before
// failing. A string leaf substitutes to { ip: [str] } per the spec's `map`
// value shorthand. Returns { ok: true, value } or { ok: false }.
function _applyImportSelector(value, selector) {
	const labels = String(selector).split(".").filter((l) => l.length > 0);
	let cur = value;
	for (let i = labels.length - 1; i >= 0; i--) {
		if (!_isPlainObject(cur) || !_isPlainObject(cur.map)) return { ok: false };
		const child = cur.map[labels[i]];
		if (_isPlainObject(child) || typeof child === "string") {
			cur = child;
		} else {
			const wild = cur.map["*"];
			if (_isPlainObject(wild) || typeof wild === "string") cur = wild;
			else return { ok: false };
		}
	}
	if (typeof cur === "string") cur = { ip: [cur] };
	return { ok: true, value: cur };
}

// Default fetcher: name_show via the module-local RPC wrapper, decoding the
// JSON value. Returns { status, parsed? } with status one of
// "ok" | "missing" | "expired" | "unreadable"; throws only on transient
// RPC errors (callers turn those into "error" edges).
async function _defaultImportFetchName(name) {
	let row;
	try {
		row = await nameShow(name);
	} catch (e) {
		if (isAuthoritativeAbsentError(e)) return { status: "missing" };
		throw e;
	}
	if (!row || row.value == null) return { status: "missing" };
	if (row.expired) return { status: "expired" };
	if (row.value_encoding === "hex") return { status: "unreadable" };
	let parsed;
	try {
		parsed = JSON.parse(String(row.value));
	} catch {
		return { status: "unreadable" };
	}
	if (!_isPlainObject(parsed)) return { status: "unreadable" };
	return { status: "ok", parsed };
}

// Resolve the root-level `import` references of an already-parsed name
// value into a single effective record.
//
//   resolveNameImports(parsedValue, {
//     fetchName,   // async (name) => { status: "ok", parsed } | { status:
//                  //   "missing" | "expired" | "unreadable" }; injectable
//                  //   for tests, defaults to name_show via RPC
//     maxDepth,    // recursion cap (default 16, as resolveFilterTags)
//     name,        // root name (optional): sharper cycle detection and
//                  //   clearer warnings
//   })
//
// Returns:
//   {
//     effective: <object>,          // merged value; no root "import" key
//     imports: [ { name, selector, status, warning, contribution } ],
//     warnings: [ <string>, ... ],  // flat, nested edges carry name context
//     malformed: <bool>,            // root `import` field was malformed
//     mapLevelImports: <bool>,      // value ALSO has imports under `map`
//                                   // (detected, NOT merged)
//   }
// `contribution` is the value that edge merged in (post-selector), or null
// when the edge failed. Edge status: "ok" | "missing" | "expired" |
// "unreadable" | "cycle" | "depth-cap" | "selector-miss" | "error".
async function resolveNameImports(parsedValue, options = {}) {
	const fetchName = options.fetchName || _defaultImportFetchName;
	const maxDepth = typeof options.maxDepth === "number" ? options.maxDepth : IMPORT_RESOLVE_MAX_DEPTH;
	const rootName = typeof options.name === "string" ? options.name : null;
	const memo = new Map();
	const chain = new Set(rootName ? [rootName] : []);
	const warnings = [];

	// Resolve an imported name's FULL record (own items merged over its own
	// imports). Memoized by name; the chain set guards cycles on the current
	// resolution path and is checked BEFORE the memo so an in-flight name
	// can never be awaited circularly. Warnings travel in the return value
	// ({ status, value, warning }) so each edge gets attributed correctly
	// even on memo hits; resolveObject collects them into the flat list.
	async function resolveName(name, depth) {
		if (chain.has(name)) {
			return { status: "cycle", value: null, warning: "import cycle detected; edge ignored (best-effort resolution)" };
		}
		if (depth >= maxDepth) {
			return { status: "depth-cap", value: null, warning: `import depth cap ${maxDepth} reached; edge ignored` };
		}
		if (memo.has(name)) return memo.get(name);
		const p = (async () => {
			let fetched;
			try {
				fetched = await fetchName(name);
			} catch (e) {
				return { status: "error", value: null, warning: `fetch failed: ${e && e.message ? e.message : e}` };
			}
			if (!fetched || fetched.status !== "ok") {
				const st = fetched && fetched.status ? fetched.status : "missing";
				const why = st === "missing" ? "import target not found" : (st === "expired" ? "import target expired" : "value not readable as a JSON object");
				return { status: st, value: null, warning: `${why}; contributes nothing` };
			}
			chain.add(name);
			try {
				const inner = await resolveObject(fetched.parsed, depth, name);
				return { status: "ok", value: inner.effective, warning: null };
			} finally {
				chain.delete(name);
			}
		})();
		memo.set(name, p);
		return p;
	}

	// Merge one parsed record: own items (minus `import`) over the resolved
	// imports, folded forward (each import provides defaults under what is
	// already accumulated) so earlier imports take precedence per the
	// spec's ordering rule. `contextName` labels warnings.
	async function resolveObject(parsed, depth, contextName) {
		const { imports, malformed } = parseImports(parsed);
		if (malformed) {
			warnings.push(`${contextName}: malformed import field; ignored`);
		}
		const own = {};
		for (const [k, v] of Object.entries(parsed)) {
			if (k !== "import") own[k] = v;
		}
		const edges = [];
		let effective = own;
		// Fold FORWARD: each import supplies defaults UNDER everything
		// accumulated so far, yielding own > import[0] > import[1] > ...
		// exactly the spec's precedence order.
		for (let i = 0; i < imports.length; i++) {
			const imp = imports[i];
			const resolved = await resolveName(imp.name, depth + 1);
			const edge = {
				name: imp.name,
				selector: imp.selector,
				status: resolved.status,
				warning: resolved.warning || null,
				contribution: null,
			};
			if (resolved.status === "ok") {
				let contribution = resolved.value;
				if (imp.selector) {
					const sel = _applyImportSelector(resolved.value, imp.selector);
					if (sel.ok) {
						contribution = sel.value;
					} else {
						edge.status = "selector-miss";
						edge.warning = `selector "${imp.selector}" matched no subdomain subtree; contributes nothing`;
						contribution = null;
					}
				}
				if (contribution != null) {
					edge.contribution = contribution;
					effective = mergeImportedValue(contribution, effective);
				}
			}
			if (edge.warning) warnings.push(`${imp.name}: ${edge.warning}`);
			edges.push(edge);
		}
		return { effective, edges };
	}

	const root = await resolveObject(_isPlainObject(parsedValue) ? parsedValue : {}, 0, rootName || "(root)");
	const mapLevelImports = collectAllImports(parsedValue).some((e) => e.path.length > 0);
	return {
		effective: root.effective,
		imports: root.edges,
		warnings,
		malformed: parseImports(parsedValue).malformed,
		mapLevelImports,
	};
}

// ---------------------------------------------------------------------------
// NameID / Nostr identity detection.
//
// NameID spec (id/<name> records): https://nameid.org
// Common fields on an `id/` value:
//   { name, email, bitcoin, namecoin, paypal, gpg: { fingerprint, ... },
//     pgp: { fingerprint, ... }, otr: { fingerprint }, tor, freenet,
//     i2p, bitmessage, btcbit, im: { skype, jabber, ... }, www, nostr: ... }
//
// Nostr-on-Namecoin (the `.bit` NIP-05 extension): a `nostr` block can live
// on EITHER `d/<name>` (per-subdomain NIP-05 mappings) or `id/<name>`
// (single-identity record). Two shapes are accepted by quartz/amethyst:
//
//   1) Multi-identity (typical on `d/`):
//      "nostr": { "names": { "<local-part>": "<hex-pubkey>", ... },
//                 "relays": { "<hex-pubkey>": ["wss://..."] } }
//
//   2) Single-identity (typical on `id/` per quartz commit b5713d3c4):
//      "nostr": { "pubkey": "<hex>", "relays": ["wss://..."] }
//
// Both are detected here.
// ---------------------------------------------------------------------------

function isHex64(s) {
	return typeof s === "string" && /^[0-9a-fA-F]{64}$/.test(s);
}

function npubFromHex(hex) {
	if (!isHex64(hex)) return null;
	try {
		const bytes = Buffer.from(hex, "hex");
		const words = bech32.toWords(bytes);
		return bech32.encode("npub", words, 1023);
	} catch (_e) {
		return null;
	}
}

// Build a NIP-05 identifier "<localPart>@<host>" from a Namecoin name like
// "d/testls" -> "<localPart>@testls.bit". Returns null for non-d/ names.
function nip05ForLocalPart(parentName, localPart) {
	if (!parentName || typeof parentName !== "string") return null;
	const ns = splitNamespace(parentName);
	if (ns.namespace !== "d" || !ns.label) return null;
	const host = `${ns.label}.bit`;
	return `${localPart}@${host}`;
}

// Returns { single: { pubkey, npub, relays }|null,
//           names: [{ localPart, hex, npub, relays:[...], nip05 }, ...],
//           relays: { <hex>: [<wss-url>, ...] } }
// `parentName` is the Namecoin name that carries the record (e.g. "d/testls"
// or "id/alice") — used to build "<localPart>@<host>" NIP-05 hints.
function parseNostrIdentities(parsedValue, parentName) {
	const out = { single: null, names: [], relays: {} };
	if (!parsedValue || typeof parsedValue !== "object") return out;

	const nostr = parsedValue.nostr;
	if (!nostr || typeof nostr !== "object") return out;

	// Single-identity form
	if (typeof nostr.pubkey === "string" && isHex64(nostr.pubkey)) {
		const hex = nostr.pubkey.toLowerCase();
		const relays = Array.isArray(nostr.relays)
			? nostr.relays.filter((r) => typeof r === "string")
			: [];
		out.single = { pubkey: hex, npub: npubFromHex(hex), relays };
	}

	// Per-pubkey relay map
	if (nostr.relays && typeof nostr.relays === "object" && !Array.isArray(nostr.relays)) {
		for (const [k, v] of Object.entries(nostr.relays)) {
			if (!isHex64(k)) continue;
			const list = Array.isArray(v) ? v.filter((r) => typeof r === "string") : [];
			out.relays[k.toLowerCase()] = list;
		}
	}

	// Multi-identity `names` map
	if (nostr.names && typeof nostr.names === "object" && !Array.isArray(nostr.names)) {
		for (const [localPart, hex] of Object.entries(nostr.names)) {
			if (typeof hex !== "string" || !isHex64(hex)) continue;
			const hexLower = hex.toLowerCase();
			out.names.push({
				localPart,
				hex: hexLower,
				npub: npubFromHex(hexLower),
				relays: out.relays[hexLower] || [],
				nip05: nip05ForLocalPart(parentName, localPart),
			});
		}
	}

	return out;
}

// Other NameID fields worth surfacing on the name page.
// Returns a list of { field, label, kind, value, href? } entries for rendering.
function parseNameIdFields(parsedValue) {
	const fields = [];
	if (!parsedValue || typeof parsedValue !== "object") return fields;

	const push = (field, label, value, kind, href) => {
		if (value == null || value === "") return;
		fields.push({ field, label, kind: kind || "text", value, href: href || null });
	};

	if (typeof parsedValue.name === "string") push("name", "Display name", parsedValue.name);
	if (typeof parsedValue.email === "string") {
		push("email", "Email", parsedValue.email, "link", `mailto:${parsedValue.email}`);
	}
	if (typeof parsedValue.www === "string") {
		// Whitelist http(s):// only. The raw value is attacker-controlled
		// on-chain data, and Pug's attribute escaping does NOT scheme-filter:
		// a `www = "javascript:fetch(...)"` value would render as a working
		// javascript: href. Anything that doesn't parse as an absolute
		// http(s) URL is downgraded to plain (non-linkified) text. Bare
		// hostnames ("example.com") are prefixed with https:// so the common
		// case still links.
		const rawWww = parsedValue.www.trim();
		let safeHref = null;

		if (/^https?:\/\//i.test(rawWww)) {
			safeHref = rawWww;
		} else if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:[0-9]+)?(\/\S*)?$/i.test(rawWww)) {
			safeHref = `https://${rawWww}`;
		}

		if (safeHref) {
			push("www", "Website", rawWww, "link", safeHref);
		} else {
			push("www", "Website", rawWww, "text");
		}
	}
	if (typeof parsedValue.bitcoin === "string") push("bitcoin", "Bitcoin address", parsedValue.bitcoin, "mono");
	if (typeof parsedValue.namecoin === "string") push("namecoin", "Namecoin address", parsedValue.namecoin, "mono");
	if (typeof parsedValue.tor === "string") push("tor", "Tor onion", parsedValue.tor, "mono");

	// PGP / GPG fingerprints can be a string, or an object with .fingerprint
	const pgp = parsedValue.pgp || parsedValue.gpg;
	if (pgp) {
		if (typeof pgp === "string") {
			push("pgp", "PGP fingerprint", pgp, "mono");
		} else if (typeof pgp === "object" && typeof pgp.fingerprint === "string") {
			push("pgp", "PGP fingerprint", pgp.fingerprint, "mono");
		}
	}

	return fields;
}

// ---------------------------------------------------------------------------
// Value-shape filters — cheap detectors for what's INSIDE a name's value.
// All inputs are the parsed JSON object from `renderNameValue` (or null/scalar).
// Returning true means "this name's value carries one of <thing>". Used to
// classify every name during the background scan so /utxo-set can show
// counts and link through to the filtered list.
//
// Tags propagate through ifa-0001 `import` references at scan time: a name
// whose own value is just a pointer at another name's value (the common
// d/ -> dd/ delegation pattern) inherits the imported value's tags.
// ---------------------------------------------------------------------------

const ONION_RE = /\b[a-z2-7]{16,56}\.onion\b/i;
// Version-split onion matchers: v2 hosts are exactly 16 base32 chars, v3
// exactly 56. The \b anchor means a 56-char host cannot match ONION_V2_RE
// (no word boundary in the middle of a host) and vice versa.
const ONION_V2_RE = /\b[a-z2-7]{16}\.onion\b/i;
const ONION_V3_RE = /\b[a-z2-7]{56}\.onion\b/i;
// I2P: match valid b32.i2p addresses only (52-60 base32 chars + .b32.i2p)
// Do NOT match bare ".i2p" mentions in text (e.g. "mail.i2p" in contact info)
const I2P_RE = /\b[a-z2-7]{52,60}\.b32\.i2p\b/i;
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|[01]?\d{1,2})(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d{1,2})){3}\b/;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/i;
// Freenet/Hyphanet: match CHK/SSK/USK/KSK keys with optional freenet: prefix.
const FREENET_RE = /\b(?:freenet:)?(?:CHK|SSK|USK|KSK)@[A-Za-z0-9~-]{20,}/i;
// Bitcoin address in value. Regexes do not validate checksums.
// Overlap note: ZeroNet site addresses are base58 and will also match BTC_RE_LEGACY.
// The zeronet filter is JSON-key-only precisely to avoid this collision.
const BTC_RE_LEGACY = /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/;
const BTC_RE_BECH32 = /\bbc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{11,87}\b/i;
// Monero address in value. Regexes do not validate checksums.
const XMR_RE_STANDARD = /\b4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}\b/;
const XMR_RE_SUBADDRESS = /\b8[0-9AB][1-9A-HJ-NP-Za-km-z]{93}\b/;
// Namecoin address in value. Regexes do not validate checksums.
const NMC_RE_LEGACY = /\b[MN][a-km-zA-HJ-NP-Z1-9]{26,34}\b/;
const NMC_RE_BECH32 = /\bnc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{11,71}\b/i;

// Bitmessage address in value: "BM-" + base58 payload (v2 payloads are 32
// chars, v3/v4 up to 36). Regex only, no checksum validation. Old v2
// payloads can start with M/N or 1/3, so they false-positive as Namecoin or
// Bitcoin addresses; they are scrubbed from the address haystack below.
const BITMESSAGE_RE = /\bBM-[1-9A-HJ-NP-Za-km-z]{32,36}\b/;
const BITMESSAGE_RE_G = /\bBM-[1-9A-HJ-NP-Za-km-z]{32,36}\b/g;

// cjdns IPv6 address in value (fc00::/8): full 8-hextet form, or a
// "::"-compressed form. Regex only, no validation beyond shape + fc prefix.
const CJDNS_RE = /\bfc[0-9a-f]{2}(?::[0-9a-f]{1,4}){7}\b/i;
const CJDNS_RE_COMPRESSED = /\bfc[0-9a-f]{2}(?::[0-9a-f]{0,4}){0,6}::(?:[0-9a-f]{1,4}:?){1,6}\b/i;

// Collect every leaf string in a parsed JSON tree (depth-bounded). Used by the
// filter detectors so we can scan all string values without writing custom
// recursion in each one.
function _collectStrings(value, out, depth) {
	if (out.length > 4000) return; // hard cap so a pathological record can't OOM
	if (depth > 12) return;
	if (value == null) return;
	if (typeof value === "string") {
		if (value.length <= 4096) out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) _collectStrings(v, out, depth + 1);
		return;
	}
	if (typeof value === "object") {
		for (const k of Object.keys(value)) {
			_collectStrings(value[k], out, depth + 1);
		}
	}
}

function _hasKeyDeep(obj, keyTest, depth = 0) {
	if (depth > 12 || obj == null || typeof obj !== "object") return false;
	for (const k of Object.keys(obj)) {
		// ifa-0001 null suppression: a key explicitly set to null means
		// "no such field", so it does not count as carrying the shape.
		if (obj[k] != null && keyTest(k)) return true;
		const v = obj[k];
		if (v && typeof v === "object" && _hasKeyDeep(v, keyTest, depth + 1)) return true;
	}
	return false;
}

// True when a string looks like a TLSA/certificate fingerprint: hex,
// optionally separated by colons or spaces, 40-128 hex chars once
// separators are stripped (SHA-1 through SHA-512 territory). Anything
// else (prose, a Bitmessage address, an URL) is not a TLSA record.
function _looksLikeTlsaFingerprint(v) {
	if (typeof v === "string") {
		return /^[0-9a-f]{40,128}$/i.test(v.replace(/[: ]/g, ""));
	}
	if (Array.isArray(v)) {
		return v.some((item) => _looksLikeTlsaFingerprint(item));
	}
	return false;
}

// True when a `fingerprint` key sits where an IP address would: the root
// of the value, or inside a subdomain record reached through `map` keys at
// any nesting depth (ifa-0001 nested subdomains recurse map -> subdomain ->
// map -> ...). The fingerprint value itself must look like a hex TLSA
// fingerprint, so prose or contact addresses parked in a `fingerprint`
// field do not tag tls. A `fingerprint` nested in an unrelated object
// (e.g. a PGP block) does not count for TLSA.
function _hasTlsaFingerprintAtIpLevel(node, depth = 0) {
	if (depth > 12 || node == null || typeof node !== "object" || Array.isArray(node)) return false;
	if (node.fingerprint != null && _looksLikeTlsaFingerprint(node.fingerprint)) return true;
	const map = node.map;
	if (map && typeof map === "object" && !Array.isArray(map)) {
		for (const sub of Object.keys(map)) {
			if (_hasTlsaFingerprintAtIpLevel(map[sub], depth + 1)) return true;
		}
	}
	return false;
}

// Namespace bucket for the per-namespace coin-address filter splits.
// Based on the listed name's own prefix; anything outside d/, dd/, and
// id/ lands in "other".
function _filterNamespace(name) {
	const n = String(name || "").toLowerCase();
	if (n.startsWith("d/")) return "d";
	if (n.startsWith("dd/")) return "dd";
	if (n.startsWith("id/")) return "id";
	return "other";
}

// Collect every leaf string value whose key matches keyTest, walking the
// JSON tree depth-bounded. Used to scrub known-false-positive spans from
// the haystack before regex detection (e.g. zeronet addresses that look
// like Bitcoin addresses).
function _collectKeyValuesDeep(obj, keyTest, out, depth = 0) {
	if (depth > 12 || obj == null || typeof obj !== "object") return;
	for (const k of Object.keys(obj)) {
		const v = obj[k];
		if (v != null && keyTest(k)) {
			if (typeof v === "string") out.push(v);
			else if (Array.isArray(v)) {
				for (const item of v) {
					if (typeof item === "string") out.push(item);
				}
			} else if (typeof v === "object") {
				// Subdomain map: values under the map are addresses.
				for (const subK of Object.keys(v)) {
					const subV = v[subK];
					if (typeof subV === "string") out.push(subV);
				}
			}
		}
		if (v && typeof v === "object") _collectKeyValuesDeep(v, keyTest, out, depth + 1);
	}
}

// Mail-implying SRV service names. When a `service` / `srv` value is an
// object, its child keys name the services offered (e.g. "_imap._tcp");
// advertising a mail protocol implies the name handles mail, so these tag
// MX as well as SRV. _sieve / _managesieve are deliberately excluded:
// mail-adjacent, but not MX.
const MAIL_SRV_RE = /^_(smtp|submission|submissions|imap|imaps|pop3|pop3s)\./;

function _hasMailSrv(obj, depth = 0) {
	if (depth > 12 || obj == null || typeof obj !== "object") return false;
	for (const k of Object.keys(obj)) {
		const v = obj[k];
		if ((k === "service" || k === "srv") && v && typeof v === "object" && !Array.isArray(v)) {
			for (const svcName of Object.keys(v)) {
				if (MAIL_SRV_RE.test(svcName.toLowerCase())) return true;
			}
		}
		if (v && typeof v === "object" && _hasMailSrv(v, depth + 1)) return true;
	}
	return false;
}

// Returns the set of value-shape labels this name's parsed value matches.
// Inputs:
//   parsed        — the JSON-parsed value (or null when value isn't JSON)
//   rawValue      — the raw string value (used for non-JSON regex sweeps)
//   valueEncoding — name_scan's value_encoding ("ascii" | "hex"); optional
function classifyNameValue(parsed, rawValue, valueEncoding) {
	const tags = new Set();
	const hasJson = parsed != null && typeof parsed === "object";
	if (hasJson) tags.add("json");

	// CBOR-encoded value. The check looks at the first byte of the value
	// in hex form: every CBOR data item opens with a header byte whose
	// high 3 bits are the major type (0-7: unsigned/negative integer,
	// byte or text string, array, map, tag, simple/float), and all major
	// types are matched. CBOR payloads carry non-printable bytes, so they
	// come back from name_scan hex-encoded; ASCII-encoded values are not
	// checked (a CBOR value made only of printable characters, e.g. a
	// short text string, is indistinguishable from plain text). Bytes
	// that cannot start a well-formed item are not matched: a reserved
	// additional-info value (28-30 in every major type, 31 for integers,
	// tags, and simple values) or the break code 0xFF.
	if (valueEncoding === "hex" && typeof rawValue === "string" && /^[0-9a-fA-F]{2}/.test(rawValue)) {
		const firstByte = parseInt(rawValue.substring(0, 2), 16);
		const majorType = firstByte >> 5;
		const addlInfo = firstByte & 0x1F;
		const reserved = (addlInfo >= 28 && addlInfo <= 30)
			|| (addlInfo === 31 && (majorType <= 1 || majorType >= 6));
		if (!reserved) tags.add("cbor");
	}

	// Hex-encoded (binary) value. name_scan returns value_encoding "hex"
	// whenever the raw value carries non-printable bytes; ASCII values are
	// returned as-is. Any binary payload matches, CBOR or otherwise, so
	// this is the superset tile for the CBOR filter.
	if (valueEncoding === "hex") tags.add("hex");

	// Build a single big haystack of every string we can find. Cheaper than
	// recursing through the same tree six different times.
	const strings = [];
	if (hasJson) _collectStrings(parsed, strings, 0);
	if (typeof rawValue === "string" && rawValue.length <= 8192) strings.push(rawValue);
	const haystack = strings.join("\n");

	// .onion — v3 onions are 56 chars (a-z2-7), v2 are 16. Tor field on
	// NameID records is also a clear marker even when string isn't a v3 host.
	if (ONION_RE.test(haystack) ||
		(hasJson && _hasKeyDeep(parsed, (k) => k === "tor" || k === "_tor"))) {
		tags.add("onion");
	}
	// Version split: an exactly-16 host tags onion-v2, an exactly-56 host
	// tags onion-v3. The tor/_tor key check above stays version-agnostic.
	if (ONION_V2_RE.test(haystack)) {
		tags.add("onion");
		tags.add("onion-v2");
	}
	if (ONION_V3_RE.test(haystack)) {
		tags.add("onion");
		tags.add("onion-v3");
	}

	// TLS — ifa-0001 §"tls": typically a `tls` field whose value is an array
	// of TLSA tuples `[[usage, selector, mtype, hash], ...]`. We also accept
	// any deeply-nested `tls` key.
	// The deprecated ifa-0001 `fingerprint` field (pre-`tls`) also tags tls,
	// but only where an IP address would sit: the value root or a subdomain
	// record under `map` (any nesting depth), and only when the value looks
	// like a hex fingerprint. A `fingerprint` nested inside an unrelated
	// object (e.g. `pgp`) or holding prose is not a TLSA record.
	if ((hasJson && _hasKeyDeep(parsed, (k) => k === "tls" || k === "tlsa")) ||
		(hasJson && _hasTlsaFingerprintAtIpLevel(parsed))) {
		tags.add("tls");
	}

	// SSHFP - ifa-0001-style `sshfp` field: SSH host-key fingerprints, the
	// SSH analog of the TLSA `tls` field above. Detection is JSON-key-only,
	// same convention as the zeronet filter: text merely mentioning sshfp
	// does not match. `_sshfp` is deliberately not accepted: SSHFP records
	// have no underscore service-prefix form in DNS (unlike SRV or TLSA),
	// and the tls check likewise does not accept `_tls`.
	if (hasJson && _hasKeyDeep(parsed, (k) => k === "sshfp")) {
		tags.add("sshfp");
	}

	// IPs — ifa-0001 fields `ip` (v4) and `ip6` (v6), or any literal address
	// in any string value across the record.
	if ((hasJson && _hasKeyDeep(parsed, (k) => k === "ip" || k === "ip4" || k === "ip6")) ||
		IPV4_RE.test(haystack) || IPV6_RE.test(haystack)) {
		tags.add("ip");
	}

	// Nostr — either a top-level `nostr` block, or an `nostr` key anywhere in
	// the tree. parseNostrIdentities handles the actual extraction; here we
	// just need a fast "is there one?" classifier.
	if (hasJson && _hasKeyDeep(parsed, (k) => k === "nostr")) {
		tags.add("nostr");
	}

	// I2P — a `i2p` key in JSON, or a valid b32.i2p host (52-60 base32 chars).
	// Does NOT match bare ".i2p" mentions in text (e.g. "mail.i2p" in contact
	// info) — those are not actual I2P addresses.
	if ((hasJson && _hasKeyDeep(parsed, (k) => k === "i2p")) ||
		I2P_RE.test(haystack)) {
		tags.add("i2p");
	}

	// ZeroNet: a `zeronet` key in JSON, per ZeroNet's .bit integration:
	// either a single site address string, or a subdomain map where ""
	// is the root site. Key-only detection on purpose: ZeroNet site
	// addresses are plain base58check strings, indistinguishable from
	// Bitcoin addresses, so a haystack regex would false-positive on
	// unrelated names.
	if (hasJson && _hasKeyDeep(parsed, (k) => k === "zeronet")) {
		tags.add("zeronet");
	}

	// Freenet/Hyphanet: either a `freenet` or `hyphanet` JSON key, or a
	// Freenet URI (CHK/SSK/USK/KSK) embedded in the raw value string.
	if ((hasJson && _hasKeyDeep(parsed, (k) => k === "freenet" || k === "hyphanet")) ||
		FREENET_RE.test(haystack)) {
		tags.add("freenet");
	}

	// Bitmessage address in value: "BM-" + base58 payload, or a
	// `bitmessage` JSON field. Detected before the coin-address regexes and
	// scrubbed from the address haystack: old (v2) Bitmessage payloads are
	// base58 and can start with M/N or 1/3, so they would false-positive as
	// Namecoin or Bitcoin addresses.
	const addrHaystack = haystack.replace(BITMESSAGE_RE_G, " ");
	if ((hasJson && _hasKeyDeep(parsed, (k) => k.toLowerCase() === "bitmessage")) ||
		BITMESSAGE_RE.test(haystack)) {
		tags.add("bitmessage");
	}

	// Bitcoin address in value: legacy base58check or bech32/bech32m.
	// Scrub zeronet-keyed strings from the haystack first so ZeroNet
	// addresses do not false-positive as Bitcoin addresses. A bare
	// zeronet-looking address in plain text still matches btc; that is
	// unavoidable without key context.
	let btcHaystack = addrHaystack;
	if (hasJson) {
		const zeronetVals = [];
		_collectKeyValuesDeep(parsed, (k) => k.toLowerCase() === "zeronet", zeronetVals);
		for (const zv of zeronetVals) {
			btcHaystack = btcHaystack.split(zv).join("");
		}
	}
	// ZeroNet local-proxy URLs (127.0.0.1:43110/<site address>) embed a
	// base58 site address that matches the BTC shape; strip the whole URL
	// token so the site address does not false-positive as Bitcoin.
	btcHaystack = btcHaystack.replace(/127\.0\.0\.1:43110\/[A-Za-z0-9]+/g, " ");
	if (BTC_RE_LEGACY.test(btcHaystack) || BTC_RE_BECH32.test(btcHaystack)) {
		tags.add("btc");
	}

	// Monero address in value: standard/integrated or subaddress.
	if (XMR_RE_STANDARD.test(haystack) || XMR_RE_SUBADDRESS.test(haystack)) {
		tags.add("xmr");
	}

	// Namecoin address in value: legacy P2PKH (M/N prefix) or bech32 (nc1).
	// Runs on the bitmessage-scrubbed haystack so old BM- payloads with an
	// M/N-leading base58 part do not false-positive here.
	if (NMC_RE_LEGACY.test(addrHaystack) || NMC_RE_BECH32.test(addrHaystack)) {
		tags.add("nmc");
	}

	// cjdns IPv6 address in value (fc00::/8). These also match the generic
	// ip / aaaa filters; cjdns is tracked separately because the range is
	// reserved for private use and its presence signals a cjdns service.
	if (CJDNS_RE.test(haystack) || CJDNS_RE_COMPRESSED.test(haystack)) {
		tags.add("cjdns");
	}

	// DNS record types. These are ifa-0001 §"map" sub-fields that carry
	// individual DNS record types. Each gets its own filter so users can
	// inspect names by specific DNS capability.
	//
	// ifa-0001 mapping:
	//   - ip       → A      (IPv4 address)
	//   - ip6      → AAAA   (IPv6 address)
	//   - alias / translate → CNAME  (canonical name aliasing)
	//   - ns       → NS     (nameserver delegation)
	//   - email    → EMAIL (contact address; not a DNS record)
	//   - mx       → MX    (mail exchange; also implied by mail SRV service names)
	//   - txt      → TXT    (arbitrary text records)
	//   - service / srv → SRV (service location)
	//   - tls / tlsa → TLSA (DANE TLS pinning)
	//   - ds       → DS     (DNSSEC delegation signer)
	//   - dnssec   → DNSSEC (cryptographic validation marker)
	if (hasJson) {
		// A — IPv4 address mapping (`ip` field per ifa-0001, or any literal v4 in haystack)
		if (_hasKeyDeep(parsed, (k) => k === "ip" || k === "ip4") || IPV4_RE.test(haystack)) {
			tags.add("a");
		}
		// AAAA — IPv6 address mapping (`ip6` field, or any literal v6 in haystack)
		if (_hasKeyDeep(parsed, (k) => k === "ip6") || IPV6_RE.test(haystack)) {
			tags.add("aaaa");
		}
		// CNAME — Canonical name aliases (`alias` or `translate` per ifa-0001)
		if (_hasKeyDeep(parsed, (k) => k === "alias" || k === "translate" || k === "cname")) {
			tags.add("cname");
		}
		// NS — Nameserver delegation (`ns` field per ifa-0001)
		if (_hasKeyDeep(parsed, (k) => k === "ns")) {
			tags.add("ns");
		}
		// Email: contact address field (`email` per ifa-0001). A contact
		// address, not a mail-exchange record; it no longer counts as MX.
		if (_hasKeyDeep(parsed, (k) => k === "email")) {
			tags.add("email");
		}
		// MX: mail exchange servers (`mx` array per ifa-0001), or mail
		// protocols advertised via SRV service names (see _hasMailSrv).
		if (_hasKeyDeep(parsed, (k) => k === "mx") || _hasMailSrv(parsed)) {
			tags.add("mx");
		}
		// TXT — Text records (arbitrary data; `txt` per ifa-0001)
		if (_hasKeyDeep(parsed, (k) => k === "txt")) {
			tags.add("txt");
		}
		// SRV — Service location records (`service` per ifa-0001, or `srv`)
		if (_hasKeyDeep(parsed, (k) => k === "service" || k === "srv")) {
			tags.add("srv");
		}
		// SOA — Start of authority. Not part of ifa-0001 core but appears in
		// some DNS-bridge records as a `soa` field.
		if (_hasKeyDeep(parsed, (k) => k === "soa")) {
			tags.add("soa");
		}
		// DS — Delegation signer (DNSSEC). `ds` field per ifa-0001 §"ds".
		if (_hasKeyDeep(parsed, (k) => k === "ds")) {
			tags.add("ds");
		}
		// DNSSEC — explicit `dnssec` field marker, OR any combination of
		// DNSSEC-validation records (`ds`, `tls`/`tlsa`, `rrsig`, `dnskey`).
		// Treat presence of any cryptographic-validation record as a DNSSEC tag.
		if (_hasKeyDeep(parsed, (k) => k === "dnssec" || k === "rrsig" || k === "dnskey" || k === "nsec" || k === "nsec3" || k === "ds")) {
			tags.add("dnssec");
		}
	}

	return tags;
}

const FILTER_KEYS = ["json", "cbor", "hex", "onion", "tls", "sshfp", "ip", "nostr", "i2p", "zeronet", "a", "aaaa", "cname", "ns", "mx", "txt", "srv", "soa", "ds", "dnssec", "onion-v2", "onion-v3", "email", "freenet", "btc", "btc-d", "btc-dd", "btc-id", "btc-other", "xmr", "nmc", "nmc-d", "nmc-dd", "nmc-id", "nmc-other", "bitmessage", "bitmessage-d", "bitmessage-dd", "bitmessage-id", "bitmessage-other", "cjdns"];
const FILTER_LABELS = {
	json: "Valid JSON",
	cbor: "CBOR",
	hex: "Hex",
	onion: ".onion",
	tls: "TLSA",
	sshfp: "SSHFP",
	ip: "IP addresses",
	nostr: "Nostr",
	i2p: "I2P",
	zeronet: "ZeroNet",
	a: "A (IPv4)",
	aaaa: "AAAA (IPv6)",
	cname: "CNAME",
	ns: "NS",
	mx: "MX",
	txt: "TXT",
	srv: "SRV",
	soa: "SOA",
	ds: "DS",
	dnssec: "DNSSEC",
	"onion-v2": "Onion v2",
	"onion-v3": "Onion v3",
	email: "Email",
	freenet: "Freenet",
	btc: "Bitcoin",
	"btc-d": "Bitcoin (d/)",
	"btc-dd": "Bitcoin (dd/)",
	"btc-id": "Bitcoin (id/)",
	"btc-other": "Bitcoin (other)",
	xmr: "Monero",
	nmc: "Namecoin",
	"nmc-d": "Namecoin (d/)",
	"nmc-dd": "Namecoin (dd/)",
	"nmc-id": "Namecoin (id/)",
	"nmc-other": "Namecoin (other)",
	bitmessage: "Bitmessage",
	"bitmessage-d": "Bitmessage (d/)",
	"bitmessage-dd": "Bitmessage (dd/)",
	"bitmessage-id": "Bitmessage (id/)",
	"bitmessage-other": "Bitmessage (other)",
	cjdns: "CJDNS",
};
const FILTER_DESCRIPTIONS = {
	json: "Names whose value parses as JSON. The Namecoin convention is to use JSON for any structured record (d/, id/, dd/, nft/, ...); a name without JSON is usually a one-line text payload.",
	cbor: "Names whose value is CBOR-encoded binary rather than JSON. Detected via the first byte of the value in hex form: a CBOR data item opens with a header byte whose high 3 bits are the major type (unsigned/negative integer, byte or text string, array, map, tag, simple/float), and every major type is matched. CBOR payloads carry non-printable bytes, so they come back from name_scan hex-encoded; ASCII-encoded values are not checked (a CBOR value made only of printable characters is indistinguishable from plain text). Bytes that cannot start a well-formed item are excluded: reserved additional-info values (28-30 in every major type, 31 for integers, tags, and simple values) and the break code 0xFF.",
	hex: "Names whose value came back from name_scan hex-encoded: the raw value carries non-printable bytes, so it is some kind of binary payload rather than plain text or JSON. This is the superset tile for the CBOR filter: every CBOR value is hex-encoded, but a hex-encoded value can also be protobuf, a raw signature or key, an image chunk, or any other binary format. ASCII-encoded values never match.",
	onion: "Names whose value carries a Tor onion address of any version: either a `tor` / `_tor` field (NameID convention) or a `.onion` hostname embedded anywhere in the value. See the Onion v2 and Onion v3 filters for the per-version split.",
	"onion-v2": "Names whose value carries a Tor v2 onion address: a 16-character base32 host ending in `.onion`.",
	"onion-v3": "Names whose value carries a Tor v3 onion address: a 56-character base32 host ending in `.onion`.",
	tls: "Names that publish TLSA records (ifa-0001 `tls` / `tlsa` field, or the deprecated `fingerprint` field where an IP address would sit: the value root or a subdomain record under `map`, at any nesting depth, and only when the value looks like a hex fingerprint; a `fingerprint` nested in other objects such as `pgp`, or holding non-hex prose, does not count). The `tls` field is an array of `[usage, selector, mtype, hash]` tuples used to pin a host's TLS certificate via Namecoin instead of a public CA. Used by .bit relays for DANE TLS pinning.",
	sshfp: "Names that publish SSHFP records via an `sshfp` field (SSH host-key fingerprints, the SSH analog of the TLSA `tls` field). The field carries RFC 4255 SSHFP data (algorithm, fingerprint type, fingerprint) used to pin a host's SSH host key via Namecoin instead of trust-on-first-use. Detection is JSON-key-only, so text merely mentioning sshfp does not match. `_sshfp` does not match either: SSHFP has no underscore service-prefix form in DNS, unlike SRV or TLSA.",
	ip: "Names that publish at least one IP address (`ip` / `ip4` / `ip6` field per ifa-0001, or a literal address anywhere in the value). Combines A and AAAA for backwards compat.",
	nostr: "Names that publish a Nostr identity — either a single `nostr.pubkey` (NameID-style) or a multi-identity `nostr.names` map for NIP-05 delegation across subdomains.",
	i2p: "Names that publish an I2P address — either an `i2p` field in the JSON value or a valid `.b32.i2p` host (52-60 base32 characters). Does not match names that merely mention '.i2p' in text.",
	zeronet: "Names that publish a ZeroNet site address via the `zeronet` field, either a single address string or a subdomain map (where the empty key is the root site). This is the convention ZeroNet's Namecoin integration uses for .bit sites. Detection is JSON-key-only, so text merely mentioning zeronet does not match.",
	a: "A — IPv4 address mapping (ifa-0001 `ip` field). Maps a name to one or more IPv4 addresses.",
	aaaa: "AAAA — IPv6 address mapping (ifa-0001 `ip6` field). Maps a name to one or more IPv6 addresses.",
	cname: "CNAME — Canonical name alias (ifa-0001 `alias` / `translate`). Redirects this name's resolution to another name.",
	ns: "NS — Nameserver delegation (ifa-0001 `ns` field). Delegates resolution authority to one or more DNS nameservers.",
	mx: "MX: Mail exchange servers. An `mx` field per ifa-0001, or SRV service names for mail protocols (`_smtp`, `_submission`, `_imap`, `_pop3` and TLS variants). The `email` contact field is separate and does not count toward MX.",
	email: "Names whose value carries an `email` field (ifa-0001 contact address). A contact address is not a mail-exchange record, so it is tracked separately from MX.",
	freenet: "Names whose value carries a Freenet/Hyphanet key (`freenet` or `hyphanet` JSON field) or a Freenet URI (CHK/SSK/USK/KSK) embedded in the value.",
	btc: "Names whose value carries a Bitcoin address (legacy base58check or bech32/bech32m). Regex detection does not validate checksums. ZeroNet site addresses are also base58, so addresses found as values of a `zeronet` JSON key are excluded from this filter; a bare zeronet-looking address in plain text with no JSON key context still matches.",
	xmr: "Names whose value carries a Monero address (standard/integrated or subaddress). Regex detection does not validate checksums.",
	nmc: "Names whose value carries a Namecoin address (legacy P2PKH M/N prefix, or bech32 nc1). Bitmessage addresses (BM- + base58 payload) are excluded and classified under the bitmessage filter. Regex detection does not validate checksums.",
	"btc-d": "d/ names whose value carries a Bitcoin address, directly or via ifa-0001 import. Namespace subset of the btc filter; the listed name's own namespace decides. Detection caveats as for btc.",
	"btc-dd": "dd/ names whose value carries a Bitcoin address, directly or via ifa-0001 import. Namespace subset of the btc filter; the listed name's own namespace decides. Detection caveats as for btc.",
	"btc-id": "id/ names whose value carries a Bitcoin address, directly or via ifa-0001 import. Namespace subset of the btc filter; the listed name's own namespace decides. Detection caveats as for btc.",
	"btc-other": "Names outside the d/, dd/, and id/ namespaces whose value carries a Bitcoin address, directly or via ifa-0001 import. Namespace subset of the btc filter. Detection caveats as for btc.",
	"nmc-d": "d/ names whose value carries a Namecoin address, directly or via ifa-0001 import. Namespace subset of the nmc filter; the listed name's own namespace decides. Detection caveats as for nmc.",
	"nmc-dd": "dd/ names whose value carries a Namecoin address, directly or via ifa-0001 import. Namespace subset of the nmc filter; the listed name's own namespace decides. Detection caveats as for nmc.",
	"nmc-id": "id/ names whose value carries a Namecoin address, directly or via ifa-0001 import. Namespace subset of the nmc filter; the listed name's own namespace decides. Detection caveats as for nmc.",
	"nmc-other": "Names outside the d/, dd/, and id/ namespaces whose value carries a Namecoin address, directly or via ifa-0001 import. Namespace subset of the nmc filter. Detection caveats as for nmc.",
	bitmessage: "Names whose value carries a Bitmessage address (`BM-` + base58 payload, or a `bitmessage` JSON field). Old v2 Bitmessage payloads are base58 and can start with M/N or 1/3, so they are scrubbed before the Namecoin/Bitcoin regexes and classified here instead.",
	"bitmessage-d": "d/ names whose value carries a Bitmessage address, directly or via ifa-0001 import. Namespace subset of the bitmessage filter; the listed name's own namespace decides. Detection caveats as for bitmessage.",
	"bitmessage-dd": "dd/ names whose value carries a Bitmessage address, directly or via ifa-0001 import. Namespace subset of the bitmessage filter; the listed name's own namespace decides. Detection caveats as for bitmessage.",
	"bitmessage-id": "id/ names whose value carries a Bitmessage address, directly or via ifa-0001 import. Namespace subset of the bitmessage filter; the listed name's own namespace decides. Detection caveats as for bitmessage.",
	"bitmessage-other": "Names outside the d/, dd/, and id/ namespaces whose value carries a Bitmessage address, directly or via ifa-0001 import. Namespace subset of the bitmessage filter. Detection caveats as for bitmessage.",
	cjdns: "Names whose value carries a cjdns IPv6 address: any IPv6 address starting with `fc` (fc00::/8, reserved for private use and used by cjdns), in full or `::`-compressed form. Also counted under the generic IP filter. Regex detection does not validate the address.",
	txt: "TXT — Text records (ifa-0001 `txt` field). Arbitrary text data; commonly used for SPF, DKIM, domain verification, and ad-hoc metadata.",
	srv: "SRV: Service location records (ifa-0001 `service` field, or the equivalent `srv` field). Locates a host:port for a named service (e.g. `_xmpp._tcp`).",
	soa: "SOA — Start of authority record. Indicates the primary nameserver and admin contact for a DNS zone served via Namecoin.",
	ds: "DS — Delegation signer (DNSSEC). The `ds` field carries the cryptographic hash of a child zone's DNSKEY, anchoring DNSSEC validation in the Namecoin record.",
	dnssec: "DNSSEC-related records (cryptographic validation). Names carrying any DNSSEC-validation field: `dnssec`, `ds`, `rrsig`, `dnskey`, `nsec`, or `nsec3`.",
};

// ---------------------------------------------------------------------------
// All-time filter snapshot.
//
// The /utxo-set value-shape and DNS record filter tiles count ACTIVE names
// only, refreshed every 30 min by the getNamesSummary walk below. Their
// all-time counterparts (active + expired) are recomputed on a much slower
// cadence - once every ALLTIME_FILTER_MIN_BLOCKS blocks - during the same
// walk, and persisted to a JSON snapshot in the explorer filesystem cache
// dir so a restart renders instantly from disk instead of rescanning.
// The in-memory copy mirrors the snapshot file; loadAllTimeFilterSnapshot
// lazy-loads it on first use.
// ---------------------------------------------------------------------------
const ALLTIME_FILTER_MIN_BLOCKS = 36000;
// nmc-3.6.64: all-time filter match lists are no longer capped (user
// request). Lists store references to name strings that already live in
// the scan indexes, so the extra memory is just array slots, and every
// /names/filter page can render the complete all-time match set.
const ALLTIME_FILTER_LIST_CAP = Infinity;
const allTimeFilterFileCache = utils.fileCache(config.filesystemCacheDir, "names-filter-alltime");
let allTimeFilterSnapshot = null;
let allTimeFilterSnapshotLoaded = false;

function loadAllTimeFilterSnapshot() {
	if (allTimeFilterSnapshotLoaded) return allTimeFilterSnapshot;
	allTimeFilterSnapshotLoaded = true;
	const snap = allTimeFilterFileCache.tryLoadJson();
	// nmc-3.6.64: snapshot format v2. v1 snapshots hold capped (first-500)
	// match lists; they are ignored so the next summary walk recomputes
	// the full uncapped lists instead of serving stale partial lists.
	if (snap && typeof snap === "object" && snap.version === 2 && typeof snap.height === "number" && snap.counts && typeof snap.counts === "object") {
		allTimeFilterSnapshot = snap;
	}
	return allTimeFilterSnapshot;
}

// ---------------------------------------------------------------------------
// Names summary scanner.
//
// `gettxoutsetinfo.amount.names` reports total NMC LOCKED in name outputs.
// It does not give us a count of names. To get a count we have to walk
// `name_scan` (Namecoin Core has no `name_count` RPC). On a busy chain that
// can be a lot of pages — so this helper is intended to be called from a
// background interval task, never inline on a request render.
//
// Returns:
//   {
//     total:      <int>,           // every entry returned by name_scan
//     active:     <int>,           // total - expired
//     expired:    <int>,
//     byNamespace: { d: { total, active, expired }, id: {...}, ... },
//     expiringSoon:        [ { name, expires_in, height, value, value_encoding }, ... ],   // sorted closest-to-expiring first, capped
//     recentlyExpired:     [ { name, expires_in, height, value, value_encoding }, ... ],   // sorted most-recently-expired first, capped
//     expiringSoonTotal:   <int>,   // true count before capping
//     recentlyExpiredTotal:<int>,
//     expiringSoonBlocks:  <int>,   // window threshold (default 2016 ≈ 2 weeks)
//     recentlyExpiredBlocks:<int>,  // window threshold (default 2016 ≈ 2 weeks)
//     scannedAt:  <ms epoch>,
//     truncated:  <bool>,           // hit the per-prefix cap
//     elapsedMs:  <int>,
//     filterCountsAllTime: { <filterKey>: <int> } | null,   // active + expired counts
//     filterListsAllTime:  { <filterKey>: [name, ...] } | null,   // capped at filterAllTimeListCap
//     filterAllTimeHeight: <int> | null,   // chain tip the all-time pass last ran at
//     filterAllTimeRefreshed: <bool>,      // true when THIS run executed the all-time pass
//   }
// ---------------------------------------------------------------------------
async function getNamesSummary({ pageSize = 2000, perPrefixCap = 10000000, prefixes = null, filterListCap = Infinity, squatterTopN = 10, squatterSampleNames = 5, squatterMinCount = 2, squatterMaxValueLen = 4096, expiringSoonBlocks = 2016, recentlyExpiredBlocks = 2016, expiringListCap = 500, tipHeight = null, allTimeMinBlocks = ALLTIME_FILTER_MIN_BLOCKS, allTimeListCap = ALLTIME_FILTER_LIST_CAP } = {}) {
	const startedAt = Date.now();
	// Squatter clustering: group names by their EXACT value string. Names
	// registered in bulk by the same operator (typo-squat farms, parking
	// services, drainer farms, etc.) almost always reuse a single template
	// value across thousands of registrations. The largest cluster of
	// active names sharing one value is the "biggest current squatter";
	// the largest cluster across active+expired is the "biggest all-time
	// squatter". We accumulate per-value buckets here and rank them after
	// the scan finishes.
	//
	// Memory shape: a Map<valueKey, {count,activeCount,expiredCount,sampleNames:[],sampleNamesActive:[],byNamespace:{ns:count}}>.
	// `sampleNames` holds the first few names seen in scan order (active or
	// expired) and backs the all-time leaderboard; `sampleNamesActive` holds
	// only unexpired names and backs the "biggest current squatter" board,
	// where showing an expired sample would contradict the "currently active"
	// premise of the section.
	// Cluster keys are the raw value string truncated to squatterMaxValueLen
	// to bound memory; values longer than that are extremely rare on a 520-byte
	// chain anyway. Empty values ("") are skipped — newly-registered
	// (name_new) names have no value yet and would lump into a phantom giant
	// cluster otherwise.
	const clusters = new Map();
	// Import-aware filter index: name -> { tags: <Set of own value-shape
	// tags>, imports: [referenced name strings] | null }. Populated during
	// the walk for every ACTIVE name; after the walk, import references are
	// resolved transitively so a name like d/foo that imports dd/bar (which
	// carries e.g. a nostr block) is itself tagged nostr. Only active names
	// enter the index, so imports of expired/nonexistent names add no tags.
	const filterNameIndex = new Map();
	const summary = {
		total: 0,
		active: 0,
		expired: 0,
		byNamespace: {},
		filterCounts: Object.fromEntries(FILTER_KEYS.map(k => [k, 0])),
		filterLists: Object.fromEntries(FILTER_KEYS.map(k => [k, []])),
		filterListCap,
		// All-time (active + expired) filter counterparts. Filled in at the
		// end of the scan: freshly recomputed when the block-height cadence
		// fired this run, otherwise carried forward from the on-disk
		// snapshot. Null until the first all-time pass has ever completed.
		filterCountsAllTime: null,
		filterListsAllTime: null,
		filterAllTimeHeight: null,
		filterAllTimeTotal: null,
		filterAllTimeScannedAt: null,
		filterAllTimeListCap: allTimeListCap,
		filterAllTimeRefreshed: false,
		filterAllTimeElapsedMs: null,
		// Top-N squatter clusters by active count and by total (active+expired) count.
		// Filled in at the end of the scan.
		squattersCurrent: [],
		squattersAllTime: [],
		squatterTopN,
		squatterMinCount,
		squatterUniqueValues: 0,
		squatterClusteredNames: 0,
		// Expiry buckets, populated during the scan and sorted/capped at the end.
		// `expiringSoon` = active names with `expires_in` between 1 and
		// `expiringSoonBlocks` (closest-to-expiring first). `recentlyExpired` =
		// expired names whose `expires_in` is between `-recentlyExpiredBlocks`
		// and 0 (most-recently-expired first). The full per-name lists are
		// capped at `expiringListCap`; `expiringSoonTotal` /
		// `recentlyExpiredTotal` track the true counts so the UI can show e.g.
		// "showing first 500 of 1234".
		expiringSoon: [],
		recentlyExpired: [],
		expiringSoonTotal: 0,
		recentlyExpiredTotal: 0,
		expiringSoonBlocks,
		recentlyExpiredBlocks,
		expiringListCap,
		scannedAt: null,
		truncated: false,
		pagesScanned: 0,
		elapsedMs: 0,
	};

	// All-time pass gate: block-height-triggered, not time-triggered. When
	// the chain tip has advanced at least allTimeMinBlocks since the last
	// all-time run (or no all-time run has ever completed), this walk also
	// classifies EXPIRED names into a parallel index and the all-time
	// counts are recomputed at the end of the scan. On every other run the
	// summary just carries the previous snapshot forward, so the 30-min
	// walk pays no extra classifier cost.
	const priorAllTimeSnapshot = loadAllTimeFilterSnapshot();
	const collectAllTime = Number.isFinite(tipHeight)
		&& (!priorAllTimeSnapshot || (tipHeight - priorAllTimeSnapshot.height) >= allTimeMinBlocks);
	const filterNameIndexExpired = collectAllTime ? new Map() : null;
	// Set when a name_scan page fails terminally mid-walk: a partial walk
	// must not poison the all-time snapshot (it persists for ~36k blocks),
	// so the all-time pass is skipped on aborted scans.
	let scanAborted = false;

	// Default scan list. "" means "no prefix filter" — covers every namespace,
	// including ones we haven't enumerated explicitly. The cap is huge by
	// default (5M per prefix) because the entire chain has ~1.5M names today;
	// we only flip `truncated` when we genuinely run out of pages on a single
	// prefix, i.e. the chain has more names than the cap can paginate.
	const targets = prefixes && prefixes.length ? prefixes : [""];

	for (const prefix of targets) {
		let last = "";
		let firstPage = true;
		let pages = 0;
		const maxPages = Math.ceil(perPrefixCap / pageSize);
		let hitFullPageLimit = false;
		while (pages < maxPages) {
			// Explicit UTF-8 encoding for both name and value so rows with any
			// non-ASCII bytes come back with readable `.name` / `.value` strings.
			// Without this, namecoind defaults to "ascii" and returns
			// `name: null, name_encoding: "hex"` for non-ASCII names -- which then
			// breaks cursor advancement (walked-back-from-end fix in this same
			// function) AND makes non-ASCII values invisible to the value-shape
			// classifier. Binary values (nft/* chunks) still come back as
			// `value_encoding: "hex"` per-row, which the classifier's rawValue
			// path handles.
			const scanOpts = { nameEncoding: "utf8", valueEncoding: "utf8" };
			if (prefix) scanOpts.prefix = prefix;
			const params = [last, pageSize, scanOpts];
			let rows;
			try {
				rows = await rpcApi.getRpcDataWithParams({ method: "name_scan", parameters: params });
			} catch (_e1) {
				// Pre-0.19 fallback: retry without the options object so old nodes
				// (or nodes that reject unknown option keys strictly) still work,
				// at the cost of losing UTF-8 for this scan.
				const legacyParams = [last, pageSize];
				if (prefix) legacyParams.push({ prefix });
				try {
					rows = await rpcApi.getRpcDataWithParams({ method: "name_scan", parameters: legacyParams });
				} catch (_e2) {
					scanAborted = true;
					break;
				}
			}
			if (!Array.isArray(rows) || rows.length === 0) break;

			// Namecoin Core's `name_scan` cursor is INCLUSIVE — passing
			// `start="d/foo"` returns "d/foo" as the first row of the response.
			// On every page after the first we therefore need to drop row[0] to
			// avoid double-counting the name we passed as the cursor. Without
			// this, a 1.5M-name chain enumerates as ~5M with massive duplicates.
			const startIdx = firstPage ? 0 : 1;
			for (let i = startIdx; i < rows.length; i++) {
				const row = rows[i];
				if (!row || typeof row.name !== "string") continue;
				summary.total++;
				if (row.expired) summary.expired++;
				else summary.active++;
				const ns = splitNamespace(row.name).namespace || "(none)";
				if (!summary.byNamespace[ns]) summary.byNamespace[ns] = { total: 0, active: 0, expired: 0 };
				summary.byNamespace[ns].total++;
				if (row.expired) summary.byNamespace[ns].expired++;
				else summary.byNamespace[ns].active++;

				// Squatter clustering: every row with a non-empty value goes
				// into the cluster bucket keyed by its exact value (truncated).
				// We track active vs expired separately so we can rank by either.
				if (typeof row.value === "string" && row.value.length > 0) {
					const clusterKey = row.value.length > squatterMaxValueLen
						? row.value.substring(0, squatterMaxValueLen)
						: row.value;
					let bucket = clusters.get(clusterKey);
					if (!bucket) {
						bucket = { count: 0, activeCount: 0, expiredCount: 0, sampleNames: [], sampleNamesActive: [], byNamespace: {} };
						clusters.set(clusterKey, bucket);
					}
					bucket.count++;
					if (row.expired) bucket.expiredCount++;
					else bucket.activeCount++;
					if (bucket.sampleNames.length < squatterSampleNames) {
						bucket.sampleNames.push(row.name);
					}
					if (!row.expired && bucket.sampleNamesActive.length < squatterSampleNames) {
						bucket.sampleNamesActive.push(row.name);
					}
					bucket.byNamespace[ns] = (bucket.byNamespace[ns] || 0) + 1;
				}

				// Expiry tracking. `expires_in` is in blocks. For active names
				// it's positive (blocks until expiry); for expired names it's
				// zero or negative (blocks since expiry). We bucket each row
				// here and sort/cap after the scan finishes. We also capture
				// `value`/`value_encoding` so the UI can render a per-row Value
				// preview alongside Name/NS/Height/Expires-in.
				if (typeof row.expires_in === "number") {
					if (!row.expired && row.expires_in > 0 && row.expires_in <= expiringSoonBlocks) {
						summary.expiringSoonTotal++;
						summary.expiringSoon.push({
							name: row.name,
							expires_in: row.expires_in,
							height: row.height,
							value: row.value,
							value_encoding: row.value_encoding,
						});
					} else if (row.expired && row.expires_in <= 0 && row.expires_in >= -recentlyExpiredBlocks) {
						summary.recentlyExpiredTotal++;
						summary.recentlyExpired.push({
							name: row.name,
							expires_in: row.expires_in,
							height: row.height,
							value: row.value,
							value_encoding: row.value_encoding,
						});
					}
				}

				// Value-shape classification. Active names are always classified
				// so the filter counts reflect what's currently *resolvable*.
				// Expired names are classified only when the all-time pass is due
				// this run (filterNameIndexExpired non-null); they then feed the
				// all-time (active + expired) filter counts.
				// Counting is deferred until after the walk: a name that carries
				// only an `import` reference must inherit the imported value's
				// tags, which needs the whole-chain index built here.
				if (!row.expired || filterNameIndexExpired) {
					let parsed = null;
					if (typeof row.value === "string") {
						const trimmed = row.value.trim();
						if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
							try { parsed = JSON.parse(trimmed); } catch (_e) { /* not json */ }
						}
					}
					const ownTags = classifyNameValue(parsed, row.value, row.value_encoding);
					let importNames = null;
					if (parsed != null && typeof parsed === "object") {
						const found = collectAllImports(parsed);
						for (const f of found) {
							for (const imp of f.imports) {
								if (!imp.name || imp.name === row.name) continue;
								if (!importNames) importNames = [];
								if (!importNames.includes(imp.name)) importNames.push(imp.name);
							}
						}
					}
					if (!row.expired) filterNameIndex.set(row.name, { tags: ownTags, imports: importNames });
					else filterNameIndexExpired.set(row.name, { tags: ownTags, imports: importNames });
				}
			}

			// Cursor advancement: pick the LAST row whose `name` is a string we
			// can pass back to `name_scan`. Hex-encoded names (where the row has
			// no readable `name` field) would otherwise leave `last` undefined,
			// which `name_scan` interprets as "" and restarts the whole scan.
			// That's how a 700k-entry chain enumerated as 10M before this fix.
			let newLast = null;
			for (let i = rows.length - 1; i >= 0; i--) {
				if (rows[i] && typeof rows[i].name === "string") {
					newLast = rows[i].name;
					break;
				}
			}
			if (newLast === null || newLast === last) {
				// Either the page had no string-named row, or the cursor failed
				// to advance — either way, stop. Continuing would loop forever
				// or reset to the start.
				pages++;
				break;
			}
			last = newLast;
			firstPage = false;
			pages++;
			// `pageSize - 1` because the next page will drop its first row;
			// any short page after page 1 means we've reached the end.
			if (rows.length < pageSize) break;
			if (pages >= maxPages) {
				hitFullPageLimit = true;
			}
		}
		// Only mark truncated when we burned through every page allowed AND
		// the last page we saw was still full — i.e. there was demonstrably
		// more data on the chain than we had pages to fetch. Prior versions
		// also flipped truncated when the loop exited via `pages == maxPages`
		// even if the final partial-page break would have triggered on the
		// next iteration; the new check avoids that false positive.
		if (hitFullPageLimit) summary.truncated = true;
		summary.pagesScanned += pages;
	}

	// Resolve value-shape filter tags through `import` references, then
	// count. Memoized DFS with a cycle guard and a hard depth cap so
	// circular or pathological import chains can't wedge the scan. Cycles
	// resolve best-effort (the in-progress name contributes only its own
	// tags at the point the cycle closes), which is fine for a classifier.
	const filterTagMemo = new Map();
	const filterResolving = new Set();
	const FILTER_IMPORT_MAX_DEPTH = 16;
	function resolveFilterTags(name, depth) {
		const memoHit = filterTagMemo.get(name);
		if (memoHit) return memoHit;
		const rec = filterNameIndex.get(name);
		if (!rec) return null; // expired, or not present in this scan's index
		if (filterResolving.has(name) || depth >= FILTER_IMPORT_MAX_DEPTH) {
			return [...rec.tags];
		}
		filterResolving.add(name);
		const out = new Set(rec.tags);
		if (rec.imports) {
			for (const impName of rec.imports) {
				const inherited = resolveFilterTags(impName, depth + 1);
				if (inherited) for (const t of inherited) out.add(t);
			}
		}
		filterResolving.delete(name);
		const arr = [...out];
		filterTagMemo.set(name, arr);
		return arr;
	}
	// Shared counting path for the active and all-time filter passes, so
	// the two can never drift apart: applies the namespace split for the
	// coin-address filters (btc / nmc / bitmessage also tag <filter>-<ns>
	// using the listed name's own namespace; an importer of a name
	// carrying an address is counted under the importer's namespace,
	// matching how the combined filters list it), then counts the name
	// under every final tag. NOTE: finalTags is mutated in place
	// (namespace tags appended); callers must pass a private copy, never
	// the memoized resolveFilterTags array.
	function tallyFilterName(name, finalTags, counts, lists, listCap) {
		if (finalTags.includes("btc") || finalTags.includes("nmc") || finalTags.includes("bitmessage")) {
			const ns = _filterNamespace(name);
			if (finalTags.includes("btc")) finalTags.push(`btc-${ns}`);
			if (finalTags.includes("nmc")) finalTags.push(`nmc-${ns}`);
			if (finalTags.includes("bitmessage")) finalTags.push(`bitmessage-${ns}`);
		}
		for (const tag of finalTags) {
			counts[tag]++;
			if (lists[tag].length < listCap) {
				lists[tag].push(name);
			}
		}
	}
	for (const [name, rec] of filterNameIndex.entries()) {
		// Copy the resolved tags: resolveFilterTags returns the memoized
		// array, and the namespace split below must never leak into it (an
		// importer of this name would otherwise inherit its namespace tag).
		const resolved = rec.imports ? resolveFilterTags(name, 0) : rec.tags;
		const finalTags = resolved ? [...resolved] : [];
		// Active filter lists are uncapped: every list is bounded by the
		// active-name count and stores references to name strings that
		// already live in filterNameIndex, so the extra memory is just
		// array slots (a few MB worst case) and filter pages can always
		// render the complete match list.
		tallyFilterName(name, finalTags, summary.filterCounts, summary.filterLists, filterListCap);
	}

	// All-time filter pass (active + expired). Reuses the exact same
	// classifier output and counting path as the active pass above so the
	// two can never drift apart. Caveat: import resolution for an EXPIRED
	// name resolves against current (active) values only -
	// resolveFilterTags looks imports up in the active-only index, so an
	// expired name that imports another expired name inherits no tags.
	// Counts are exact and, since nmc-3.6.64, per-filter match lists are
	// uncapped: every name string is already held by the scan indexes, so
	// the lists cost only array slots and the filter pages render the
	// complete all-time match set.
	if (filterNameIndexExpired && !scanAborted) {
		const allTimeStartedAt = Date.now();
		const atCounts = Object.fromEntries(FILTER_KEYS.map(k => [k, 0]));
		const atLists = Object.fromEntries(FILTER_KEYS.map(k => [k, []]));
		for (const [name, rec] of filterNameIndex.entries()) {
			const resolved = rec.imports ? resolveFilterTags(name, 0) : rec.tags;
			tallyFilterName(name, resolved ? [...resolved] : [], atCounts, atLists, allTimeListCap);
		}
		for (const [name, rec] of filterNameIndexExpired.entries()) {
			let baseTags;
			if (rec.imports) {
				const out = new Set(rec.tags);
				for (const impName of rec.imports) {
					const inherited = resolveFilterTags(impName, 0);
					if (inherited) for (const t of inherited) out.add(t);
				}
				baseTags = [...out];
			} else {
				baseTags = [...rec.tags];
			}
			tallyFilterName(name, baseTags, atCounts, atLists, allTimeListCap);
		}
		const snap = {
			version: 2,
			height: tipHeight,
			scannedAt: Date.now(),
			elapsedMs: Date.now() - allTimeStartedAt,
			listCap: allTimeListCap,
			total: summary.total,
			active: summary.active,
			expired: summary.expired,
			counts: atCounts,
			lists: atLists,
		};
		try {
			allTimeFilterFileCache.writeJson(snap);
		} catch { /* the in-memory copy below still takes effect */ }
		allTimeFilterSnapshot = snap;
		allTimeFilterSnapshotLoaded = true;
		summary.filterAllTimeRefreshed = true;
		summary.filterAllTimeElapsedMs = snap.elapsedMs;
	}

	// Carry the all-time snapshot (freshly recomputed or previous) onto
	// the summary so /utxo-set can render the all-time tiles with their
	// as-of height.
	if (allTimeFilterSnapshot && allTimeFilterSnapshot.counts) {
		summary.filterCountsAllTime = allTimeFilterSnapshot.counts;
		summary.filterListsAllTime = allTimeFilterSnapshot.lists || null;
		summary.filterAllTimeHeight = allTimeFilterSnapshot.height;
		summary.filterAllTimeTotal = allTimeFilterSnapshot.total != null ? allTimeFilterSnapshot.total : null;
		summary.filterAllTimeScannedAt = allTimeFilterSnapshot.scannedAt || null;
		if (allTimeFilterSnapshot.listCap != null) summary.filterAllTimeListCap = allTimeFilterSnapshot.listCap;
	}

	// Rank clusters into top-N for both "current" (active only) and
	// "all-time" (active + expired) leaderboards. We only keep buckets at or
	// above squatterMinCount; a single-name "cluster" is by definition not a
	// squatter pattern, just a regular name. Ties are broken by total count
	// (so two clusters with equal active counts are ordered by all-time scope).
	summary.squatterUniqueValues = clusters.size;
	const clusterArr = [];
	for (const [valueKey, bucket] of clusters.entries()) {
		if (bucket.count < squatterMinCount) continue;
		summary.squatterClusteredNames += bucket.count;
		clusterArr.push({
			value: valueKey,
			valueLength: valueKey.length,
			count: bucket.count,
			activeCount: bucket.activeCount,
			expiredCount: bucket.expiredCount,
			sampleNames: bucket.sampleNames,
			sampleNamesActive: bucket.sampleNamesActive,
			byNamespace: bucket.byNamespace,
		});
	}
	// Current squatters: rank by active count desc, then total desc. Sample
	// names come from the active-only list: scan order is lexicographic, not
	// active-first, so the generic `sampleNames` list can be front-loaded with
	// expired names that would misrepresent a "currently active" leaderboard.
	summary.squattersCurrent = clusterArr
		.filter(c => c.activeCount >= squatterMinCount)
		.slice() // shallow copy before sort
		.sort((a, b) => (b.activeCount - a.activeCount) || (b.count - a.count))
		.slice(0, squatterTopN)
		.map(c => ({ ...c, sampleNames: c.sampleNamesActive }));
	// All-time squatters: rank by total count desc, then active desc.
	summary.squattersAllTime = clusterArr
		.slice()
		.sort((a, b) => (b.count - a.count) || (b.activeCount - a.activeCount))
		.slice(0, squatterTopN);

	// Sort + cap the expiry buckets. `expiringSoon` is closest-to-expiring
	// first (smallest positive `expires_in` first); `recentlyExpired` is
	// most-recently-expired first (largest `expires_in` first, i.e. closest
	// to zero — the least negative). Both lists are then truncated to
	// `expiringListCap` so a chain with millions of expiring names can't blow
	// up the in-memory summary; the totals stay accurate via the
	// `*Total` fields.
	summary.expiringSoon.sort((a, b) => a.expires_in - b.expires_in);
	if (summary.expiringSoon.length > expiringListCap) {
		summary.expiringSoon = summary.expiringSoon.slice(0, expiringListCap);
	}
	summary.recentlyExpired.sort((a, b) => b.expires_in - a.expires_in);
	if (summary.recentlyExpired.length > expiringListCap) {
		summary.recentlyExpired = summary.recentlyExpired.slice(0, expiringListCap);
	}

	// nmc-3.6.59: persistent name-op tx index. The shared instance starts
	// (once) alongside the first summary walk, and every summary run kicks
	// the tail indexer so newly confirmed blocks are indexed promptly. The
	// full-chain backfill continues gently on the module's own throttled
	// loop (batch + sleep), so this 30-min walk keeps RPC priority. All
	// failures are captured in the index status - a tx-index hiccup must
	// never fail the summary walk.
	try {
		const nameTxIndex = require("./nameTxIndex.js");
		nameTxIndex.startShared({ logger: debugLog });
		nameTxIndex.indexNewBlocks().catch(() => { /* recorded in index status */ });
	} catch (e) {
		debugLog("nameTxIndex wiring error: " + e.message);
	}

	summary.scannedAt = Date.now();
	summary.elapsedMs = summary.scannedAt - startedAt;
	return summary;
}

// ---------------------------------------------------------------------------
// reconstructNameHistory(name, { coreApi, maxSteps })
//
// Returns the full operational history of a Namecoin name as an array of
//   { op, value, value_encoding, height, txid, vout, blockhash, blocktime }
// entries, ordered firstupdate-first (oldest → newest, matching the layout
// `name_history` itself uses when `-namehistory` is enabled). This is a
// best-effort fallback for nodes that DO NOT have `-namehistory` set: every
// Namecoin name is a chain of UTXOs (`name_firstupdate → name_update →
// name_update → … → current`), with each subsequent update tx spending
// exactly one prior name-output and creating exactly one new name-output, so
// we can walk the chain backwards from the current `name_show` tip.
//
// Requirements on the upstream node:
//   - `-txindex=1` (so `getrawtransaction <txid>` resolves arbitrary txids);
//     without txindex the walk cannot resolve the prevout txs and we fall back
//     to whatever single entry `name_show` already gave us.
//
// The walk is bounded by `maxSteps` (default 5000) for safety against
// pathological loops; in practice even very long-lived names (>10y) sit in
// the low-thousands of updates.
// ---------------------------------------------------------------------------
async function reconstructNameHistory(name, { coreApi = null, maxSteps = 5000 } = {}) {
	const _coreApi = coreApi || require("./coreApi");
	const startedAt = Date.now();
	let entries = [];
	let warnings = [];

	let showInfo;
	try {
		showInfo = await nameShow(name);
	} catch (e) {
		return { entries: [], reconstructed: false, warnings: [`name_show failed: ${e.message || e}`], elapsedMs: Date.now() - startedAt };
	}
	if (!showInfo || !showInfo.txid) {
		return { entries: [], reconstructed: false, warnings: ["name_show returned no txid"], elapsedMs: Date.now() - startedAt };
	}

	let curTxid = showInfo.txid;
	let curVout = typeof showInfo.vout === "number" ? showInfo.vout : null;
	let curBlockhash = null;
	if (typeof showInfo.height === "number" && showInfo.height >= 0) {
		try { curBlockhash = await _coreApi.getBlockHashByHeight(showInfo.height); } catch (_e) { /* ignore */ }
	}

	let step = 0;
	while (curTxid && step < maxSteps) {
		step++;
		let tx;
		try {
			tx = await _coreApi.getRawTransaction(curTxid, curBlockhash || undefined);
		} catch (e) {
			warnings.push(`getrawtransaction ${curTxid} failed: ${e.message || e}`);
			break;
		}
		if (!tx || !Array.isArray(tx.vout)) {
			warnings.push(`tx ${curTxid} had no vout`);
			break;
		}

		// Find THIS tx's name-output for our name. There can be at most one
		// (Namecoin consensus) but we still match by name to defend against
		// txs that carry name ops for unrelated names alongside ours.
		let nameOut = null;
		let nameOutIdx = -1;
		for (let i = 0; i < tx.vout.length; i++) {
			const v = tx.vout[i];
			const no = v && v.scriptPubKey && v.scriptPubKey.nameOp;
			if (no && no.name === name) {
				nameOut = v;
				nameOutIdx = i;
				break;
			}
		}
		if (!nameOut) {
			// Couldn't find the name op on this tx — dead end.
			warnings.push(`tx ${curTxid} carries no name op for ${name}`);
			break;
		}
		const nameOp = nameOut.scriptPubKey.nameOp;

		// Resolve this tx's height/blockhash. `getrawtransaction <txid> 1`
		// returns `blockhash` whenever the tx is confirmed; we then convert
		// that to a height via `getblockheader`.
		let thisHeight = null;
		let thisBlockhash = tx.blockhash || curBlockhash || null;
		if (thisBlockhash) {
			try {
				const hdr = await _coreApi.getBlockHeaderByHash(thisBlockhash);
				if (hdr && typeof hdr.height === "number") thisHeight = hdr.height;
			} catch (_e) { /* leave height null */ }
		}

		entries.push({
			op: nameOp.op || null,
			name: nameOp.name || name,
			value: nameOp.value || null,
			value_encoding: nameOp.value_encoding || null,
			height: thisHeight,
			txid: curTxid,
			vout: nameOutIdx,
			blockhash: thisBlockhash,
			blocktime: tx.blocktime || tx.time || null,
		});

		// `name_firstupdate` is the chain start (its input is the matching
		// `name_new`, which carries only a salted commitment hash and no
		// human-readable name). Stop here.
		if (nameOp.op === "name_firstupdate") break;

		// Walk back one step: find the input that spent a prior `name_update`
		// or `name_firstupdate` output for THIS name. There is exactly one
		// such input on a well-formed name update; we still scan all inputs
		// and pick the first match for resilience.
		let foundPrev = null;
		for (const vin of (tx.vin || [])) {
			if (!vin || !vin.txid || typeof vin.vout !== "number") continue;
			let prevTx;
			try {
				prevTx = await _coreApi.getRawTransaction(vin.txid);
			} catch (_e) {
				// txindex likely off, or pruned — skip this input.
				continue;
			}
			if (!prevTx || !Array.isArray(prevTx.vout)) continue;
			const prevOut = prevTx.vout[vin.vout];
			const prevNameOp = prevOut && prevOut.scriptPubKey && prevOut.scriptPubKey.nameOp;
			if (prevNameOp && prevNameOp.name === name) {
				foundPrev = { txid: vin.txid, vout: vin.vout, blockhash: prevTx.blockhash || null };
				break;
			}
		}
		if (!foundPrev) {
			warnings.push(`could not locate prior name UTXO from tx ${curTxid} (txindex disabled or pruned?)`);
			break;
		}
		curTxid = foundPrev.txid;
		curVout = foundPrev.vout;
		curBlockhash = foundPrev.blockhash;
	}

	// Return firstupdate-first, matching `name_history` ordering.
	entries.reverse();
	return {
		entries,
		reconstructed: true,
		steps: step,
		maxSteps,
		warnings,
		elapsedMs: Date.now() - startedAt,
	};
}

// ---------------------------------------------------------------------------
// classifyNameTx(tx)
//
// Classify one decoded transaction for refreshNameTxStats in app.js. Keep the
// legacy nameTx decision based on op-bearing outputs, while separately tracking
// every nameOp payload for the stricter non-name, non-coinbase currency metric.
// ---------------------------------------------------------------------------
function classifyNameTx(tx) {
	const nameOps = [];
	let hasNameOpOutput = false;
	if (tx && Array.isArray(tx.vout)) {
		for (const out of tx.vout) {
			const no = out && out.scriptPubKey && out.scriptPubKey.nameOp;
			if (!no) continue;
			hasNameOpOutput = true;
			if (no.op) nameOps.push(no.op);
		}
	}
	const isCoinbase = Boolean(tx && Array.isArray(tx.vin) && tx.vin.some((input) => input && input.coinbase !== undefined));
	return {
		nameOps,
		hasNameOp: nameOps.length > 0,
		hasNameOpOutput,
		isCoinbase,
		isCurrencyExcludingCoinbase: !hasNameOpOutput && !isCoinbase,
	};
}

// ---------------------------------------------------------------------------
// getRecentNameFirstUpdates({ windowBlocks, listCap, perBlockCap })
//
// Walks the last `windowBlocks` blocks (default 2016 ≈ 2 weeks at 10 min/block,
// matching the expiry windows used elsewhere on /names) and collects every
// `name_firstupdate` operation found in those blocks. firstupdates are the
// only op that creates a brand-new name on the chain (a `name_new` only
// pre-commits a salted hash; the name does not exist on-chain until the
// firstupdate confirms ~12 blocks later), so this list is the canonical
// answer to "which names were registered in the last N blocks".
//
// Implementation: one `getblock <hash> 2` RPC per block. NMC's getblock
// verbosity-2 returns fully-decoded transactions WITH their
// `scriptPubKey.nameOp` payload, so we can extract every name op without a
// second `getrawtransaction` round-trip. firstupdates are extremely rare on
// the current chain (often 0-2 per 2016-block window), so the work is
// dominated by the block fetch itself, not by post-processing. Block results
// hit the existing 15-minute coreApi blockCache, so a 30-minute refresh that
// repeats a window only pays the full RPC cost on the first run after each
// new block confirms.
//
// Returns:
//   {
//     items: [
//       { name, value, value_encoding, height, txid, vout, blocktime },
//       ...
//     ],   // newest-block-first; capped at listCap
//     total:        <int>,    // true count before capping
//     windowBlocks: <int>,    // window threshold actually used
//     fromHeight:   <int>,    // inclusive
//     toHeight:     <int>,    // inclusive (chain tip at scan time)
//     scannedAt:    <ms epoch>,
//     elapsedMs:    <int>,
//     truncated:    <bool>,   // listCap hit
//   }
// ---------------------------------------------------------------------------
async function getRecentNameFirstUpdates({ windowBlocks = 2016, listCap = 500, perBlockCap = 5000, coreApi = null } = {}) {
	// Lazy-require coreApi to dodge the circular import: nameApi is loaded by
	// coreApi at module-init time, so a top-level `require("./coreApi")` here
	// would resolve to a half-initialised module and break getBlockByHeight.
	// Callers can also inject a pre-resolved coreApi for testing.
	const _coreApi = coreApi || require("./coreApi");
	const startedAt = Date.now();
	const tip = await _coreApi.getBlockchainInfo();
	const toHeight = tip && typeof tip.blocks === "number" ? tip.blocks : null;
	if (toHeight === null) {
		return { items: [], total: 0, windowBlocks, fromHeight: null, toHeight: null, scannedAt: Date.now(), elapsedMs: Date.now() - startedAt, truncated: false };
	}
	const fromHeight = Math.max(0, toHeight - windowBlocks + 1);

	const items = [];
	let total = 0;
	let truncated = false;

	// Walk newest-first so the listCap (when hit) keeps the most-recent
	// firstupdates rather than the oldest ones in the window.
	for (let h = toHeight; h >= fromHeight; h--) {
		let block;
		try {
			block = await _coreApi.getBlockByHeight(h);
		} catch (_e) {
			continue;
		}
		if (!block || !Array.isArray(block.tx)) continue;
		let perBlock = 0;
		for (const tx of block.tx) {
			// `getblock <hash> 2` returns full tx objects on NMC; older or
			// non-NMC paths may return bare txid strings. We only care about
			// the verbose form here — bare strings have no nameOp metadata.
			if (!tx || !Array.isArray(tx.vout)) continue;
			for (let vi = 0; vi < tx.vout.length; vi++) {
				const out = tx.vout[vi];
				const nameOp = out && out.scriptPubKey && out.scriptPubKey.nameOp;
				if (!nameOp || nameOp.op !== "name_firstupdate") continue;
				total++;
				perBlock++;
				if (perBlock > perBlockCap) {
					// Defensive: a single block with thousands of firstupdates is
					// not seen in practice, but cap to keep memory bounded.
					truncated = true;
					break;
				}
				if (items.length < listCap) {
					items.push({
						name: nameOp.name || null,
						name_encoding: nameOp.name_encoding || null,
						value: nameOp.value || null,
						value_encoding: nameOp.value_encoding || null,
						height: block.height,
						txid: tx.txid,
						vout: vi,
						blocktime: block.time || block.mediantime || null,
					});
				} else {
					truncated = true;
				}
			}
		}
	}
	return {
		items,
		total,
		windowBlocks,
		fromHeight,
		toHeight,
		scannedAt: Date.now(),
		elapsedMs: Date.now() - startedAt,
		truncated,
	};
}

// ---------------------------------------------------------------------------
// getOldestActiveNames({ windowBlocks, fromHeight, listCap, perBlockCap, batchSize, coreApi })
//
// Companion to `getRecentNameFirstUpdates`, but answers the OPPOSITE question:
// "which names registered longest ago are still active right now?". This is
// the canonical "longest-established names" view that pure `name_scan` cannot
// answer (it only returns the LAST update height, not the original
// `name_firstupdate` height — those two are unrelated for any name that has
// ever been renewed). The only way to know a name's true registration block
// is to look at its `name_firstupdate` op directly.
//
// Strategy: walk blocks oldest-first, collect every `name_firstupdate` op,
// and (interleaved per batch) hit `nameShow` to filter down to ones that
// are still active (not expired). Sorted ascending by firstupdate height so
// the OLDEST surviving registrations bubble to the top, and we EARLY-EXIT
// the whole walk as soon as we have `listCap` confirmed-active names —
// since we're already walking oldest-first, the first listCap actives we
// find ARE the oldest in the chain.
//
// Defaults:
//   windowBlocks: null  → scan the entire chain from genesis to tip.
//                       Pass a positive integer to limit the walk to the
//                       last N blocks (the legacy "last 1 year" behaviour).
//   fromHeight:   null  → starts at max(0, tip - windowBlocks + 1) when
//                       windowBlocks is set, or 0 otherwise. Pass an explicit
//                       integer to override (useful for ops who want to skip
//                       the very early chain on a fresh node).
//   listCap:      50    → max items returned. Phase 2 stops calling name_show
//                       once we've confirmed this many actives.
//   batchSize:    64    → blocks fetched in parallel per batch via
//                       getBlocksByHeight. Block fetches hit the 15-min
//                       coreApi blockCache on subsequent refreshes so the
//                       steady-state cost is dominated by new-tip blocks.
//
// Costs (cold first run, scanning the whole NMC chain):
//   - O(tipHeight) `getblock <hash> 2` calls, batched 64 at a time, all
//     served from cache on subsequent refreshes.
//   - At most `listCap` name_show calls in the common case (early exit).
//     If the listCap is set higher than the number of still-active names
//     ever registered we walk the whole chain and call name_show once per
//     candidate; that's the legacy upper bound.
//
// Returns:
//   {
//     items: [
//       { name, value, value_encoding, height, txid, vout, blocktime,
//         expires_in, address },   // sorted ASC by height (oldest first)
//       ...
//     ],   // length capped at listCap
//     totalCandidates: <int>,        // firstupdates seen in the scan range
//     totalActive:     <int|null>,   // active count, or null when we early-exited
//     windowBlocks:    <int|null>,   // null when scanning entire chain from genesis
//     fromHeight:      <int>,
//     toHeight:        <int>,
//     scannedAt:       <ms epoch>,
//     elapsedMs:       <int>,
//     truncated:       <bool>,       // listCap < totalActive (or early-exit)
//     earlyExit:       <bool>,       // stopped scan once listCap actives found
//   }
// ---------------------------------------------------------------------------
async function getOldestActiveNames({ windowBlocks = null, fromHeight: fromHeightOpt = null, listCap = 50, perBlockCap = 5000, batchSize = 64, coreApi = null } = {}) {
	// Lazy-require coreApi to dodge the circular import (same reason as
	// getRecentNameFirstUpdates above).
	const _coreApi = coreApi || require("./coreApi");
	const startedAt = Date.now();
	const tip = await _coreApi.getBlockchainInfo();
	const toHeight = tip && typeof tip.blocks === "number" ? tip.blocks : null;
	if (toHeight === null) {
		return { items: [], totalCandidates: 0, totalActive: 0, windowBlocks, fromHeight: null, toHeight: null, scannedAt: Date.now(), elapsedMs: Date.now() - startedAt, truncated: false, earlyExit: false };
	}

	// Resolve scan start height. Priority:
	//   1. explicit fromHeightOpt (env-var override path),
	//   2. windowBlocks-based clamp (legacy "last N blocks" behaviour),
	//   3. genesis (when both null) — the new default, scans entire chain.
	let fromHeight;
	if (Number.isFinite(fromHeightOpt) && fromHeightOpt >= 0) {
		fromHeight = Math.min(fromHeightOpt, toHeight);
	} else if (Number.isFinite(windowBlocks) && windowBlocks > 0) {
		fromHeight = Math.max(0, toHeight - windowBlocks + 1);
	} else {
		fromHeight = 0;
	}

	// Interleaved phase1+phase2 walk. Process blocks in batches of
	// `batchSize` (parallel `getblock` via coreApi.getBlocksByHeight) so we
	// get parallel cache fills on the cold first run. After every batch we
	// drain the candidates accumulated in that batch through name_show; as
	// soon as `items` reaches `listCap` we early-exit the entire walk.
	const items = [];
	let totalCandidates = 0;
	let totalActive = 0;
	let earlyExit = false;

	outer: for (let h0 = fromHeight; h0 <= toHeight; h0 += batchSize) {
		const h1 = Math.min(h0 + batchSize - 1, toHeight);
		const heights = [];
		for (let h = h0; h <= h1; h++) heights.push(h);
		let batchBlocks;
		try {
			batchBlocks = await _coreApi.getBlocksByHeight(heights);
		} catch (_e) {
			continue;
		}

		// Collect candidates in this batch (oldest-first within the batch).
		const batchCandidates = [];
		for (const block of batchBlocks) {
			if (!block || !Array.isArray(block.tx)) continue;
			let perBlock = 0;
			for (const tx of block.tx) {
				if (!tx || !Array.isArray(tx.vout)) continue;
				for (let vi = 0; vi < tx.vout.length; vi++) {
					const out = tx.vout[vi];
					const nameOp = out && out.scriptPubKey && out.scriptPubKey.nameOp;
					if (!nameOp || nameOp.op !== "name_firstupdate") continue;
					if (perBlock >= perBlockCap) break;
					perBlock++;
					totalCandidates++;
					batchCandidates.push({
						name: nameOp.name || null,
						name_encoding: nameOp.name_encoding || null,
						value_at_firstupdate: nameOp.value || null,
						value_encoding_at_firstupdate: nameOp.value_encoding || null,
						height: block.height,
						txid: tx.txid,
						vout: vi,
						blocktime: block.time || block.mediantime || null,
					});
				}
			}
		}

		// Drain this batch's candidates oldest-first via name_show.  Run
		// the lookups with bounded parallelism via pMap, but preserve
		// oldest-first order in the items array so early-exit still picks
		// the genuinely oldest registrations first.
		const utils = require("../utils.js");
		const nameShowConcurrency = Math.max(1, Math.min(8, batchCandidates.length || 1));
		const results = await utils.pMap(batchCandidates, async (cand) => {
			if (!cand.name) return null;
			return { cand, res: await nameShowActive(cand.name) };
		}, { concurrency: nameShowConcurrency });

		for (const r of results) {
			if (!r || !r.res) continue;
			const { cand, res } = r;
			if (!res.ok) continue;   // absent (expired/never-existed) OR persistent RPC blip
			const info = res.info;
			totalActive++;
			if (items.length < listCap) {
				items.push({
					name: cand.name,
					name_encoding: cand.name_encoding,
					// CURRENT value (post any updates) — more useful than the
					// firstupdate-time value for a "these names still exist" view.
					value: info.value != null ? info.value : null,
					value_encoding: info.value_encoding != null ? info.value_encoding : null,
					height: cand.height,            // firstupdate height (the answer)
					last_update_height: typeof info.height === "number" ? info.height : null,
					txid: cand.txid,
					vout: cand.vout,
					blocktime: cand.blocktime,
					expires_in: typeof info.expires_in === "number" ? info.expires_in : null,
					address: info.address || null,
				});
				if (items.length >= listCap) {
					earlyExit = true;
					break outer;
				}
			}
		}
	}

	return {
		items,
		totalCandidates,
		// When we early-exited we did not enumerate all actives, so the
		// total active count from THIS scan is unknown. Surface as null so
		// the UI can fall back to namesSummary.active or hide the count.
		totalActive: earlyExit ? null : totalActive,
		windowBlocks,
		fromHeight,
		toHeight,
		scannedAt: Date.now(),
		elapsedMs: Date.now() - startedAt,
		truncated: earlyExit || totalActive > items.length,
		earlyExit,
	};
}

// ---------------------------------------------------------------------------
// Namecoin mainnet expiration window for name UTXOs. After block 48000 every
// name expires `NAME_EXPIRATION_DEPTH` blocks after its last name op (see
// `src/consensus/params.h` `MainNetConsensus::NameExpirationDepth`). We use
// this as a *lower bound* heuristic for cycle-boundary detection in name
// history: if two consecutive history rows are more than this many blocks
// apart, the name MUST have expired in between and been re-registered, so
// the later row is necessarily a `name_firstupdate` opening a new cycle.
//
// (Early-chain names with 12000-block expiry don't matter here: by block
// 48000 the depth is already pegged at 36000, and any history row above
// 48000 with a >36000-block gap from its predecessor is unambiguously
// post-expiration. We tx-verify anyway so the heuristic only triggers when
// the on-chain op is genuinely `name_firstupdate`.)
// ---------------------------------------------------------------------------
const NAME_EXPIRATION_DEPTH = 36000;

// ---------------------------------------------------------------------------
// expandNameLifecycle(name, history, { coreApi })
//
// Given a `name` and the `history` array we already have for it (from either
// the `name_history` RPC or from `reconstructNameHistory`), produce the FULL
// op chain across EVERY registration cycle by filling in the two ops that
// `name_history` always omits:
//
//   1. Each cycle's `name_firstupdate`. `name_history` returns the value
//      *snapshot* at every name op but flags none of them — every entry
//      looks like a `name_update` from the outside. We tx-verify the
//      oldest row plus every row that opens a fresh cycle (gap >
//      NAME_EXPIRATION_DEPTH from its predecessor) and re-label them as
//      `name_firstupdate` when the on-chain op confirms it.
//
//   2. Each cycle's `name_new`. `name_new` pre-commits a salted hash of the
//      name (rand + name) ~12+ blocks before its matching firstupdate
//      reveals it. The op carries no name field, only the hash; the only
//      reliable way to find it is to follow the firstupdate's vin chain.
//
// This means a name that was registered, expired, re-registered, expired
// again, ... gets its FULL multi-cycle history rendered, with each cycle's
// pre-commit + reveal explicitly labelled and the gap to the next cycle
// shown as a visible discontinuity. Only the very first cycle's `name_new`
// can be missed (when the firstupdate's input is a prevout we can no longer
// resolve — txindex disabled or pruned — for example because we're walking
// back into very-early chain history).
//
// Returns:
//   {
//     ops: [    // oldest-first; each op carries `cycleIndex` (0 = oldest)
//       { kind: "name_new",         txid, vout, height, blocktime, hash, rand, cycleIndex },
//       { kind: "name_firstupdate", txid, vout, height, blocktime, value, value_encoding, rand, hash, cycleIndex },
//       { kind: "name_update",      txid, vout, height, blocktime, value, value_encoding, cycleIndex },
//       ...
//     ],
//     cycles: [    // oldest-first, one per detected registration cycle
//       { cycleIndex, startedAtNew, startedAtFirstupdate, lastOpHeight,
//         hasPriorExpiration, priorCycleLastOpHeight,
//         priorCycleExpiredAt },
//       ...
//     ],
//     // Legacy fields — refer to the CURRENT (latest) cycle for backward
//     // compatibility with templates/callers that only knew about one cycle:
//     cycleStartedAtNew:         <height of latest cycle's name_new, or null>,
//     cycleStartedAtFirstupdate: <height of latest cycle's firstupdate, or null>,
//     ageBlocks:                 <tipHeight - cycleStartedAtFirstupdate, caller-stamped>,
//     warnings:                  [<string>, ...],
//     elapsedMs:                 <int>,
//   }
// ---------------------------------------------------------------------------
async function expandNameLifecycle(name, history, { coreApi = null } = {}) {
	const _coreApi = coreApi || require("./coreApi");
	const startedAt = Date.now();
	const warnings = [];

	if (!Array.isArray(history) || history.length === 0) {
		return { ops: [], cycles: [], cycleStartedAtNew: null, cycleStartedAtFirstupdate: null, ageBlocks: null, warnings: ["empty history; cannot expand"], elapsedMs: Date.now() - startedAt };
	}

	// Sort entries by height ascending so sorted[0] is the oldest known row.
	// We don't mutate the caller's array.
	const sorted = history.slice().filter(e => e && typeof e.txid === "string").sort((a, b) => {
		const ha = typeof a.height === "number" ? a.height : Number.POSITIVE_INFINITY;
		const hb = typeof b.height === "number" ? b.height : Number.POSITIVE_INFINITY;
		return ha - hb;
	});
	if (sorted.length === 0) {
		return { ops: [], cycles: [], cycleStartedAtNew: null, cycleStartedAtFirstupdate: null, ageBlocks: null, warnings: ["history has no usable entries"], elapsedMs: Date.now() - startedAt };
	}

	// ---------------------------------------------------------------------
	// Phase 0: identify cycle-boundary candidates.
	//
	// `name_history` returns every value snapshot for the name with no `op`
	// field, so we can't trust the rows' apparent labels. Candidates for
	// fresh-cycle openers are:
	//   - row 0 (always; we have to figure out whether it's a firstupdate
	//     or a mid-cycle update),
	//   - any row whose height jumped NAME_EXPIRATION_DEPTH or more blocks
	//     past its predecessor (the name MUST have expired in between, so
	//     the later row HAS to be a fresh `name_firstupdate`). A gap of
	//     exactly NAME_EXPIRATION_DEPTH means the name expired at the same
	//     block the later tx landed; only a firstupdate (re-registration)
	//     is valid at that height, a name_update would fail consensus.
	//
	// We tx-verify each candidate. When the on-chain op is genuinely
	// `name_firstupdate`, we open a new cycle at that row and walk its vin
	// to inject the matching `name_new`.
	// ---------------------------------------------------------------------
	const boundaryIdx = [0];
	for (let i = 1; i < sorted.length; i++) {
		const h0 = sorted[i - 1].height;
		const h1 = sorted[i].height;
		if (typeof h0 === "number" && typeof h1 === "number" && (h1 - h0) >= NAME_EXPIRATION_DEPTH) {
			boundaryIdx.push(i);
		}
	}

	// ---------------------------------------------------------------------
	// Helpers shared by every cycle opener.
	// ---------------------------------------------------------------------
	async function fetchNameOp(txid) {
		let tx;
		try { tx = await _coreApi.getRawTransaction(txid); }
		catch (e) { warnings.push(`getrawtransaction ${txid} failed: ${e.message || e}`); return null; }
		if (!tx || !Array.isArray(tx.vout)) return null;
		let vi = -1, nop = null;
		for (let i = 0; i < tx.vout.length; i++) {
			const candidate = tx.vout[i] && tx.vout[i].scriptPubKey && tx.vout[i].scriptPubKey.nameOp;
			if (candidate && candidate.name === name) { vi = i; nop = candidate; break; }
		}
		let height = null;
		if (tx.blockhash) {
			try {
				const hdr = await _coreApi.getBlockHeaderByHash(tx.blockhash);
				if (hdr && typeof hdr.height === "number") height = hdr.height;
			} catch (_e) { /* ignore */ }
		}
		return { tx, vi, nop, height, blockhash: tx.blockhash || null, blocktime: tx.blocktime || tx.time || null };
	}

	async function findNameNewForFirstupdate(firstupdateTxid) {
		let firstupdateTx;
		try { firstupdateTx = await _coreApi.getRawTransaction(firstupdateTxid); }
		catch (e) { warnings.push(`getrawtransaction ${firstupdateTxid} failed: ${e.message || e}`); return null; }
		if (!firstupdateTx || !Array.isArray(firstupdateTx.vin)) return null;
		for (const vin of firstupdateTx.vin) {
			if (!vin || !vin.txid || typeof vin.vout !== "number") continue;
			let prevTx;
			try { prevTx = await _coreApi.getRawTransaction(vin.txid); } catch (_e) { continue; }
			if (!prevTx || !Array.isArray(prevTx.vout)) continue;
			const prevNop = prevTx.vout[vin.vout] && prevTx.vout[vin.vout].scriptPubKey && prevTx.vout[vin.vout].scriptPubKey.nameOp;
			if (prevNop && prevNop.op === "name_new") {
				let height = null;
				if (prevTx.blockhash) {
					try {
						const hdr = await _coreApi.getBlockHeaderByHash(prevTx.blockhash);
						if (hdr && typeof hdr.height === "number") height = hdr.height;
					} catch (_e) { /* ignore */ }
				}
				return {
					kind: "name_new",
					txid: vin.txid,
					vout: vin.vout,
					height,
					blocktime: prevTx.blocktime || prevTx.time || null,
					hash: prevNop.hash || null,
					rand: prevNop.rand || null,
				};
			}
		}
		return null;
	}

	// Walk vin from a confirmed mid-cycle row backwards to its cycle's
	// `name_firstupdate`. Used only for the oldest row when it's a
	// `name_update` (i.e. `name_history` returned a row that's NOT a cycle
	// boundary — happens when -namehistory has been on since chain start).
	async function walkBackToFirstupdate(startTxid, startTx) {
		let curTx = startTx;
		let curTxid = startTxid;
		const maxSteps = 5000;
		for (let steps = 0; steps < maxSteps && curTx; steps++) {
			let foundPrev = null;
			for (const vin of (curTx.vin || [])) {
				if (!vin || !vin.txid || typeof vin.vout !== "number") continue;
				let prevTx;
				try { prevTx = await _coreApi.getRawTransaction(vin.txid); } catch (_e) { continue; }
				if (!prevTx || !Array.isArray(prevTx.vout)) continue;
				const prevNop = prevTx.vout[vin.vout] && prevTx.vout[vin.vout].scriptPubKey && prevTx.vout[vin.vout].scriptPubKey.nameOp;
				if (prevNop && prevNop.name === name && (prevNop.op === "name_update" || prevNop.op === "name_firstupdate")) {
					foundPrev = { txid: vin.txid, vout: vin.vout, tx: prevTx, nop: prevNop };
					break;
				}
			}
			if (!foundPrev) {
				warnings.push(`could not walk back from ${curTxid} to firstupdate (txindex disabled or pruned?)`);
				return null;
			}
			if (foundPrev.nop.op === "name_firstupdate") {
				let height = null;
				if (foundPrev.tx.blockhash) {
					try {
						const hdr = await _coreApi.getBlockHeaderByHash(foundPrev.tx.blockhash);
						if (hdr && typeof hdr.height === "number") height = hdr.height;
					} catch (_e) { /* ignore */ }
				}
				return {
					kind: "name_firstupdate",
					txid: foundPrev.txid,
					vout: foundPrev.vout,
					height,
					blocktime: foundPrev.tx.blocktime || foundPrev.tx.time || null,
					value: foundPrev.nop.value != null ? foundPrev.nop.value : null,
					value_encoding: foundPrev.nop.value_encoding || null,
					rand: foundPrev.nop.rand || null,
					hash: foundPrev.nop.hash || null,
				};
			}
			curTxid = foundPrev.txid;
			curTx = foundPrev.tx;
		}
		return null;
	}

	// ---------------------------------------------------------------------
	// Phase 1: classify each boundary candidate, build per-cycle firstupdate
	// ops, and walk each firstupdate's vin for its matching name_new.
	// ---------------------------------------------------------------------
	const cycleOpeners = [];  // [{ boundaryIndex, firstupdateOp, newOp, replaces? }]

	for (let bi = 0; bi < boundaryIdx.length; bi++) {
		const rowIdx = boundaryIdx[bi];
		const row = sorted[rowIdx];
		const rowInfo = await fetchNameOp(row.txid);
		if (!rowInfo || !rowInfo.nop) {
			warnings.push(`history row ${row.txid} carries no name op for ${name}`);
			continue;
		}

		if (rowInfo.nop.op === "name_firstupdate") {
			const firstupdateOp = {
				kind: "name_firstupdate",
				txid: row.txid,
				vout: rowInfo.vi,
				height: rowInfo.height != null ? rowInfo.height : (typeof row.height === "number" ? row.height : null),
				blocktime: rowInfo.blocktime || row.blocktime || null,
				value: rowInfo.nop.value != null ? rowInfo.nop.value : (row.value != null ? row.value : null),
				value_encoding: rowInfo.nop.value_encoding || row.value_encoding || null,
				rand: rowInfo.nop.rand || null,
				hash: rowInfo.nop.hash || null,
			};
			const newOp = await findNameNewForFirstupdate(row.txid);
			if (!newOp) warnings.push(`firstupdate tx ${row.txid} has no vin pointing at a name_new (txindex disabled or pruned?)`);
			cycleOpeners.push({ boundaryIndex: rowIdx, firstupdateOp, newOp, replacesRowAt: rowIdx });
		} else if (rowInfo.nop.op === "name_update") {
			if (bi === 0) {
				// Oldest row in name_history is mid-cycle; walk back to find the
				// firstupdate this cycle was opened with. This branch is the
				// pre-2026 behaviour for the very first cycle a -namehistory
				// node observed.
				const firstupdateOp = await walkBackToFirstupdate(row.txid, rowInfo.tx);
				if (firstupdateOp) {
					const newOp = await findNameNewForFirstupdate(firstupdateOp.txid);
					if (!newOp) warnings.push(`firstupdate tx ${firstupdateOp.txid} has no vin pointing at a name_new (txindex disabled or pruned?)`);
					cycleOpeners.push({ boundaryIndex: 0, firstupdateOp, newOp, replacesRowAt: null });
				}
			} else {
				// Mid-cycle row immediately after a >36000-block gap that didn't
				// match a firstupdate. Very unlikely on a -namehistory node
				// (would mean the gap was a long quiet stretch *within* one
				// cycle, which isn't possible because the name would have
				// expired). Worth surfacing so operators can investigate.
				warnings.push(`history row at height ${row.height} (${row.txid}) looked like a cycle boundary but on-chain op is name_update; possible chain reorg or stale history index?`);
			}
		} else {
			warnings.push(`history row ${row.txid} carries unexpected op kind '${rowInfo.nop.op}' for ${name}`);
		}
	}

	// ---------------------------------------------------------------------
	// Phase 2: walk the sorted history forward, assigning each row to a
	// cycle and stitching in name_new + name_firstupdate at each opener.
	// ---------------------------------------------------------------------
	const ops = [];
	const seen = new Set();
	const cycles = [];
	let currentCycleIndex = -1;
	let nextOpenerIdx = 0;

	for (let i = 0; i < sorted.length; i++) {
		const row = sorted[i];
		// Open a new cycle if this row is a boundary.
		if (nextOpenerIdx < cycleOpeners.length && cycleOpeners[nextOpenerIdx].boundaryIndex === i) {
			const opener = cycleOpeners[nextOpenerIdx++];
			currentCycleIndex++;

			// Track prior-cycle expiration metadata for the UI.
			const priorCycle = cycles[cycles.length - 1] || null;
			const hasPriorExpiration = priorCycle != null;
			const priorCycleLastOpHeight = priorCycle ? priorCycle.lastOpHeight : null;
			const priorCycleExpiredAt = (priorCycleLastOpHeight != null)
				? (priorCycleLastOpHeight + NAME_EXPIRATION_DEPTH)
				: null;

			const cycle = {
				cycleIndex: currentCycleIndex,
				startedAtNew: opener.newOp && typeof opener.newOp.height === "number" ? opener.newOp.height : null,
				startedAtFirstupdate: opener.firstupdateOp && typeof opener.firstupdateOp.height === "number" ? opener.firstupdateOp.height : null,
				lastOpHeight: null,  // stamped as we walk rows in this cycle
				hasPriorExpiration,
				priorCycleLastOpHeight,
				priorCycleExpiredAt,
			};
			cycles.push(cycle);

			if (opener.newOp && !seen.has(opener.newOp.txid)) {
				ops.push(Object.assign({}, opener.newOp, { cycleIndex: currentCycleIndex }));
				seen.add(opener.newOp.txid);
			}
			if (opener.firstupdateOp && !seen.has(opener.firstupdateOp.txid)) {
				ops.push(Object.assign({}, opener.firstupdateOp, { cycleIndex: currentCycleIndex }));
				seen.add(opener.firstupdateOp.txid);
				// If the opener REPLACES this history row, mark its txid as seen
				// so we don't re-emit it as a `name_update` below.
				if (opener.replacesRowAt === i) {
					seen.add(row.txid);
					if (cycles[currentCycleIndex] && typeof row.height === "number") {
						cycles[currentCycleIndex].lastOpHeight = row.height;
					}
					continue;
				}
			}
		}

		if (currentCycleIndex < 0) {
			// No cycle opened yet (oldest-row walkBackToFirstupdate failed, or
			// tx-verify yielded an unexpected op). Treat the row as a stray
			// name_update in a synthetic cycle so the UI still renders
			// something.
			currentCycleIndex = 0;
			cycles.push({
				cycleIndex: 0,
				startedAtNew: null,
				startedAtFirstupdate: null,
				lastOpHeight: null,
				hasPriorExpiration: false,
				priorCycleLastOpHeight: null,
				priorCycleExpiredAt: null,
			});
		}

		if (!seen.has(row.txid)) {
			ops.push({
				kind: "name_update",
				txid: row.txid,
				vout: typeof row.vout === "number" ? row.vout : null,
				height: typeof row.height === "number" ? row.height : null,
				blocktime: row.blocktime || null,
				value: row.value != null ? row.value : null,
				value_encoding: row.value_encoding || null,
				cycleIndex: currentCycleIndex,
			});
			seen.add(row.txid);
		}
		if (typeof row.height === "number") {
			cycles[currentCycleIndex].lastOpHeight = row.height;
		}
	}

	// ---------------------------------------------------------------------
	// Phase 3: legacy back-compat fields point at the LATEST (current) cycle.
	// ---------------------------------------------------------------------
	const lastCycle = cycles.length ? cycles[cycles.length - 1] : null;

	return {
		ops,
		cycles,
		cycleStartedAtNew: lastCycle ? lastCycle.startedAtNew : null,
		cycleStartedAtFirstupdate: lastCycle ? lastCycle.startedAtFirstupdate : null,
		ageBlocks: null,   // caller stamps this in once tip is known
		warnings,
		elapsedMs: Date.now() - startedAt,
	};
}

// Per-row decorator used by every "browse names" UI section: enriches
// each entry with `valueRender` (parsed JSON / pretty value) and
// `namespace` (parsed `d/`, `dd/`, `id/`, etc).  Background scanners
// only persist raw `value` + `value_encoding` to keep their RAM caches
// compact, so this runs at render time.  Idempotent and side-effect
// free; safe to .map() over hundreds of rows.
function decorateNameRow(entry) {
	if (!entry) return entry;
	const nm = entry.name || "";
	return Object.assign({}, entry, {
		valueRender: renderNameValue(entry.value, entry.value_encoding),
		namespace: nm ? splitNamespace(nm).namespace : null,
	});
}
function decorateNameRows(rows) {
	if (!Array.isArray(rows)) return [];
	return rows.map(decorateNameRow);
}

module.exports = {
	nameShow,
	nameShowActive,
	isAuthoritativeAbsentError,
	decorateNameRow,
	decorateNameRows,
	nameHistory,
	nameScan,
	namePending,
	collectNameOps,
	renderNameValue,
	splitNamespace,
	classifyNameTx,
	getRecentNameFirstUpdates,
	getOldestActiveNames,
	reconstructNameHistory,
	expandNameLifecycle,
	namespaceLabel,
	parseImports,
	collectAllImports,
	resolveNameImports,
	mergeImportedValue,
	isHex64,
	npubFromHex,
	parseNostrIdentities,
	parseNameIdFields,
	nip05ForLocalPart,
	getNamesSummary,
	getAllTimeFilterSnapshot: loadAllTimeFilterSnapshot,
	classifyNameValue,
	filterNamespace: _filterNamespace,
	ONION_V2_RE,
	ONION_V3_RE,
	FILTER_KEYS,
	FILTER_LABELS,
	FILTER_DESCRIPTIONS,
};
