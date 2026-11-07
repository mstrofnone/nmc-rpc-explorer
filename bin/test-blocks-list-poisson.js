"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const Decimal = require("decimal.js");
const moment = require("moment");
const pug = require("pug");
require("moment-duration-format");

const utils = require("../app/utils.js");
const templatePath = path.join(__dirname, "../views/includes/blocks-list.pug");
const template = fs.readFileSync(templatePath, "utf8");
const mixinStubs = `
mixin timestamp(time, options)
	span timestamp
mixin timeAgo(time, options)
	span age
mixin funItemIcon
	span fun
mixin copyTextButton(text)
	span copy
mixin valueDisplaySpecial(value, decimals)
	span value
mixin valueDisplay(value)
	span value
`;

let assertionCount = 0;
let testCount = 0;

function test(name, callback) {
	callback();
	testCount++;
	console.log("ok - " + name);
}

function ok(value, message) {
	assert.ok(value, message);
	assertionCount++;
}

function render(blocks, sort) {
	return pug.render(mixinStubs + template, {
		filename: templatePath,
		blocks,
		sort,
		offset: 0,
		config: {coin: "NMC"},
		coinConfig: {
			name: "Namecoin",
			baseCurrencyUnit: {multiplier: 100000000},
			maxBlockSize: 1000000,
			maxBlockWeight: 4000000
		},
		global: {prunedBlockchain: false, pruneHeight: 0, specialBlocks: {}},
		blockstatsByHeight: null,
		userSettings: {displayCurrency: "btc"},
		utils,
		moment,
		Decimal
	});
}

function rowForHeight(html, height) {
	const rows = html.split("<tr>").slice(1).map(row => row.split("</tr>")[0]);
	const row = rows.find(candidate => candidate.includes("./block-height/" + height + "\""));
	assert.ok(row, "missing row for block " + height);
	return row;
}

const descending = [
	{height: 103, time: 1900, hash: "103", nTx: 1},
	{height: 102, time: 1500, hash: "102", nTx: 1},
	{height: 101, time: 1200, hash: "101", nTx: 1},
	{height: 100, time: 1000, hash: "100", nTx: 1},
	{height: 99, time: 800, hash: "99", nTx: 1}
];

test("descending rendering excludes the hidden predecessor from cumulative data", () => {
	const html = render(descending, "desc");
	ok(!html.includes("./block-height/99"));

	const newest = rowForHeight(html, 103);
	ok(newest.includes("Gap to previous block 400s"));
	ok(newest.includes("Since oldest displayed block: 900s across 3 intervals"));
	ok(newest.includes("P(N ≥ 3) = 19.1%"));

	const oldestVisible = rowForHeight(html, 100);
	ok(oldestVisible.includes("Gap to previous block 200s"));
	ok(oldestVisible.includes("N/A"));
	ok(!oldestVisible.includes("Since oldest displayed block"));
});

test("ascending rendering produces the same cumulative values", () => {
	const html = render(descending.slice().reverse(), "asc");
	ok(!html.includes("./block-height/99"));

	const newest = rowForHeight(html, 103);
	ok(newest.includes("Gap to previous block 400s"));
	ok(newest.includes("Since oldest displayed block: 900s across 3 intervals"));
	ok(newest.includes("P(N ≥ 3) = 19.1%"));

	const oldestVisible = rowForHeight(html, 100);
	ok(oldestVisible.includes("Gap to previous block 200s"));
	ok(oldestVisible.includes("N/A"));
	ok(!oldestVisible.includes("Since oldest displayed block"));
});

test("a lone genesis block has no fabricated cumulative probability", () => {
	const html = render([{height: 0, time: 1000, hash: "genesis", nTx: 1}], "desc");
	const genesis = rowForHeight(html, 0);
	ok(genesis.includes("N/A (genesis)"));
	ok(!genesis.includes("P(N ≥ 0)"));
	ok(!genesis.includes("100.0%"));
});

console.log("blocks list Poisson: " + testCount + " tests, " + assertionCount + " assertions passed");

// app/utils.js owns a long-lived cache interval.
process.exit(0);
