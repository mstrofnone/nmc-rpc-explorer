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

function nameShow(name) {
	return rpcApi.getRpcDataWithParams({
		method: "name_show",
		parameters: [name],
	});
}

function nameHistory(name) {
	return rpcApi.getRpcDataWithParams({
		method: "name_history",
		parameters: [name],
	});
}

function nameScan(start, count) {
	const params = [];
	if (start != null) params.push(start);
	if (count != null) params.push(count);
	return rpcApi.getRpcDataWithParams({
		method: "name_scan",
		parameters: params,
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
function renderNameValue(value, encoding) {
	if (value == null || value === "") {
		return { kind: "empty", display: "" };
	}
	if (encoding === "hex") {
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

module.exports = {
	nameShow,
	nameHistory,
	nameScan,
	collectNameOps,
	renderNameValue,
	splitNamespace,
	namespaceLabel,
	parseImports,
	collectAllImports,
};
