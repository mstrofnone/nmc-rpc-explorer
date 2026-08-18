"use strict";

const debug = require("debug");
const debugLog = debug("btcexp:router");

const fs = require('fs');
const v8 = require('v8');

const express = require('express');
const router = express.Router();
const util = require('util');
const moment = require('moment');
const qrcode = require('qrcode');
const bitcoinjs = require('bitcoinjs-lib');
const sha256 = require("crypto-js/sha256");
const hexEnc = require("crypto-js/enc-hex");
const Decimal = require("decimal.js");


const utils = require('./../app/utils.js');
const coins = require("./../app/coins.js");
const config = require("./../app/config.js");
const coreApi = require("./../app/api/coreApi.js");
const addressApi = require("./../app/api/addressApi.js");


const statTracker = require("./../app/statTracker.js");
const appStats = require("./../app/appStats.js");


// The whole /admin surface (dashboard, os-stats, heapdump, ...) exposes
// operational internals: heap statistics, RPC stats, and — via
// global.errorStats — the raw request paths and RPC parameters of every
// user's recent errors. That is a cross-user privacy leak when served
// without authentication, so gate the entire router behind the same
// basic-auth flag the rest of the app uses. When no auth password is
// configured (req.authenticated always undefined) the router is simply
// unreachable, which is the safe default.
router.use(function(req, res, next) {
	if (!req.authenticated) {
		res.status(401).send("Admin routes require authentication. Set an authentication password via the 'BTCEXP_BASIC_AUTH_PASSWORD' environment variable.");

		return;
	}

	next();
});


router.get("/dashboard", function(req, res, next) {
	res.locals.appStartTime = global.appStartTime;
	res.locals.memstats = v8.getHeapStatistics();
	res.locals.rpcStats = global.rpcStats;
	res.locals.electrumStats = global.electrumStats;
	res.locals.cacheStats = global.cacheStats;
	res.locals.errorStats = global.errorStats;
	res.locals.appEventStats = global.appEventStats;

	res.locals.cacheSizes = {
		misc: {
			size: global.miscLruCache.size,
			itemCount: global.miscLruCache.itemCount
		},
		block: {
			size: global.blockLruCache.size,
			itemCount: global.blockLruCache.itemCount
		},
		tx: {
			size: global.txLruCache.size,
			itemCount: global.txLruCache.itemCount
		},
		mining: {
			size: global.miningSummaryLruCache.size,
			itemCount: global.miningSummaryLruCache.itemCount
		}
	};

	res.locals.appConfig = {
		privacyMode: config.privacyMode,
		slowDeviceMode: config.slowDeviceMode,
		demoSite: config.demoSite,
		rpcConcurrency: config.rpcConcurrency,
		addressApi: config.addressApi,
		ipStackComApiAccessKey: !!config.credentials.ipStackComApiAccessKey,
		mapBoxComApiAccessKey: !!config.credentials.mapBoxComApiAccessKey,
		redisCache: !!config.redisUrl,
		noInmemoryRpcCache: config.noInmemoryRpcCache
	};

	res.render("admin/dashboard");

	next();
});

router.get("/os-stats", function(req, res, next) {
	res.locals.appStats = appStats.getAllAppStats();
	res.locals.appStatNames = appStats.statNames;
	

	res.render("admin/os-stats");

	next();
});

router.get("/perf-log", function(req, res, next) {
	res.locals.perfLog = utils.perfLog;

	res.render("admin/perf-log");

	next();
});


router.get("/app-stats", function(req, res, next) {
	res.locals.stats = statTracker.currentStats();
	
	
	res.locals.performanceStats = [];
	for (const [key, value] of Object.entries(res.locals.stats.performance)) {
		res.locals.performanceStats.push([key, value]);
	}

	res.locals.performanceStats.sort((a, b) => {
		return a[0].localeCompare(b[0]);
	});


	res.locals.eventStats = [];
	for (const [key, value] of Object.entries(res.locals.stats.event)) {
		res.locals.eventStats.push([key, value]);
	}

	res.locals.eventStats.sort((a, b) => {
		return a[0].localeCompare(b[0]);
	});


	res.locals.valueStats = [];
	for (const [key, value] of Object.entries(res.locals.stats.value)) {
		res.locals.valueStats.push([key, value]);
	}

	res.locals.valueStats.sort((a, b) => {
		return a[0].localeCompare(b[0]);
	});
	

	res.render("admin/app-stats");

	next();
});


router.get('/resetUserSettings', (req, res) => {
	req.session.userSettings = Object.create(null);
 
	let userSettings = Object.create(null);
	
	res.cookie("user-settings", JSON.stringify(userSettings));

	res.redirect(req.headers.referer);
});


router.get('/heapdump', (req, res) => {
	// Use req.ip (trust-proxy-aware) rather than the raw X-Forwarded-For
	// header: a direct client on port 3002 can otherwise spoof
	// "X-Forwarded-For: 127.0.0.1" and trigger a heap snapshot that
	// contains RPC credentials, the cookie secret, and the basic-auth
	// password. The router-level auth gate above is the primary barrier;
	// this loopback check is defense-in-depth for operators who run the
	// explorer without basic-auth on a trusted network.
	const ip = req.ip;

	debugLog(`Heap dump requested by IP ${ip}...`);

	if (ip == "127.0.0.1" || ip == "::1" || ip == "::ffff:127.0.0.1") {
		const filename = `./heapDump-${Date.now()}.heapsnapshot`;
		const heapdumpStream = v8.getHeapSnapshot();
		const fileStream = fs.createWriteStream(filename);
		heapdumpStream.pipe(fileStream);
		
		debugLog("Heap dump at startup written to", filename);

		res.status(200).send({msg: "successfully took a heap dump"});

		return;
	}

	res.status(403).end();
});



module.exports = router;
