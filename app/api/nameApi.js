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

module.exports = {
	nameShow,
	nameHistory,
	nameScan,
	collectNameOps,
	renderNameValue,
	splitNamespace,
	namespaceLabel,
};
