"use strict";

const debug = require("debug");
const debugLog = debug("btcexp:router");

const express = require('express');
const router = express.Router();
const util = require('util');
const moment = require('moment');
const qrcode = require('qrcode');
const bitcoinjs = require('bitcoinjs-lib');
const sha256 = require("crypto-js/sha256");
const hexEnc = require("crypto-js/enc-hex");
const Decimal = require("decimal.js");
const asyncHandler = require("express-async-handler");

const utils = require('./../app/utils.js');
const coins = require("./../app/coins.js");
const config = require("./../app/config.js");
const coreApi = require("./../app/api/coreApi.js");
const addressApi = require("./../app/api/addressApi.js");
const btcQuotes = require("./../app/coins/btcQuotes.js");
const nmcQuotes = require("./../app/coins/nmcQuotes.js");





router.get("/formatCurrencyAmount/:amt", function(req, res, next) {
	res.locals.currencyValue = req.params.amt;

	res.render("includes/value-display");

	next();
});

router.get("/quote/random", function(req, res, next) {
	let done = false;

	while (!done) {
		res.locals.quoteIndex = utils.randomInt(0, btcQuotes.items.length);
		res.locals.quote = btcQuotes.items[res.locals.quoteIndex];

		done = !utils.objHasProperty(res.locals.quote, "duplicateIndex");
	}

	res.render("snippets/quote");

	next();
});

// Namecoin quote/fact of the page-load. Companion to /snippet/quote/random;
// rendered as a second iframe above the upstream Bitcoin quote so that an
// instance running on Namecoin (BTCEXP_COIN=NMC) shows a Namecoin quote and
// the Bitcoin quote it's paired with.
router.get("/quote/random/nmc", function(req, res, next) {
	res.locals.quoteIndex = -1; // suppress "open this quote" link; nmcQuotes has no /quote/N route
	res.locals.quote = nmcQuotes.items[utils.randomInt(0, nmcQuotes.items.length)];

	res.render("snippets/quote");

	next();
});

router.get("/next-block", asyncHandler(async (req, res, next) => {
	const promises = [];

	const result = {};

	promises.push(utils.timePromise("api/next-block/getblocktemplate", async () => {
		let nextBlockEstimate = await utils.timePromise("api/next-block/getNextBlockEstimate", async () => {
			return await coreApi.getNextBlockEstimate();
		});


		result.txCount = nextBlockEstimate.blockTemplate.transactions.length;

		result.totalWeight = nextBlockEstimate.weight;

		result.minFeeRate = nextBlockEstimate.minFeeRate;
		result.maxFeeRate = nextBlockEstimate.maxFeeRate;
		result.medianFeeRate = nextBlockEstimate.medianFeeRate;
		result.minFeeTxid = nextBlockEstimate.minFeeTxid;
		result.maxFeeTxid = nextBlockEstimate.maxFeeTxid;

		result.totalFees = nextBlockEstimate.totalFees.toNumber();
	}));

	await utils.awaitPromises(promises);

	res.locals.minFeeRate = result.minFeeRate;
	res.locals.maxFeeRate = result.maxFeeRate;
	res.locals.medianFeeRate = result.medianFeeRate;
	res.locals.txCount = result.txCount;
	res.locals.totalWeight = result.totalWeight;
	res.locals.totalFees = result.totalFees;

	res.render("snippets/index-next-block");
}));

router.get("/index-halving-countdown", asyncHandler(async (req, res, next) => {
	try {
		const getblockchaininfo = await utils.timePromise("snippet.index-halving-countdown.getBlockchainInfo", async () => {
			return await coreApi.getBlockchainInfo();
		});

		let promises = [];

		res.locals.getblockchaininfo = getblockchaininfo;
		res.locals.difficultyPeriod = parseInt(Math.floor(getblockchaininfo.blocks / coinConfig.difficultyAdjustmentBlockCount));

		let blockHeights = [];
		if (getblockchaininfo.blocks) {
			for (let i = 0; i < 1; i++) {
				blockHeights.push(getblockchaininfo.blocks - i);
			}
		} else if (global.activeBlockchain == "regtest") {
			// hack: default regtest node returns getblockchaininfo.blocks=0, despite
			// having a genesis block; hack this to display the genesis block
			blockHeights.push(0);
		}

		promises.push(utils.timePromise("snippet.index-halving-countdown.getBlockHeaderByHeight", async () => {
			let h = coinConfig.difficultyAdjustmentBlockCount * res.locals.difficultyPeriod;
			res.locals.difficultyPeriodFirstBlockHeader = await coreApi.getBlockHeaderByHeight(h);
		}));

		promises.push(utils.timePromise("snippet.index-halving-countdown.getBlocksByHeight", async () => {
			const latestBlocks = await coreApi.getBlocksByHeight(blockHeights);
			
			res.locals.latestBlocks = latestBlocks;
		}));

		await utils.awaitPromises(promises);


		let nextHalvingData = utils.nextHalvingEstimates(res.locals.difficultyPeriodFirstBlockHeader, res.locals.latestBlocks[0]);

		res.locals.nextHalvingData = nextHalvingData;

		await utils.timePromise("snippet.index-halving-countdown.render", async () => {
			res.render("snippets/index-halving-countdown");
		});

	} catch (e) {
		res.locals.pageErrors.push(utils.logError("390wrgehburfuge", e));

		await utils.timePromise("snippet.index-halving-countdown.render", async () => {
			res.render("snippets/index-halving-countdown");
		});
	}
}));

