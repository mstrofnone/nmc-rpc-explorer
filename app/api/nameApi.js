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

// ---------------------------------------------------------------------------
// Value-shape filters — cheap detectors for what's INSIDE a name's value.
// All inputs are the parsed JSON object from `renderNameValue` (or null/scalar).
// Returning true means "this name's value carries one of <thing>". Used to
// classify every name during the background scan so /utxo-set can show
// counts and link through to the filtered list.
// ---------------------------------------------------------------------------

const ONION_RE = /\b[a-z2-7]{16,56}\.onion\b/i;
const I2P_RE = /\b[a-z2-7]{52,60}\.b32\.i2p\b|\.i2p\b/i;
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|[01]?\d{1,2})(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d{1,2})){3}\b/;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/i;

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
		if (keyTest(k)) return true;
		const v = obj[k];
		if (v && typeof v === "object" && _hasKeyDeep(v, keyTest, depth + 1)) return true;
	}
	return false;
}

// Returns the set of value-shape labels this name's parsed value matches.
// Inputs:
//   parsed     — the JSON-parsed value (or null when value isn't JSON)
//   rawValue   — the raw string value (used for non-JSON regex sweeps)
function classifyNameValue(parsed, rawValue) {
	const tags = new Set();
	const hasJson = parsed != null && typeof parsed === "object";
	if (hasJson) tags.add("json");

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

	// TLS — ifa-0001 §"tls": typically a `tls` field whose value is an array
	// of TLSA tuples `[[usage, selector, mtype, hash], ...]`. We also accept
	// any deeply-nested `tls` key.
	if (hasJson && _hasKeyDeep(parsed, (k) => k === "tls" || k === "tlsa")) {
		tags.add("tls");
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

	// I2P — a `i2p` key, or a b32.i2p host anywhere in the strings.
	if ((hasJson && _hasKeyDeep(parsed, (k) => k === "i2p")) ||
		I2P_RE.test(haystack)) {
		tags.add("i2p");
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
	//   - email / mx → MX   (mail exchange)
	//   - txt      → TXT    (arbitrary text records)
	//   - service  → SRV    (service location)
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
		// MX — Mail exchange servers (`email` shorthand or `mx` array per ifa-0001)
		if (_hasKeyDeep(parsed, (k) => k === "email" || k === "mx")) {
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

const FILTER_KEYS = ["json", "onion", "tls", "ip", "nostr", "i2p", "a", "aaaa", "cname", "ns", "mx", "txt", "srv", "soa", "ds", "dnssec"];
const FILTER_LABELS = {
	json: "Valid JSON",
	onion: ".onion",
	tls: "TLSA",
	ip: "IP addresses",
	nostr: "Nostr",
	i2p: "I2P",
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
};
const FILTER_DESCRIPTIONS = {
	json: "Names whose value parses as JSON. The Namecoin convention is to use JSON for any structured record (d/, id/, dd/, nft/, ...); a name without JSON is usually a one-line text payload.",
	onion: "Names whose value carries a Tor v2/v3 onion address — either as a `tor` / `_tor` field (NameID convention) or as any v3 .onion hostname embedded anywhere in the value.",
	tls: "Names that publish TLSA records (ifa-0001 §tls). The `tls` field is an array of `[usage, selector, mtype, hash]` tuples used to pin a host's TLS certificate via Namecoin instead of a public CA. Used by .bit relays for DANE TLS pinning.",
	ip: "Names that publish at least one IP address (`ip` / `ip4` / `ip6` field per ifa-0001, or a literal address anywhere in the value). Combines A and AAAA for backwards compat.",
	nostr: "Names that publish a Nostr identity — either a single `nostr.pubkey` (NameID-style) or a multi-identity `nostr.names` map for NIP-05 delegation across subdomains.",
	i2p: "Names that publish an I2P address — either an `i2p` field or a `.b32.i2p` host embedded in the value.",
	a: "A — IPv4 address mapping (ifa-0001 `ip` field). Maps a name to one or more IPv4 addresses.",
	aaaa: "AAAA — IPv6 address mapping (ifa-0001 `ip6` field). Maps a name to one or more IPv6 addresses.",
	cname: "CNAME — Canonical name alias (ifa-0001 `alias` / `translate`). Redirects this name's resolution to another name.",
	ns: "NS — Nameserver delegation (ifa-0001 `ns` field). Delegates resolution authority to one or more DNS nameservers.",
	mx: "MX — Mail exchange servers (ifa-0001 `email` / `mx`). Specifies which mail servers handle email for this name.",
	txt: "TXT — Text records (ifa-0001 `txt` field). Arbitrary text data; commonly used for SPF, DKIM, domain verification, and ad-hoc metadata.",
	srv: "SRV — Service location records (ifa-0001 `service` field). Locates a host:port for a named service (e.g. `_xmpp._tcp`).",
	soa: "SOA — Start of authority record. Indicates the primary nameserver and admin contact for a DNS zone served via Namecoin.",
	ds: "DS — Delegation signer (DNSSEC). The `ds` field carries the cryptographic hash of a child zone's DNSKEY, anchoring DNSSEC validation in the Namecoin record.",
	dnssec: "DNSSEC-related records (cryptographic validation). Names carrying any DNSSEC-validation field: `dnssec`, `ds`, `rrsig`, `dnskey`, `nsec`, or `nsec3`.",
};

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
//     scannedAt:  <ms epoch>,
//     truncated:  <bool>,           // hit the per-prefix cap
//     elapsedMs:  <int>,
//   }
// ---------------------------------------------------------------------------
async function getNamesSummary({ pageSize = 2000, perPrefixCap = 10000000, prefixes = null, filterListCap = 5000 } = {}) {
	const startedAt = Date.now();
	const summary = {
		total: 0,
		active: 0,
		expired: 0,
		byNamespace: {},
		filterCounts: Object.fromEntries(FILTER_KEYS.map(k => [k, 0])),
		filterLists: Object.fromEntries(FILTER_KEYS.map(k => [k, []])),
		filterListCap,
		scannedAt: null,
		truncated: false,
		pagesScanned: 0,
		elapsedMs: 0,
	};

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
			const params = [last, pageSize];
			if (prefix) params.push({ prefix });
			let rows;
			try {
				rows = await rpcApi.getRpcDataWithParams({ method: "name_scan", parameters: params });
			} catch (_e) {
				break;
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

				// Value-shape classification — only run on active names so the
				// filter counts reflect what's currently *resolvable*. Expired
				// names are still in the index but have no operational meaning.
				if (!row.expired) {
					let parsed = null;
					if (typeof row.value === "string") {
						const trimmed = row.value.trim();
						if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
							try { parsed = JSON.parse(trimmed); } catch (_e) { /* not json */ }
						}
					}
					const tags = classifyNameValue(parsed, row.value);
					for (const tag of tags) {
						summary.filterCounts[tag]++;
						// Cap per-filter lists so a chain with millions of matches
						// can't blow up memory; the click-through page should treat
						// the cap as a hint to query the live `/api/names` directly.
						if (summary.filterLists[tag].length < filterListCap) {
							summary.filterLists[tag].push(row.name);
						}
					}
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

	summary.scannedAt = Date.now();
	summary.elapsedMs = summary.scannedAt - startedAt;
	return summary;
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
	getNamesSummary,
	classifyNameValue,
	FILTER_KEYS,
	FILTER_LABELS,
	FILTER_DESCRIPTIONS,
};
