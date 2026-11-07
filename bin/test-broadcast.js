"use strict";

process.env.BTCEXP_COIN = "NMC";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const bodyParser = require("body-parser");
const express = require("express");
const bitcoinjs = require("bitcoinjs-lib");
const pug = require("pug");

global.cacheStats = {};

const utils = require("../app/utils.js");
const originalLogError = utils.logError;
let errorLogs = [];
utils.logError = (...args) => {
	errorLogs.push(args);
};

const rpcApi = require("../app/api/rpcApi.js");
const originalRpcCall = rpcApi.getRpcDataWithParams;
let rpcCalls = [];
let rpcHandler = async () => {
	throw new Error("Unexpected RPC call in broadcast test.");
};

rpcApi.getRpcDataWithParams = async request => {
	rpcCalls.push(request);
	return rpcHandler(request);
};

const apiRouter = require("../routes/apiRouter.js");
const config = require("../app/config.js");
const apiDocs = require("../docs/api.js");

const app = express();
app.set("trust proxy", "loopback");
app.use(bodyParser.json({limit: config.transactionBroadcast.jsonBodyLimit}));
app.use("/api", apiRouter);
app.use((req, res) => {
	if (!res.headersSent) {
		res.status(404).json({success: false, error: "Not found."});
	}
});

const server = http.createServer(app);
let baseUrl;
let clientSequence = 0;

async function postBroadcast(body, options = {}) {
	const headers = {
		"Content-Type": options.contentType || "application/json",
		"X-Forwarded-For": options.ip || "198.51.100." + (++clientSequence)
	};

	if (options.origin !== null) {
		headers.Origin = options.origin || baseUrl;
	}
	if (options.fetchSite !== null) {
		headers["Sec-Fetch-Site"] = options.fetchSite || "same-origin";
	}

	const response = await fetch(baseUrl + "/api/tx/broadcast", {
		method: "POST",
		headers: headers,
		body: options.rawBody !== undefined ? options.rawBody : JSON.stringify(body)
	});
	const text = await response.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		assert.fail("Expected JSON response, received: " + text.substring(0, 200));
	}

	return {status: response.status, body: json, text: text};
}

function resetRpc(handler) {
	rpcCalls = [];
	rpcHandler = handler;
}

