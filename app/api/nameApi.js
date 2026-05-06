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
//     expiringSoon:        [ { name, expires_in, height, value, value_encoding }, ... ],   // sorted closest-to-expiring first, capped
//     recentlyExpired:     [ { name, expires_in, height, value, value_encoding }, ... ],   // sorted most-recently-expired first, capped
//     expiringSoonTotal:   <int>,   // true count before capping
//     recentlyExpiredTotal:<int>,
//     expiringSoonBlocks:  <int>,   // window threshold (default 2016 ≈ 2 weeks)
//     recentlyExpiredBlocks:<int>,  // window threshold (default 2016 ≈ 2 weeks)
//     scannedAt:  <ms epoch>,
//     truncated:  <bool>,           // hit the per-prefix cap
//     elapsedMs:  <int>,
//   }
// ---------------------------------------------------------------------------
async function getNamesSummary({ pageSize = 2000, perPrefixCap = 10000000, prefixes = null, filterListCap = 5000, squatterTopN = 10, squatterSampleNames = 5, squatterMinCount = 2, squatterMaxValueLen = 4096, expiringSoonBlocks = 2016, recentlyExpiredBlocks = 2016, expiringListCap = 500 } = {}) {
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
	// Memory shape: a Map<valueKey, {count,activeCount,expiredCount,sampleNames:[],byNamespace:{ns:count}}>.
	// Cluster keys are the raw value string truncated to squatterMaxValueLen
	// to bound memory; values longer than that are extremely rare on a 520-byte
	// chain anyway. Empty values ("") are skipped — newly-registered
	// (name_new) names have no value yet and would lump into a phantom giant
	// cluster otherwise.
	const clusters = new Map();
	const summary = {
		total: 0,
		active: 0,
		expired: 0,
		byNamespace: {},
		filterCounts: Object.fromEntries(FILTER_KEYS.map(k => [k, 0])),
		filterLists: Object.fromEntries(FILTER_KEYS.map(k => [k, []])),
		filterListCap,
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

				// Squatter clustering: every row with a non-empty value goes
				// into the cluster bucket keyed by its exact value (truncated).
				// We track active vs expired separately so we can rank by either.
				if (typeof row.value === "string" && row.value.length > 0) {
					const clusterKey = row.value.length > squatterMaxValueLen
						? row.value.substring(0, squatterMaxValueLen)
						: row.value;
					let bucket = clusters.get(clusterKey);
					if (!bucket) {
						bucket = { count: 0, activeCount: 0, expiredCount: 0, sampleNames: [], byNamespace: {} };
						clusters.set(clusterKey, bucket);
					}
					bucket.count++;
					if (row.expired) bucket.expiredCount++;
					else bucket.activeCount++;
					if (bucket.sampleNames.length < squatterSampleNames) {
						bucket.sampleNames.push(row.name);
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
			byNamespace: bucket.byNamespace,
		});
	}
	// Current squatters: rank by active count desc, then total desc.
	summary.squattersCurrent = clusterArr
		.filter(c => c.activeCount >= squatterMinCount)
		.slice() // shallow copy before sort
		.sort((a, b) => (b.activeCount - a.activeCount) || (b.count - a.count))
		.slice(0, squatterTopN);
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

module.exports = {
	nameShow,
	nameHistory,
	nameScan,
	namePending,
	collectNameOps,
	renderNameValue,
	splitNamespace,
	getRecentNameFirstUpdates,
	reconstructNameHistory,
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
