"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const nameApi = require("../app/api/nameApi.js");

function plainOutput() {
	return { scriptPubKey: {} };
}

function nameOutput(op) {
	return { scriptPubKey: { nameOp: { op } } };
}

function regularTx(vout = [plainOutput()]) {
	return { vin: [{ txid: "previous", vout: 0 }], vout };
}

function coinbaseTx(vout = [plainOutput()]) {
	// An empty coinbase script still identifies a coinbase transaction. Test
	// property detection rather than relying on the value's truthiness.
	return { vin: [{ coinbase: "", sequence: 0 }], vout };
}

// Load only the real refreshNameTxStats function from app.js, avoiding startup
// side effects while exercising the exact production loop and global payload.
function loadRefreshNameTxStats(coreApi, appGlobal) {
	const appSource = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
	const start = appSource.indexOf("async function refreshNameTxStats() {");
	const end = appSource.indexOf("async function refreshRecentNameOps()", start);
	assert.notEqual(start, -1, "refreshNameTxStats must exist in app.js");
	assert.ok(end > start, "refreshNameTxStats source boundary must be identifiable");
	const refreshSource = appSource.slice(start, end);
	const factory = new Function("coreApi", "nameApi", "debugLog", "process", "global", refreshSource + "\nreturn refreshNameTxStats;");
	return factory(coreApi, nameApi, () => {}, { env: {} }, appGlobal);
}

(async () => {
	const blocks = {
		99: { height: 99, time: 1000, tx: [coinbaseTx(), regularTx()] },
		100: {
			height: 100,
			time: 1600,
			tx: [
				regularTx([nameOutput("name_new")]),
				regularTx(),
				coinbaseTx([nameOutput("name_update")]),
			],
		},
		101: {
			height: 101,
			time: 2200,
			tx: [
				"bare-txid",
				regularTx([nameOutput("name_firstupdate"), nameOutput("name_new")]),
				// Any nameOp payload excludes the strict metric. Omitting op also
				// confirms the legacy nameTx classification remains unchanged.
				regularTx([{ scriptPubKey: { nameOp: {} } }]),
			],
		},
	};
	const requestedHeights = [];
	const coreApi = {
		getBlockchainInfo: async () => ({ blocks: 200 }),
		getBlockByHeight: async (height) => {
			requestedHeights.push(height);
			return blocks[height] || { height, tx: [] };
		},
	};
	const appGlobal = {};
	const refreshNameTxStats = loadRefreshNameTxStats(coreApi, appGlobal);
	await refreshNameTxStats();

	const stats = appGlobal.nameTxStats;
	assert.ok(stats, "the live refresh must populate global.nameTxStats");
	assert.equal(requestedHeights.length, 144);
	assert.equal(requestedHeights[0], 57);
	assert.equal(requestedHeights[143], 200);
	assert.equal(stats.windowBlocks, 144);
	assert.equal(stats.windowStartHeight, 57);
	assert.equal(stats.windowEndHeight, 200);
	assert.equal(stats.windowSeconds, 1200);
	assert.equal(stats.totalTxCount, 8);
	assert.equal(stats.nameTxCount, 3);
	assert.equal(stats.currencyTxCount, 5);
	assert.equal(stats.currencyTxExcludingCoinbaseCount, 2);
	assert.equal(stats.nameTxFraction, 3 / 8);
	assert.equal(stats.nameTxRate, 3 / 1200);
	assert.equal(stats.currencyTxRate, 5 / 1200);
	assert.equal(stats.currencyTxExcludingCoinbaseRate, 2 / 1200);
	assert.deepEqual(stats.opCounts, { name_new: 2, name_firstupdate: 1, name_update: 1 });

	const serializedStats = JSON.parse(JSON.stringify(stats));
	assert.equal(serializedStats.currencyTxExcludingCoinbaseCount, 2);
	assert.equal(serializedStats.currencyTxExcludingCoinbaseRate, 2 / 1200);

	console.log("PASS: live refreshNameTxStats preserves legacy metrics and exposes coinbase-excluding count and rate");
})().then(() => {
	// App module imports can leave caches or timers open. This is a standalone
	// assertion script, so do not wait for unrelated application resources.
	process.exit(0);
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