async function run() {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	baseUrl = "http://127.0.0.1:" + server.address().port;

	const transaction = new bitcoinjs.Transaction();
	transaction.version = 1;
	transaction.addInput(Buffer.alloc(32, 7), 0);
	transaction.addOutput(Buffer.from("51", "hex"), 1000);
	const rawTransaction = transaction.toHex();
	const txid = "ab".repeat(32);

	resetRpc(async request => {
		if (request.method === "testmempoolaccept") {
			return [{allowed: true, txid: txid}];
		}
		if (request.method === "sendrawtransaction") {
			return txid;
		}
		throw new Error("Unexpected RPC method.");
	});
	let response = await postBroadcast({rawTransaction: rawTransaction.toUpperCase()});
	assert.equal(response.status, 200);
	assert.deepEqual(response.body, {success: true, txid: txid});
	assert.deepEqual(rpcCalls, [
		{method: "testmempoolaccept", parameters: [[rawTransaction]]},
		{method: "sendrawtransaction", parameters: [rawTransaction]}
	]);

	resetRpc(async () => [{allowed: false, "reject-reason": "bad-txns\ninput missing"}]);
	response = await postBroadcast({rawTransaction: rawTransaction});
	assert.equal(response.status, 422);
	assert.match(response.body.error, /bad-txns input missing/);
	assert.equal(rpcCalls.length, 1);
	assert.equal(rpcCalls[0].method, "testmempoolaccept");

	resetRpc(async () => []);
	response = await postBroadcast({rawTransaction: rawTransaction});
	assert.equal(response.status, 502);
	assert.match(response.body.error, /unexpected validation response/);
	assert.equal(rpcCalls.length, 1);

	resetRpc(async () => {
		throw new Error("http://namecoinrpc:validation-secret@127.0.0.1:8336");
	});
	response = await postBroadcast({rawTransaction: rawTransaction});
	assert.equal(response.status, 502);
	assert.doesNotMatch(response.text, /validation-secret|namecoinrpc/);
	assert.equal(rpcCalls.length, 1);

	resetRpc(async request => {
		if (request.method === "testmempoolaccept") {
			return [{allowed: true}];
		}
		throw new Error("http://namecoinrpc:broadcast-secret@127.0.0.1:8336");
	});
	response = await postBroadcast({rawTransaction: rawTransaction});
	assert.equal(response.status, 502);
	assert.doesNotMatch(response.text, /broadcast-secret|namecoinrpc/);
	assert.equal(rpcCalls.length, 2);

	const serializedErrorLogs = errorLogs.flat().map(value => String(value)).join("\n");
	assert.doesNotMatch(serializedErrorLogs, /validation-secret|broadcast-secret|namecoinrpc/);
	assert.ok(!serializedErrorLogs.includes(rawTransaction));

	for (const invalidTransaction of [
		"00".repeat(60) + "zz",
		"0".repeat(121),
		"00".repeat(59),
		"00".repeat(60)
	]) {
		resetRpc(async () => {
			throw new Error("Validation failure must not reach RPC.");
		});
		response = await postBroadcast({rawTransaction: invalidTransaction});
		assert.equal(response.status, 400);
		assert.equal(rpcCalls.length, 0);
	}

	resetRpc(async () => {
		throw new Error("Boundary transaction must not reach RPC when structurally invalid.");
	});
	response = await postBroadcast({rawTransaction: "00".repeat(config.transactionBroadcast.maxRawTransactionBytes)});
	assert.equal(response.status, 400);
	assert.equal(rpcCalls.length, 0);

	resetRpc(async () => {
		throw new Error("Oversized transaction must not reach RPC.");
	});
	response = await postBroadcast({rawTransaction: "00".repeat(config.transactionBroadcast.maxRawTransactionBytes + 1)});
	assert.equal(response.status, 413);
	assert.equal(rpcCalls.length, 0);

	response = await postBroadcast(null, {rawBody: rawTransaction, contentType: "text/plain"});
	assert.equal(response.status, 415);
	assert.equal(rpcCalls.length, 0);

	response = await postBroadcast({rawTransaction: rawTransaction}, {
		origin: "https://attacker.invalid",
		fetchSite: "cross-site"
	});
	assert.equal(response.status, 403);
	assert.equal(rpcCalls.length, 0);

	response = await postBroadcast({rawTransaction: rawTransaction}, {origin: null, fetchSite: "cross-site"});
	assert.equal(response.status, 403);
	assert.equal(rpcCalls.length, 0);

	response = await postBroadcast({rawTransaction: rawTransaction}, {origin: "null"});
	assert.equal(response.status, 403);
	assert.equal(rpcCalls.length, 0);

	const rateLimitIp = "192.0.2.55";
	for (let i = 0; i < config.transactionBroadcast.rateLimitMaxRequests; i++) {
		response = await postBroadcast({}, {ip: rateLimitIp});
		assert.equal(response.status, 400);
	}
	response = await postBroadcast({}, {ip: rateLimitIp});
	assert.equal(response.status, 429);
	assert.match(response.body.error, /Too many transaction broadcast attempts/);
	assert.equal(rpcCalls.length, 0);

	const broadcastDoc = apiDocs.routes.find(item => item.url === "/tx/broadcast");
	assert.equal(broadcastDoc.method, "POST");
	assert.equal(broadcastDoc.category, "transactions");

	const toolIndex = config.siteTools.findIndex(item => item.url === "./broadcast");
	assert.ok(toolIndex >= 0);
	assert.ok(config.site.toolSections.some(section => section.items.includes(toolIndex)));

	for (const template of ["broadcast.pug", "api-docs.pug", "tools.pug"]) {
		pug.compileFile(path.join(__dirname, "..", "views", template));
	}

	console.log("PASS broadcast success and RPC ordering");
	console.log("PASS mempool rejection, malformed responses, and credential-safe errors");
	console.log("PASS hex, size, structure, JSON, and same-origin validation");
	console.log("PASS per-IP rate limit");
	console.log("PASS API docs metadata, Tools link, and Pug compilation");
	console.log("All RPC calls were mocked; no transaction was broadcast.");
}

run().catch(error => {
	console.error(error);
	process.exitCode = 1;
}).finally(() => {
	rpcApi.getRpcDataWithParams = originalRpcCall;
	utils.logError = originalLogError;
	if (server.listening) {
		server.close(() => process.exit(process.exitCode || 0));
	} else {
		process.exit(process.exitCode || 0);
	}
});
