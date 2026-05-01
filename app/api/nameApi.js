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
	const parameters = [];
	if (name != null) parameters.push(name);
	return rpcApi.getRpcDataWithParams({
		method: "name_pending",
		parameters: parameters,
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
		push("www", "Website", parsedValue.www, "link", parsedValue.www);
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

module.exports = {
	nameShow,
	nameHistory,
	nameScan,
	namePending,
	collectNameOps,
	renderNameValue,
	splitNamespace,
	namespaceLabel,
	parseImports,
	collectAllImports,
	isHex64,
	npubFromHex,
	parseNostrIdentities,
	parseNameIdFields,
	nip05ForLocalPart,
};