router.get("/utxo-set", asyncHandler(async (req, res, next) => {
	const promises = [];

	promises.push(utils.timePromise("api/utxo-set", async () => {
		if (global.utxoSetSummary) {
			res.locals.utxoSetSummary = global.utxoSetSummary;

		} else {
			res.locals.utxoSetSummary = await coreApi.getUtxoSetSummary(true, true);
		}
	}));

	await utils.awaitPromises(promises);

	// Namecoin: surface the cached registered-names summary alongside
	// the UTXO totals so the page can show count-of-names next to NMC-locked.
	res.locals.namesSummary = global.namesSummary;
	res.locals.namesSummaryPending = global.namesSummaryPending;
	res.locals.nameApi = require("./../app/api/nameApi.js");

	// nmc-3.6.59: names/txs count-mode toggle for the filter tiles, via
	// ?countMode=txs (server-rendered; default names). txs mode counts name
	// operations for each filter's current match list over the tx index's
	// trailing 36,000-block window. Counts are computed at render time from
	// the live index (the match lists themselves come from the 30-min
	// summary walk).
	res.locals.filterCountMode = (req.query.countMode == "txs") ? "txs" : "names";
	const nameTxIndex = require("./../app/api/nameTxIndex.js");
	const txIdxStatus = nameTxIndex.indexStatus();
	if (txIdxStatus.loaded && txIdxStatus.tipIndexed >= 0) {
		const ws = txIdxStatus.windowStart;
		const lo = Math.max(txIdxStatus.backfillDone == null ? txIdxStatus.tipIndexed + 1 : txIdxStatus.backfillDone, ws);
		txIdxStatus.windowCoveragePct = Math.min(100, Math.round(100 * (txIdxStatus.tipIndexed - lo + 1) / (txIdxStatus.tipIndexed - ws + 1)));
	} else {
		txIdxStatus.windowCoveragePct = 0;
	}
	res.locals.nameTxIndexStatus = txIdxStatus;
	res.locals.filterTxCounts = null;
	res.locals.filterTxCountsAllTime = null;
	if (res.locals.filterCountMode == "txs" && txIdxStatus.enabled && txIdxStatus.loaded && res.locals.namesSummary) {
		const ws = txIdxStatus.windowStart;
		// Active filter lists are uncapped (filterListCap=Infinity), so tx
		// counts over them are exact.
		res.locals.filterTxCounts = nameTxIndex.countTxsForFilters(res.locals.namesSummary.filterLists, ws);
		if (res.locals.namesSummary.filterListsAllTime) {
			// Since nmc-3.6.64 all-time lists are uncapped, so every list is
			// complete and every tile gets an exact tx count. The
			// completeness check below is kept as a defensive guard: if a
			// pre-3.6.64 capped snapshot were ever carried forward, a tx
			// count over a partial list would silently undercount, so that
			// tile would be suppressed with a note instead.
			const atLists = res.locals.namesSummary.filterListsAllTime;
			const atCounts = res.locals.namesSummary.filterCountsAllTime || {};
			const completeLists = {};
			for (const k of Object.keys(atLists)) {
				if ((atLists[k] || []).length >= (atCounts[k] || 0)) completeLists[k] = atLists[k];
			}
			// Keys absent from completeLists stay absent from the result map;
			// the template renders the suppression note for them.
			res.locals.filterTxCountsAllTime = nameTxIndex.countTxsForFilters(completeLists, ws);
		}
	}

	// nmc-3.6.60: "Most updated names" leaderboards, rendered in a new
	// section directly beneath the by-namespace breakdown. Served from
	// the index module's cached board snapshot (recomputed at most once
	// a minute and only when the underlying aggregates changed), never
	// recomputed per request from the raw op log. Available in both
	// count modes: the boards always count name operations, so they do
	// not follow the names/txs tile toggle.
	res.locals.nameTxBoards = null;
	if (txIdxStatus.enabled && txIdxStatus.loaded) {
		res.locals.nameTxBoards = nameTxIndex.getBoards({ limit: 10 });
	}

	res.render("snippets/utxo-set");
}));

router.get("/timezone-refresh-toast", asyncHandler(async (req, res, next) => {
	res.render("snippets/tz-update-toast");
}));


router.get("/timestamp", asyncHandler(async (req, res, next) => {
	res.locals.timestamp = req.query.timestamp;
	res.locals.includeAgo = req.query.includeAgo ? (req.query.includeAgo == "true") : true;
	res.locals.formatString = req.query.formatString;

	res.render("snippets/timestamp");
}));




module.exports = router;
