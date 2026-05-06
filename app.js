#!/usr/bin/env node

"use strict";

const os = require('os');
const path = require('path');
const dotenv = require("dotenv");
const fs = require('fs');

const debug = require("debug");


// start with this, we will update after loading any .env files
const debugDefaultCategories = "btcexp:app,btcexp:error,btcexp:errorVerbose";
debug.enable(debugDefaultCategories);


const debugLog = debug("btcexp:app");
const debugErrorLog = debug("btcexp:error");
const debugPerfLog = debug("btcexp:actionPerformace");
const debugAccessLog = debug("btcexp:access");

const configPaths = [
	path.join(os.homedir(), ".config", "btc-rpc-explorer.env"),
	path.join("/etc", "btc-rpc-explorer", ".env"),
	path.join(process.cwd(), ".env"),
];

debugLog("Searching for config files...");
let configFileLoaded = false;
configPaths.forEach(path => {
	if (fs.existsSync(path)) {
		debugLog(`Config file found at ${path}, loading...`);

		// this does not override any existing env vars
		dotenv.config({ path });

		// we manually set env.DEBUG above (so that app-launch log output is good),
		// so if it's defined in the .env file, we need to manually override
		const config = dotenv.parse(fs.readFileSync(path));
		if (config.DEBUG) {
			process.env.DEBUG = config.DEBUG;
		}

		configFileLoaded = true;

	} else {
		debugLog(`Config file not found at ${path}, continuing...`);
	}
});

if (!configFileLoaded) {
	debugLog("No config files found. Using all defaults.");

	if (!process.env.NODE_ENV) {
		process.env.NODE_ENV = "production";
	}
}

// debug module is already loaded by the time we do dotenv.config
// so refresh the status of DEBUG env var
debug.enable(process.env.DEBUG || debugDefaultCategories);


global.cacheStats = {};
global.appEventStats = {};



const express = require('express');
const favicon = require('serve-favicon');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const session = require("express-session");
const MemoryStore = require('memorystore')(session);
const csrfApi = require("csurf");
const config = require("./app/config.js");
const simpleGit = require('simple-git');
const utils = require("./app/utils.js");
const moment = require("moment");
const Decimal = require('decimal.js');
const pug = require("pug");
const momentDurationFormat = require("moment-duration-format");
const coreApi = require("./app/api/coreApi.js");
const nameApi = require("./app/api/nameApi.js");
const rpcApi = require("./app/api/rpcApi.js");
const coins = require("./app/coins.js");
const axios = require("axios");
const qrcode = require("qrcode");
const addressApi = require("./app/api/addressApi.js");
const electrumAddressApi = require("./app/api/electrumAddressApi.js");
const appStats = require("./app/appStats.js");
const btcQuotes = require("./app/coins/btcQuotes.js");
const btcHolidays = require("./app/coins/btcHolidays.js");
const auth = require('./app/auth.js');
const sso = require('./app/sso.js');
const markdown = require("markdown-it")();
const v8 = require("v8");
const compression = require("compression");
const jayson = require('jayson/promise');
const { rateLimit } = require("express-rate-limit");


const appUtils = require("@janoside/app-utils");
const s3Utils = appUtils.s3Utils;

let cdnS3Bucket = null;
if (config.cdn.active) {
	cdnS3Bucket = s3Utils.createBucket(config.cdn.s3Bucket, config.cdn.s3BucketRegion, config.cdn.s3BucketPath);
}

require("./app/currencies.js");

// When running in non-BTC mode (e.g. Namecoin), the upstream `displayCurrency`
// state machine still routes native amounts through the "btc" currency-type slot
// (the lower-case key is the radio-button id stored in cookies, NOT the visible
// label). Re-label that slot so views like blocks-list and tx-stats render
// "NMC" alongside values instead of "BTC". The other native-unit aliases
// ("sat") stay shared with Bitcoin since they're identical at the protocol level.
//
// We ALSO register a lowercase-ticker peer slot that points at the same data,
// because some templates (e.g. index-network-summary.pug formatFees) re-look
// up the currency type by `parts.currencyUnit.toLowerCase()` after we've
// already renamed the `.name` field — without that peer slot the lookup
// would return undefined and crash the homepage.
if (process.env.BTCEXP_COIN && process.env.BTCEXP_COIN !== "BTC") {
	const coins = require("./app/coins.js");
	const activeCoinModule = coins[process.env.BTCEXP_COIN];
	if (activeCoinModule && activeCoinModule.defaultCurrencyUnit && global.currencyTypes && global.currencyTypes.btc) {
		const nativeName = activeCoinModule.defaultCurrencyUnit.name;
		const nativeDp = activeCoinModule.defaultCurrencyUnit.decimalPlaces;
		global.currencyTypes.btc.name = nativeName;
		global.currencyTypes.btc.decimalPlaces = nativeDp;
		global.currencyTypes[nativeName.toLowerCase()] = global.currencyTypes.btc;
	}

	// On Namecoin, retarget the "sat" small-unit slot to **Swartz**
	// (1,000,000 per NMC, the user-friendly subdivision defined in
	// app/coins/nmc.js). The cookie value stays "sat" so existing
	// `displayCurrency == "sat"` checks across views keep working,
	// but the visible label switches to "Swartz" everywhere it
	// renders (the settings-cog button, the small-unit label next
	// to amounts in the latest-blocks table, etc.). Done by name
	// lookup so any coin that publishes a "swartz"-style mid-unit
	// gets it; coins without one fall through unchanged.
	if (activeCoinModule && Array.isArray(activeCoinModule.currencyUnits) && global.currencyTypes && global.currencyTypes.sat) {
		const midUnit = activeCoinModule.currencyUnits.find(u => u && u.name && /^(swartz|finney|szabo|wei)$/i.test(u.name));
		if (midUnit) {
			global.currencyTypes.sat.name = midUnit.name;
			global.currencyTypes.sat.multiplier = midUnit.multiplier;
			global.currencyTypes.sat.decimalPlaces = midUnit.decimalPlaces;
			global.currencyTypes[midUnit.name.toLowerCase()] = global.currencyTypes.sat;
		}
	}
}

const package_json = require('./package.json');
global.appVersion = package_json.version;
global.cacheId = global.appVersion;
debugLog(`Default cacheId '${global.cacheId}'`);

global.btcNodeSemver = "0.0.0";


const cleanupRouter = require('./routes/cleanupRouter.js');
const baseActionsRouter = require('./routes/baseRouter.js');
const internalApiActionsRouter = require('./routes/internalApiRouter.js');
const apiActionsRouter = require('./routes/apiRouter.js');
const snippetActionsRouter = require('./routes/snippetRouter.js');
const adminActionsRouter = require('./routes/adminRouter.js');
const testActionsRouter = require('./routes/testRouter.js');

const expressApp = express();


const statTracker = require("./app/statTracker.js");

const statsProcessFunction = (name, stats) => {
	appStats.trackAppStats(name, stats);
	
	if (process.env.STATS_API_URL) {
		const data = Object.assign({}, stats);
		data.name = name;

		axios.post(process.env.STATS_API_URL, data)
		.then(res => { /*console.log(res.data);*/ })
		.catch(error => {
			utils.logError("38974wrg9w7dsgfe", error);
		});
	}
};

const processStatsInterval = setInterval(() => {
	statTracker.processAndReset(
		statsProcessFunction,
		statsProcessFunction,
		statsProcessFunction);

}, process.env.STATS_PROCESS_INTERVAL || (5 * 60 * 1000));
	
// Don't keep Node.js process up
processStatsInterval.unref();



const systemMonitor = require("./app/systemMonitor.js");

const normalizeActions = require("./app/normalizeActions.js");
expressApp.use(require("./app/actionPerformanceMonitor.js")(statTracker, {
	ignoredEndsWithActions: /\.js|\.css|\.svg|\.png|\.woff2/,
	ignoredStartsWithActions: `${config.baseUrl}snippet`,
	normalizeAction: (action) => {
		return normalizeActions(config.baseUrl, action);
	},
}));

// view engine setup
expressApp.set('views', path.join(__dirname, 'views'));

// ref: https://blog.stigok.com/post/disable-pug-debug-output-with-expressjs-web-app
expressApp.engine('pug', (path, options, fn) => {
	options.debug = false;
	return pug.__express.call(null, path, options, fn);
});

expressApp.set('view engine', 'pug');

if (process.env.NODE_ENV != "local") {
	// enable view cache regardless of env (development/production)
	// ref: https://pugjs.org/api/express.html
	debugLog("Enabling view caching (performance will be improved but template edits will not be reflected)")
	expressApp.enable('view cache');
}

expressApp.use(cookieParser());

expressApp.disable('x-powered-by');


if (process.env.BTCEXP_BASIC_AUTH_PASSWORD) {
	// basic http authentication
	expressApp.use(auth(process.env.BTCEXP_BASIC_AUTH_PASSWORD));

} else if (process.env.BTCEXP_SSO_TOKEN_FILE) {
	// sso authentication
	expressApp.use(sso(process.env.BTCEXP_SSO_TOKEN_FILE, process.env.BTCEXP_SSO_LOGIN_REDIRECT_URL));
}

// uncomment after placing your favicon in /public
//expressApp.use(favicon(__dirname + '/public/favicon.ico'));
//expressApp.use(logger('dev'));
expressApp.use(bodyParser.json());
expressApp.use(bodyParser.urlencoded({ extended: false }));


const sessionConfig = {
	secret: config.cookieSecret,
	resave: false,
	saveUninitialized: true,
	cookie: {
		secure: config.secureSite
	}
};

if (config.secureSite) {
	expressApp.set('trust proxy', 1);
}

// Helpful reference for production: nginx HTTPS proxy:
// https://gist.github.com/nikmartin/5902176
debugLog(`Session config: ${JSON.stringify(utils.obfuscateProperties(sessionConfig, ["secret"]))}`);

sessionConfig.store = new MemoryStore({
	checkPeriod: 86400000 // prune expired entries every 24h
});


expressApp.use(session(sessionConfig));

expressApp.use(compression());

expressApp.use(config.baseUrl, express.static(path.join(__dirname, 'public'), {
	maxAge: 30 * 24 * 60 * 60 * 1000
}));


// https://www.npmjs.com/package/express-rate-limit
const rateLimitWindowMinutes = config.rateLimiting.windowMinutes;
const rateLimitWindowMaxRequests = config.rateLimiting.windowMaxRequests;

if (rateLimitWindowMinutes == -1) {
	debugLog("Disabling rate limiting");

} else {
	debugLog(`Enabling rate limiting: ${rateLimitWindowMaxRequests} requests per ${rateLimitWindowMinutes}min`);

	const rateLimiter = rateLimit({
		windowMs: rateLimitWindowMinutes * 60 * 1000, // 15 minutes
		limit: rateLimitWindowMaxRequests, // Limit each IP to 100 requests per `window` (here, per 15 minutes).
		standardHeaders: 'draft-7', // draft-6: `RateLimit-*` headers; draft-7: combined `RateLimit` header
		legacyHeaders: false, // Disable the `X-RateLimit-*` headers.
		skip: function (req, res) {
			// tor traffic all comes in via tor proxy showing 127.0.0.1
			// for now, until we identify it as a serious problem, let it pass
			if (req.hostname.includes(".onion")) {
				utils.trackAppEvent("torRequest");

				return true;
			}

			if (req.originalUrl.includes("/snippet/")) {
				return true;
			}

			if (req.originalUrl.includes("/api/")) {
				return true;
			}

			return false;
		},
		handler: function (req, res, next) {
			debugErrorLog(`Rate-limiting request: req=${JSON.stringify(utils.expressRequestToJson(req))}`);

			utils.trackAppEvent("rateLimitedRequest");

			res.status(429).json({
				message: "Too many requests, please try again later.",
			});
		}
	});

	// Apply the rate limiting middleware to all requests.
	expressApp.use(rateLimiter);
}


if (config.baseUrl != '/') {
	expressApp.get('/', (req, res) => res.redirect(config.baseUrl));
}


// if a CDN is configured, these assets will be uploaded at launch, then referenced from there
const cdnItems = [
	[`style/dark.min.css`, `text/css`, "utf8"],
	[`style/light.min.css`, `text/css`, "utf8"],
	[`style/dark-v1.min.css`, `text/css`, "utf8"],
	[`style/highlight.min.css`, `text/css`, "utf8"],
	[`style/dataTables.bootstrap4.min.css`, `text/css`, "utf8"],
	[`style/bootstrap-icons.css`, `text/css`, "utf8"],

	[`js/bootstrap.bundle.min.js`, `text/javascript`, "utf8"],
	[`js/chart.min.js`, `text/javascript`, "utf8"],
	[`js/jquery.min.js`, `text/javascript`, "utf8"],
	[`js/site.js`, `text/javascript`, "utf8"],
	[`js/highlight.min.js`, `text/javascript`, "utf8"],
	[`js/chartjs-adapter-moment.min.js`, `text/javascript`, "utf8"],
	[`js/jquery.dataTables.min.js`, `text/javascript`, "utf8"],
	[`js/dataTables.bootstrap4.min.js`, `text/javascript`, "utf8"],
	[`js/moment.min.js`, `text/javascript`, "utf8"],
	[`js/sentry.min.js`, `text/javascript`, "utf8"],
	[`js/decimal.js`, `text/javascript`, "utf8"],

	[`img/network-mainnet/logo.svg`, `image/svg+xml`, "utf8"],
	[`img/network-mainnet/coin-icon.svg`, `image/svg+xml`, "utf8"],
	[`img/network-mainnet/apple-touch-icon.png`, `image/png`, "binary"],
	[`img/network-mainnet/favicon-16x16.png`, `image/png`, "binary"],
	[`img/network-mainnet/favicon-32x32.png`, `image/png`, "binary"],
	[`img/network-testnet/logo.svg`, `image/svg+xml`, "utf8"],
	[`img/network-testnet/coin-icon.svg`, `image/svg+xml`, "utf8"],
	[`img/network-signet/logo.svg`, `image/svg+xml`, "utf8"],
	[`img/network-signet/coin-icon.svg`, `image/svg+xml`, "utf8"],
	[`img/network-regtest/logo.svg`, `image/svg+xml`, "utf8"],
	[`img/network-regtest/coin-icon.svg`, `image/svg+xml`, "utf8"],

	[`img/network-mainnet/favicon.ico`, `image/x-icon`, "binary"],
	[`img/network-testnet/favicon.ico`, `image/x-icon`, "binary"],
	[`img/network-signet/favicon.ico`, `image/x-icon`, "binary"],
	[`img/network-regtest/favicon.ico`, `image/x-icon`, "binary"],

	[`font/bootstrap-icons.woff`, `font/woff`, "binary"],
	[`font/bootstrap-icons.woff2`, `font/woff2`, "binary"],

	[`leaflet/leaflet.js`, `text/javascript`, "utf8"],
	[`leaflet/leaflet.css`, `text/css`, "utf8"],
	[`leaflet/images/layers.png`, `image/png`, "binary"],
	[`leaflet/images/layers-2x.png`, `image/png`, "binary"],
	[`leaflet/images/marker-icon-2x.png`, `image/png`, "binary"],
	[`leaflet/images/marker-icon.png`, `image/png`, "binary"],
	[`leaflet/images/marker-shadow.png`, `image/png`, "binary"],
];

const cdnFilepathMap = {};
cdnItems.forEach(item => {
	cdnFilepathMap[item[0]] = true;
});


process.on("unhandledRejection", (reason, p) => {
	debugLog("Unhandled Rejection at: Promise", p, "reason:", reason, "stack:", (reason != null ? reason.stack : "null"));
});

function loadMiningPoolConfigs() {
	debugLog("Loading mining pools config");

	global.miningPoolsConfigs = [];

	var miningPoolsConfigDir = path.join(__dirname, "public", "txt", "mining-pools-configs", global.coinConfig.ticker);

	fs.readdir(miningPoolsConfigDir, function(err, files) {
		if (err) {
			utils.logError("3ufhwehe", err, {configDir:miningPoolsConfigDir, desc:"Unable to scan directory"});

			return;
		}

		files.forEach(function(file) {
			var filepath = path.join(miningPoolsConfigDir, file);

			var contents = fs.readFileSync(filepath, 'utf8');

			global.miningPoolsConfigs.push(JSON.parse(contents));
		});

		for (var i = 0; i < global.miningPoolsConfigs.length; i++) {
			for (var x in global.miningPoolsConfigs[i].payout_addresses) {
				if (global.miningPoolsConfigs[i].payout_addresses.hasOwnProperty(x)) {
					global.specialAddresses[x] = {type:"minerPayout", minerInfo:global.miningPoolsConfigs[i].payout_addresses[x]};
				}
			}
		}
	});
}

async function getSourcecodeProjectMetadata() {
	var options = {
		url: "https://api.github.com/repos/janoside/btc-rpc-explorer",
		headers: {
			'User-Agent': 'request'
		}
	};
	try {
		const response = await axios(options);

		global.sourcecodeProjectMetadata = response.data;

	} catch (err) {
		utils.logError("3208fh3ew7eghfg", err);
		}
}

function loadChangelog() {
	var filename = "CHANGELOG.md";
	
	fs.readFile(path.join(__dirname, filename), 'utf8', function(err, data) {
		if (err) {
			utils.logError("2379gsd7sgd334", err);

		} else {
			global.changelogMarkdown = data;
		}
	});


	var filename = "CHANGELOG-API.md";
	
	fs.readFile(path.join(__dirname, filename), 'utf8', function(err, data) {
		if (err) {
			utils.logError("ouqhuwey723", err);

		} else {
			global.apiChangelogMarkdown = data;
		}
	});

	// Operator/user-facing doc: explains how the /name/<n> page builds
	// name history (name_history RPC vs chain-walk reconstruction). Loaded
	// once at boot and rendered by the /docs/name-history route.
	fs.readFile(path.join(__dirname, "docs", "name-history.md"), 'utf8', function(err, data) {
		if (err) {
			utils.logError("loadNameHistoryDoc", err);
		} else {
			global.nameHistoryDocMarkdown = data;
		}
	});
}

function loadHistoricalDataForChain(chain) {
	debugLog(`Loading historical data for chain=${chain}`);

	if (global.coinConfig.historicalData) {
		global.coinConfig.historicalData.forEach(function(item) {
			if (item.chain == chain) {
				if (item.type == "blockheight") {
					global.specialBlocks[item.blockHash] = item;

				} else if (item.type == "tx") {
					global.specialTransactions[item.txid] = item;

				} else if (item.type == "address" || item.address) {
					global.specialAddresses[item.address] = {type:"fun", addressInfo:item};
				}
			}
		});
	}
}

function loadHolidays(chain) {
	debugLog(`Loading holiday data`);

	global.btcHolidays = btcHolidays;
	global.btcHolidays.byDay = {};
	global.btcHolidays.sortedDays = [];
	global.btcHolidays.sortedItems = [...btcHolidays.items];
	global.btcHolidays.sortedItems.sort((a, b) => a.date.localeCompare(b.date));

	global.btcHolidays.items.forEach(function(item) {
		let day = item.date.substring(5);

		if (!global.btcHolidays.sortedDays.includes(day)) {
			global.btcHolidays.sortedDays.push(day);
			global.btcHolidays.sortedDays.sort();
		}

		if (global.btcHolidays.byDay[day] == undefined) {
			global.btcHolidays.byDay[day] = [];
		}

		global.btcHolidays.byDay[day].push(item);
	});
}

function verifyRpcConnection() {
	if (!global.activeBlockchain) {
		debugLog(`Verifying RPC connection...`);

		// normally in application code we target coreApi, but here we're trying to
		// verify the RPC connection so we target rpcApi directly and include
		// the second parameter "verifyingConnection=true", to bypass a
		// fail-if-were-not-connected check

		Promise.all([
			rpcApi.getRpcData("getnetworkinfo", true),
			rpcApi.getRpcData("getblockchaininfo", true),
		]).then(([ getnetworkinfo, getblockchaininfo ]) => {
			global.activeBlockchain = getblockchaininfo.chain;

			// we've verified rpc connection, no need to keep trying
			clearInterval(global.verifyRpcConnectionIntervalId);

			onRpcConnectionVerified(getnetworkinfo, getblockchaininfo);

		}).catch(function(err) {
			utils.logError("32ugegdfsde", err);
		});
	}
}

async function onRpcConnectionVerified(getnetworkinfo, getblockchaininfo) {
	// localservicenames introduced in 0.19
	var services = getnetworkinfo.localservicesnames ? ("[" + getnetworkinfo.localservicesnames.join(", ") + "]") : getnetworkinfo.localservices;

	global.rpcConnected = true;
	global.getnetworkinfo = getnetworkinfo;

	if (getblockchaininfo.pruned) {
		global.prunedBlockchain = true;
		global.pruneHeight = getblockchaininfo.pruneheight;
	}

	var bitcoinCoreVersionRegex = /^.*\/Satoshi\:(.*)\/.*$/;

	var match = bitcoinCoreVersionRegex.exec(getnetworkinfo.subversion);
	if (match) {
		global.btcNodeVersion = match[1];

		var semver4PartRegex = /^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$/;

		var semver4PartMatch = semver4PartRegex.exec(global.btcNodeVersion);
		if (semver4PartMatch) {
			var p0 = semver4PartMatch[1];
			var p1 = semver4PartMatch[2];
			var p2 = semver4PartMatch[3];
			var p3 = semver4PartMatch[4];

			// drop last segment, which usually indicates a bug fix release which is (hopefully) irrelevant for RPC API versioning concerns
			global.btcNodeSemver = `${p0}.${p1}.${p2}`;

		} else {
			var semver3PartRegex = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;

			var semver3PartMatch = semver3PartRegex.exec(global.btcNodeVersion);
			if (semver3PartMatch) {
				var p0 = semver3PartMatch[1];
				var p1 = semver3PartMatch[2];
				var p2 = semver3PartMatch[3];

				global.btcNodeSemver = `${p0}.${p1}.${p2}`;

			} else {
				// short-circuit: force all RPC calls to pass their version checks - this will likely lead to errors / instability / unexpected results
				global.btcNodeSemver = "1000.1000.0"
			}
		}
	} else {
		// short-circuit: force all RPC calls to pass their version checks - this will likely lead to errors / instability / unexpected results
		global.btcNodeSemver = "1000.1000.0"

		debugErrorLog(`Unable to parse node version string: ${getnetworkinfo.subversion} - RPC versioning will likely be unreliable. Is your node a version of Bitcoin Core?`);
	}
	
	debugLog(`RPC Connected: version=${getnetworkinfo.version} subversion=${getnetworkinfo.subversion}, parsedVersion(used for RPC versioning)=${global.btcNodeSemver}, protocolversion=${getnetworkinfo.protocolversion}, chain=${getblockchaininfo.chain}, services=${services}`);

	
	// load historical/fun items for this chain
	loadHistoricalDataForChain(global.activeBlockchain);

	loadHolidays();

	if (global.activeBlockchain == "main") {
		loadDifficultyHistory(getblockchaininfo.blocks);

		// refresh difficulty history periodically
		// TODO: refresh difficulty history when there's a new block and height % 2016 == 0
		setInterval(loadDifficultyHistory, 15 * 60 * 1000);


		if (global.exchangeRates == null) {
			utils.refreshExchangeRates();
		}

		// refresh exchange rate periodically
		setInterval(utils.refreshExchangeRates, 1800000);
	}


	// 1d / 7d volume
	refreshNetworkVolumes();
	setInterval(refreshNetworkVolumes, 30 * 60 * 1000);


	await assessTxindexAvailability();


	// UTXO pull
	refreshUtxoSetSummary();
	setInterval(refreshUtxoSetSummary, 30 * 60 * 1000);

	// Namecoin: walk name_scan once per 30 min so the explorer always has a
	// fresh count of registered names (active + expired) and per-namespace
	// breakdown. The scan can take 1–2 minutes on a busy chain, so it lives
	// off the request path.
	refreshNamesSummary();
	setInterval(refreshNamesSummary, 30 * 60 * 1000);

	// Namecoin: walk the last ~2016 blocks and collect every name_firstupdate
	// op in that window so the /names "New Names" section can render brand-new
	// registrations alongside the expiring/recently-expired sections (which
	// already share the same 2016-block window). Block fetches hit the
	// existing 15-min coreApi blockCache, so the steady-state cost after the
	// first run is just the new-tip blocks since the previous refresh.
	refreshRecentFirstUpdates();
	setInterval(refreshRecentFirstUpdates, 30 * 60 * 1000);

	// Namecoin: walk a much wider lookback window (default ~1 year), collect
	// every `name_firstupdate` op, and check each one against `name_show` to
	// keep only those still active. Result feeds the /names "Oldest Active
	// Names" section. Materially more expensive than the 30-min refreshes
	// (one `name_show` per candidate firstupdate), so it runs on a 60-min
	// cadence and is gated behind the same disable flag.
	refreshOldestActiveNames();
	setInterval(refreshOldestActiveNames, 60 * 60 * 1000);

	// Namecoin: walk the last ~24h of blocks and count which transactions
	// carry name operations vs which are pure currency txs. Same off-the-
	// request-path pattern; the tx-stats page reads from the cached value.
	refreshNameTxStats();
	setInterval(refreshNameTxStats, 10 * 60 * 1000);



	if (false) {
		monitorNewTransactions().catch(err => console.error(err));

		//sock.subscribe('rawtx');
	}
}

async function monitorNewTransactions() {
	const zmq = require("zeromq");
	const sock = new zmq.Subscriber();

	sock.connect("tcp://ubuntu:28333");
	console.log("Worker connected to port 28333");

	// Subscribe to all topics (use sock.subscribe("specific_topic") for specific topics)
	sock.subscribe();

	for await (const [topic, message] of sock) {
		utils.trackAppEvent("newTransaction");

		console.log(
			topic.toString("ascii") +
			" - " +
			message.toString("hex")
		);
	}
}

async function loadDifficultyHistory(tipBlockHeight=null) {
	if (!tipBlockHeight) {
		let getblockchaininfo = await coreApi.getBlockchainInfo();

		tipBlockHeight = getblockchaininfo.blocks;
	}

	if (config.slowDeviceMode) {
		debugLog("Skipping performance-intensive task: load difficulty history. This is skipped due to the flag 'slowDeviceMode' which defaults to 'true' to protect slow nodes. Set this flag to 'false' to enjoy difficulty history details.");

		return;
	}

	let height = 0;
	let heights = [];

	while (height <= tipBlockHeight) {
		heights.push(height);
		height += global.coinConfig.difficultyAdjustmentBlockCount;
	}

	global.difficultyHistory = await coreApi.getDifficultyByBlockHeights(heights);
	
	global.athDifficulty = 0;
	for (let i = 0; i < heights.length; i++) {
		if (global.difficultyHistory[`${heights[i]}`].difficulty > global.athDifficulty) {	
			global.athDifficulty = global.difficultyHistory[heights[i]].difficulty;
		}
	}

	debugLog("ATH difficulty: " + global.athDifficulty);
}

var txindexCheckCount = 0;
async function assessTxindexAvailability() {
	// Here we try to call getindexinfo to assess availability of txindex
	// However, getindexinfo RPC is only available in v0.21+, so the call
	// may return an "unsupported" error. If/when it does, we will fall back
	// to assessing txindex availability by querying a known txid
	debugLog("txindex check: trying getindexinfo");

	try {
		global.getindexinfo = await coreApi.getIndexInfo();

		debugLog(`txindex check: getindexinfo=${JSON.stringify(global.getindexinfo)}`);

		if (global.getindexinfo.txindex) {
			// getindexinfo was available, and txindex is also available...easy street
			
			global.txindexAvailable = true;

			debugLog("txindex check: available!");

		} else if (global.getindexinfo.minRpcVersionNeeded) {
			// here we find out that getindexinfo is unavailable on our node because
			// we're running pre-v0.21, so we fall back to querying a known txid
			// to assess txindex availability

			debugLog("txindex check: getindexinfo unavailable, trying txid lookup");

			try {
				// lookup a known TXID as a test for whether txindex is available
				let knownTx = await coreApi.getRawTransaction(coinConfig.knownTransactionsByNetwork[global.activeBlockchain]);

				// if we get here without an error being thrown, we know we're able to look up by txid
				// thus, txindex is available
				global.txindexAvailable = true;

				debugLog("txindex check: available! (pre-v0.21)");

			} catch (e) {
				// here we were unable to query by txid, so we believe txindex is unavailable
				global.txindexAvailable = false;

				debugLog("txindex check: unavailable");
			}
		} else {
			// here getindexinfo is available (i.e. we're on v0.21+), but txindex is NOT available
			global.txindexAvailable = false;

			debugLog("txindex check: unavailable");
		}
	} catch (e) {
		utils.logError("o2328ryw8wsde", e);

		var retryTime = parseInt(Math.min(15 * 60 * 1000, 1000 * 10 * Math.pow(2, txindexCheckCount)));
		txindexCheckCount++;

		debugLog(`txindex check: error in rpc getindexinfo; will try again in ${retryTime}ms`);

		// try again in 5 mins
		setTimeout(assessTxindexAvailability, retryTime);
	}
}

async function refreshNameTxStats() {
	if (process.env.BTCEXP_DISABLE_NAME_TX_STATS === "true") {
		debugLog("refreshNameTxStats disabled via BTCEXP_DISABLE_NAME_TX_STATS env var");
		global.nameTxStats = null;
		return;
	}
	try {
		const chainInfo = await coreApi.getBlockchainInfo();
		const tipHeight = chainInfo.blocks;
		const windowSize = 144;
		const startHeight = Math.max(0, tipHeight - windowSize + 1);
		const startedAt = Date.now();
		let totalTx = 0;
		let nameTx = 0;
		const opCounts = { name_new: 0, name_firstupdate: 0, name_update: 0 };
		let earliestTime = null;
		let latestTime = null;
		for (let h = startHeight; h <= tipHeight; h++) {
			let block;
			try {
				block = await coreApi.getBlockByHeight(h);
			} catch (_e) {
				continue;
			}
			if (!block || !Array.isArray(block.tx)) continue;
			if (typeof block.time === "number") {
				if (earliestTime === null || block.time < earliestTime) earliestTime = block.time;
				if (latestTime === null || block.time > latestTime) latestTime = block.time;
			}
			for (const tx of block.tx) {
				if (typeof tx === "string") { totalTx++; continue; }
				totalTx++;
				let hasNameOp = false;
				if (Array.isArray(tx.vout)) {
					for (const out of tx.vout) {
						const no = out && out.scriptPubKey && out.scriptPubKey.nameOp;
						if (no && no.op) {
							hasNameOp = true;
							if (opCounts[no.op] !== undefined) opCounts[no.op]++;
						}
					}
				}
				if (hasNameOp) nameTx++;
			}
		}
		const elapsedMs = Date.now() - startedAt;
		const windowSeconds = (earliestTime !== null && latestTime !== null) ? Math.max(latestTime - earliestTime, 1) : windowSize * 600;
		global.nameTxStats = {
			windowBlocks: windowSize,
			windowStartHeight: startHeight,
			windowEndHeight: tipHeight,
			windowStartTime: earliestTime,
			windowEndTime: latestTime,
			windowSeconds,
			totalTxCount: totalTx,
			nameTxCount: nameTx,
			currencyTxCount: Math.max(totalTx - nameTx, 0),
			opCounts,
			nameTxFraction: totalTx > 0 ? nameTx / totalTx : 0,
			nameTxRate: nameTx / windowSeconds,
			currencyTxRate: Math.max(totalTx - nameTx, 0) / windowSeconds,
			scannedAt: Date.now(),
			elapsedMs,
		};
		debugLog(`Refreshed name-tx stats: ${nameTx}/${totalTx} name txs in last ${windowSize} blocks (${(global.nameTxStats.nameTxFraction * 100).toFixed(2)}%) in ${elapsedMs}ms`);
	} catch (e) {
		debugLog("refreshNameTxStats error: " + e.message);
		global.nameTxStats = null;
	}
}

async function refreshNamesSummary() {
	// Note: this scan runs ONCE every 30 min in the background, never on the
	// request path. We deliberately do NOT gate this on `slowDeviceMode` —
	// the scan is the only way to surface a name count, and the cost is paid
	// at most every 30 min. Operators who really want zero RPC cost can flip
	// `BTCEXP_DISABLE_NAMES_SUMMARY=true`.
	if (process.env.BTCEXP_DISABLE_NAMES_SUMMARY === "true") {
		debugLog("refreshNamesSummary disabled via BTCEXP_DISABLE_NAMES_SUMMARY env var");
		global.namesSummary = null;
		return;
	}
	global.namesSummaryPending = true;
	try {
		// Optional env-var overrides for the expiry window thresholds. Both
		// default to ~30 days (4320 blocks) when unset; operators wiring this
		// up against a non-mainnet chain (faster blocks) can shrink the window
		// without rebuilding.
		const opts = {};
		const expSoon = parseInt(process.env.BTCEXP_NAMES_EXPIRING_SOON_BLOCKS, 10);
		if (Number.isFinite(expSoon) && expSoon > 0) opts.expiringSoonBlocks = expSoon;
		const expRecent = parseInt(process.env.BTCEXP_NAMES_RECENTLY_EXPIRED_BLOCKS, 10);
		if (Number.isFinite(expRecent) && expRecent > 0) opts.recentlyExpiredBlocks = expRecent;
		global.namesSummary = await nameApi.getNamesSummary(opts);
		debugLog(`Refreshed names summary: total=${global.namesSummary.total} active=${global.namesSummary.active} expired=${global.namesSummary.expired} expiringSoon=${global.namesSummary.expiringSoonTotal} recentlyExpired=${global.namesSummary.recentlyExpiredTotal} elapsedMs=${global.namesSummary.elapsedMs}`);
	} catch (e) {
		debugLog("refreshNamesSummary error: " + e.message);
		global.namesSummary = null;
	} finally {
		global.namesSummaryPending = false;
	}
}

async function refreshRecentFirstUpdates() {
	// Same env-var escape hatch as refreshNamesSummary: operators who don't
	// want any background name walking can disable both with a single flag.
	if (process.env.BTCEXP_DISABLE_NAMES_SUMMARY === "true") {
		debugLog("refreshRecentFirstUpdates disabled via BTCEXP_DISABLE_NAMES_SUMMARY env var");
		global.recentFirstUpdates = null;
		return;
	}
	global.recentFirstUpdatesPending = true;
	try {
		// Window threshold defaults to 2016 blocks (matching the expiry
		// sections). Operators on a non-mainnet chain (faster blocks) can
		// override via BTCEXP_NAMES_RECENT_FIRSTUPDATE_BLOCKS without
		// rebuilding.
		const opts = {};
		const win = parseInt(process.env.BTCEXP_NAMES_RECENT_FIRSTUPDATE_BLOCKS, 10);
		if (Number.isFinite(win) && win > 0) opts.windowBlocks = win;
		global.recentFirstUpdates = await nameApi.getRecentNameFirstUpdates(opts);
		debugLog(`Refreshed recent firstupdates: total=${global.recentFirstUpdates.total} listed=${global.recentFirstUpdates.items.length} window=${global.recentFirstUpdates.windowBlocks} elapsedMs=${global.recentFirstUpdates.elapsedMs}`);
	} catch (e) {
		debugLog("refreshRecentFirstUpdates error: " + e.message);
		global.recentFirstUpdates = null;
	} finally {
		global.recentFirstUpdatesPending = false;
	}
}

async function refreshOldestActiveNames() {
	// Same env-var escape hatch as refreshNamesSummary / refreshRecentFirstUpdates.
	if (process.env.BTCEXP_DISABLE_NAMES_SUMMARY === "true") {
		debugLog("refreshOldestActiveNames disabled via BTCEXP_DISABLE_NAMES_SUMMARY env var");
		global.oldestActiveNames = null;
		return;
	}
	global.oldestActiveNamesPending = true;
	try {
		// Defaults: scan the entire chain from genesis (windowBlocks=null) with
		// listCap=50. The function early-exits as soon as listCap actives are
		// confirmed (oldest-first), so the typical refresh cost is bounded by
		// listCap regardless of chain height. All knobs env-overridable:
		//   BTCEXP_NAMES_OLDEST_LOOKBACK_BLOCKS  — limit search to last N blocks (legacy)
		//   BTCEXP_NAMES_OLDEST_FROM_HEIGHT      — explicit start height (overrides lookback)
		//   BTCEXP_NAMES_OLDEST_LIST_CAP         — how many oldest-still-active to keep
		//   BTCEXP_NAMES_OLDEST_BATCH_SIZE       — parallel block fetches per batch
		const opts = {};
		const win = parseInt(process.env.BTCEXP_NAMES_OLDEST_LOOKBACK_BLOCKS, 10);
		if (Number.isFinite(win) && win > 0) opts.windowBlocks = win;
		const from = parseInt(process.env.BTCEXP_NAMES_OLDEST_FROM_HEIGHT, 10);
		if (Number.isFinite(from) && from >= 0) opts.fromHeight = from;
		const cap = parseInt(process.env.BTCEXP_NAMES_OLDEST_LIST_CAP, 10);
		if (Number.isFinite(cap) && cap > 0) opts.listCap = cap;
		const batch = parseInt(process.env.BTCEXP_NAMES_OLDEST_BATCH_SIZE, 10);
		if (Number.isFinite(batch) && batch > 0) opts.batchSize = batch;
		global.oldestActiveNames = await nameApi.getOldestActiveNames(opts);
		debugLog(`Refreshed oldest active names: candidates=${global.oldestActiveNames.totalCandidates} active=${global.oldestActiveNames.totalActive} listed=${global.oldestActiveNames.items.length} fromHeight=${global.oldestActiveNames.fromHeight} toHeight=${global.oldestActiveNames.toHeight} earlyExit=${global.oldestActiveNames.earlyExit} elapsedMs=${global.oldestActiveNames.elapsedMs}`);
	} catch (e) {
		debugLog("refreshOldestActiveNames error: " + e.message);
		global.oldestActiveNames = null;
	} finally {
		global.oldestActiveNamesPending = false;
	}
}

async function refreshUtxoSetSummary() {
	// Even on slow-device-mode nodes WITHOUT coinstatsindex we do still want
	// the UTXO summary populated — otherwise the on-disk file cache (used by
	// the /utxo-set page when `global.utxoSetSummary` is null) ages out and
	// the page silently shows hours-old data. The slow `gettxoutsetinfo`
	// call (~88s on Namecoin without coinstatsindex) runs on the dedicated
	// no-timeout RPC client off the request path, on a 30-min interval, so
	// it doesn't affect interactive page loads. The original skip behaviour
	// only made sense when the explorer had no other way to surface the data.
	if (config.slowDeviceMode) {
		if (!global.getindexinfo || !global.getindexinfo.coinstatsindex) {
			debugLog("refreshUtxoSetSummary: slowDeviceMode=true and no coinstatsindex; running anyway via no-timeout RPC client so the file cache stays fresh.");
			// fall through to the refresh below
		}
	}

	// flag that we're working on calculating UTXO details (to differentiate cases where we don't have the details and we're not going to try computing them)
	global.utxoSetSummaryPending = true;

	try {
		global.utxoSetSummary = await coreApi.getUtxoSetSummary(true, false);
		debugLog("Refreshed utxo summary: lastUpdated=" + (global.utxoSetSummary && global.utxoSetSummary.lastUpdated));
	} catch (e) {
		utils.logError("refreshUtxoSetSummary failed", e);
	} finally {
		global.utxoSetSummaryPending = false;
	}
}

function refreshNetworkVolumes() {
	if (config.slowDeviceMode) {
		debugLog("Skipping performance-intensive task: fetch last 24 hrs of blockstats to calculate transaction volume. This is skipped due to the flag 'slowDeviceMode' which defaults to 'true' to protect slow nodes. Set this flag to 'false' to enjoy UTXO set summary details.");

		return;
	}

	var cutoff1d = new Date().getTime() - (60 * 60 * 24 * 1000);
	var cutoff7d = new Date().getTime() - (60 * 60 * 24 * 7 * 1000);

	coreApi.getBlockchainInfo().then(function(result) {
		var promises = [];

		var blocksPerDay = 144 + 20; // 20 block padding

		for (var i = 0; i < (blocksPerDay * 1); i++) {
			if (result.blocks - i >= 0) {
				promises.push(coreApi.getBlockStatsByHeight(result.blocks - i));
			}
		}

		var startBlock = result.blocks;

		var endBlock1d = result.blocks;
		var endBlock7d = result.blocks;

		var endBlockTime1d = 0;
		var endBlockTime7d = 0;

		Promise.all(promises).then(function(results) {
			var volume1d = new Decimal(0);
			var volume7d = new Decimal(0);

			var blocks1d = 0;
			var blocks7d = 0;

			if (results && results.length > 0 && results[0] != null) {
				for (var i = 0; i < results.length; i++) {
					if (results[i].time * 1000 > cutoff1d) {
						volume1d = volume1d.plus(new Decimal(results[i].total_out));
						volume1d = volume1d.plus(new Decimal(results[i].subsidy));
						volume1d = volume1d.plus(new Decimal(results[i].totalfee));
						blocks1d++;

						endBlock1d = results[i].height;
						endBlockTime1d = results[i].time;
					}

					if (results[i].time * 1000 > cutoff7d) {
						volume7d = volume7d.plus(new Decimal(results[i].total_out));
						volume7d = volume7d.plus(new Decimal(results[i].subsidy));
						volume7d = volume7d.plus(new Decimal(results[i].totalfee));
						blocks7d++;

						endBlock7d = results[i].height;
						endBlockTime7d = results[i].time;
					}
				}

				volume1d = volume1d.dividedBy(coinConfig.baseCurrencyUnit.multiplier);
				volume7d = volume7d.dividedBy(coinConfig.baseCurrencyUnit.multiplier);

				global.networkVolume = {d1:{amt:volume1d, blocks:blocks1d, startBlock:startBlock, endBlock:endBlock1d, startTime:results[0].time, endTime:endBlockTime1d}};

				debugLog(`Network volume: ${JSON.stringify(global.networkVolume)}`);

			} else {
				debugLog("Unable to load network volume, likely due to bitcoind version older than 0.17.0 (the first version to support getblockstats).");
			}
		});
	});
}


expressApp.onStartup = async () => {
	global.appStartTime = new Date().getTime();
	
	global.config = config;
	global.coinConfig = coins[config.coin];
	global.coinConfigs = coins;

	global.SATS_PER_BTC = global.coinConfig.baseCurrencyUnit.multiplier;

	global.specialTransactions = {};
	global.specialBlocks = {};
	global.specialAddresses = {};

	loadChangelog();

	global.nodeVersion = process.version;
	debugLog(`Environment(${expressApp.get("env")}) - Node: ${process.version}, Platform: ${process.platform}, Versions: ${JSON.stringify(process.versions)}`);


	// dump "startup" heap after 5sec
	if (false) {
		(function () {
			var callback = function() {
				debugLog("Waited 5 sec after startup, now dumping 'startup' heap...");

				const filename = `./heapDumpAtStartup-${Date.now()}.heapsnapshot`;
				const heapdumpStream = v8.getHeapSnapshot();
				const fileStream = fs.createWriteStream(filename);
				heapdumpStream.pipe(fileStream);

				debugLog("Heap dump at startup written to", filename);
			};

			setTimeout(callback, 5000);
		})();
	}
	

	if (global.sourcecodeVersion == null && fs.existsSync('.git')) {
		try {
			let log = await simpleGit(".").log(["-n 1"]);

			global.sourcecodeVersion = log.all[0].hash.substring(0, 10);
			global.sourcecodeDate = log.all[0].date.substring(0, "0000-00-00".length);

			global.cacheId = `${global.sourcecodeDate}-${global.sourcecodeVersion}`;

			debugLog(`Using sourcecode metadata as cacheId: '${global.cacheId}'`);

			debugLog(`Starting ${global.coinConfig.ticker} RPC Explorer, v${global.appVersion} (commit: '${global.sourcecodeVersion}', date: ${global.sourcecodeDate}) at http://${config.host}:${config.port}${config.baseUrl}`);


		} catch (err) {
			utils.logError("3fehge9ee", err, {desc:"Error accessing git repo"});

			global.cacheId = global.appVersion;
			debugLog(`Error getting sourcecode version, continuing to use default cacheId '${global.cacheId}'`);

			debugLog(`Starting ${global.coinConfig.ticker} RPC Explorer, v${global.appVersion} (code: unknown commit) at http://${config.host}:${config.port}${config.baseUrl}`);
		}
		
		expressApp.continueStartup();

	} else {
		global.cacheId = global.appVersion;
		debugLog(`No sourcecode version available, continuing to use default cacheId '${global.cacheId}'`);

		debugLog(`Starting ${global.coinConfig.ticker} RPC Explorer, v${global.appVersion} at http://${config.host}:${config.port}${config.baseUrl}`);

		expressApp.continueStartup();
	}

	if (config.cdn.active && config.cdn.s3Bucket) {
		debugLog(`Configuring CDN assets; uploading ${cdnItems.length} assets to S3...`);

		const s3Path = (filepath) => { return `${global.cacheId}/${filepath}`; }

		const uploadedItems = [];
		const existingItems = [];
		const errorItems = [];

		const uploadAssetIfNeeded = async (filepath, contentType, encoding) => {
			try {
				let absoluteFilepath = path.join(process.cwd(), "public", filepath);
				let s3path = s3Path(filepath);
				
				const existingAsset = await cdnS3Bucket.get(s3path);

				if (existingAsset) {
					existingItems.push(filepath);

					//debugLog(`Asset ${filepath} already in S3, skipping upload.`);

				} else {
					let fileData = fs.readFileSync(absoluteFilepath, {encoding: encoding, flag:'r'});
					let fileBuffer = Buffer.from(fileData, encoding);

					let options = {
						"ContentType": contentType,
						"CacheControl": "max-age=315360000"
					};

					await cdnS3Bucket.put(fileBuffer, s3path, options);

					uploadedItems.push(filepath);

					//debugLog(`Uploaded ${filepath} to S3.`);
				}
			} catch (e) {
				errorItems.push(filepath);

				debugErrorLog(`Error uploading asset to S3: ${JSON.stringify(filepath)}`, e);
			}
		};

		const promises = [];
		for (let i = 0; i < cdnItems.length; i++) {
			let item = cdnItems[i];

			let filepath = item[0];
			let contentType = item[1];
			let encoding = item[2];

			promises.push(uploadAssetIfNeeded(filepath, contentType, encoding));
		}

		await utils.awaitPromises(promises);

		debugLog(`Done uploading assets to S3:\n\tAlready present: ${existingItems.length}\n\tNewly uploaded: ${uploadedItems.length}\n\tError items: ${errorItems.length}`);
	}
}

function connectToRpcServer() {
	// reload credentials, the main "config.credentials.rpc" can be stale
	// since the username/password can be sourced from the auth cookie
	// which changes each startup of bitcoind
	let credentialsForRpcConnect = config.credentials.loadFreshRpcCredentials();

	debugLog(`RPC Credentials: ${JSON.stringify(utils.obfuscateProperties(credentialsForRpcConnect, ["password"]), null, 4)}`);

	let rpcCred = credentialsForRpcConnect;
	debugLog(`Connecting to RPC node at [${rpcCred.host}]:${rpcCred.port}`);

	let usernamePassword = `${rpcCred.username}:${rpcCred.password}`;
	let authorizationHeader = `Basic ${btoa(usernamePassword)}`; // basic auth header format (base64 of "username:password")

	let rpcClientProperties = {
		host: rpcCred.host,
		port: rpcCred.port,
		username: rpcCred.username,
		password: rpcCred.password,
		timeout: rpcCred.timeout
	};

	debugLog(`RPC Connection properties: ${JSON.stringify(utils.obfuscateProperties(rpcClientProperties, ["password"]), null, 4)}`);

	// add after logging to avoid logging base64'd credentials
	rpcClientProperties.headers = {
		"Authorization": authorizationHeader
	};

	// main RPC client
	global.rpcClient = jayson.Client.http(rpcClientProperties);

	let rpcClientNoTimeoutProperties = {
		host: rpcCred.host,
		port: rpcCred.port,
		username: rpcCred.username,
		password: rpcCred.password,
		timeout: 0,
		headers: {
			"Authorization": authorizationHeader
		}
	};

	// no timeout RPC client, for long-running commands
	global.rpcClientNoTimeout = jayson.Client.http(rpcClientNoTimeoutProperties);
}

expressApp.continueStartup = function() {
	connectToRpcServer();

	// if using cookie auth, watch for changes to the file and reconnect
	if (config.credentials.rpc.authType == "cookie") {
		debugLog(`RPC authentication is cookie based; watching for changes to the auth cookie file...`);

		fs.watchFile(config.credentials.rpc.authCookieFilepath, (curr, prev) => {
			debugLog(`RPC auth cookie change detected; attempting reconnect...`);

			connectToRpcServer();
		});
	}


	// default values - after we connect via RPC, we update these
	global.txindexAvailable = false;
	global.prunedBlockchain = false;
	global.pruneHeight = -1;


	// keep trying to verify rpc connection until we succeed
	// note: see verifyRpcConnection() for associated clearInterval() after success
	verifyRpcConnection();
	global.verifyRpcConnectionIntervalId = setInterval(verifyRpcConnection, 30000);


	if (config.addressApi) {
		let supportedAddressApis = addressApi.getSupportedAddressApis();
		if (!supportedAddressApis.includes(config.addressApi)) {
			utils.logError("32907ghsd0ge", `Unrecognized value for BTCEXP_ADDRESS_API: '${config.addressApi}'. Valid options are: ${supportedAddressApis}`);
		}

		if (config.addressApi == "electrum" || config.addressApi == "electrumx") {
			if (config.electrumServers && config.electrumServers.length > 0) {
				electrumAddressApi.connectToServers().then(function() {
					global.electrumAddressApi = electrumAddressApi;
					
				}).catch(function(err) {
					utils.logError("31207ugf4e0fed", err, {electrumServers:config.electrumServers});
				});
			} else {
				utils.logError("327hs0gde", "You must set the 'BTCEXP_ELECTRUM_SERVERS' environment variable when BTCEXP_ADDRESS_API=electrum.");
			}
		}
	}


	loadMiningPoolConfigs();


	if (config.demoSite) {
		getSourcecodeProjectMetadata();
		setInterval(getSourcecodeProjectMetadata, 3600000);
	}


	utils.logMemoryUsage();
	setInterval(utils.logMemoryUsage, 5000);
};

expressApp.use(function(req, res, next) {
	utils.trackAppEvent("request");

	req.startTime = Date.now();

	next();
});

expressApp.use(function(req, res, next) {
	// make session available in templates
	res.locals.session = req.session;

	if (config.credentials.rpc && req.session.host == null) {
		req.session.host = config.credentials.rpc.host;
		req.session.port = config.credentials.rpc.port;
		req.session.username = config.credentials.rpc.username;
	}

	var userAgent = req.headers['user-agent'];
	var crawler = utils.getCrawlerFromUserAgentString(userAgent);
	if (crawler) {
		res.locals.crawlerBot = true;
	}

	// make a bunch of globals available to templates
	res.locals.config = global.config;
	res.locals.coinConfig = global.coinConfig;
	res.locals.activeBlockchain = global.activeBlockchain;
	res.locals.exchangeRates = global.exchangeRates;
	res.locals.utxoSetSummary = global.utxoSetSummary;
	res.locals.utxoSetSummaryPending = global.utxoSetSummaryPending;
	res.locals.namesSummary = global.namesSummary;
	res.locals.namesSummaryPending = global.namesSummaryPending;
	res.locals.recentFirstUpdates = global.recentFirstUpdates;
	res.locals.recentFirstUpdatesPending = global.recentFirstUpdatesPending;
	res.locals.nameTxStats = global.nameTxStats;
	res.locals.networkVolume = global.networkVolume;
	
	res.locals.host = req.session.host;
	res.locals.port = req.session.port;

	res.locals.genesisBlockHash = coreApi.getGenesisBlockHash();
	res.locals.genesisCoinbaseTransactionId = coreApi.getGenesisCoinbaseTransactionId();

	res.locals.pageErrors = [];


	if (!req.session.userSettings) {
		req.session.userSettings = Object.create(null);

		const cookieSettings = JSON.parse(req.cookies["user-settings"] || "{}");
		for (const [key, value] of Object.entries(cookieSettings)) {
			req.session.userSettings[key] = value;
		}
	}

	const userSettings = req.session.userSettings;
	res.locals.userSettings = userSettings;

	// set defaults
	userSettings.displayCurrency = (userSettings.displayCurrency || config.displayDefaults.displayCurrency);
	userSettings.localCurrency = (userSettings.localCurrency || config.displayDefaults.localCurrency);
	userSettings.uiTimezone = (userSettings.uiTimezone || config.displayDefaults.timezone);
	userSettings.uiTheme = (userSettings.uiTheme || config.displayDefaults.theme);


	// make available in templates
	res.locals.displayCurrency = userSettings.displayCurrency;
	res.locals.localCurrency = userSettings.localCurrency;
	res.locals.uiTimezone = userSettings.uiTimezone;
	res.locals.uiTheme = userSettings.uiTheme;
	res.locals.userTzOffset = userSettings.userTzOffset || "unset";
	res.locals.browserTzOffset = userSettings.browserTzOffset || "0";


	if (!["/", "/connect"].includes(req.originalUrl)) {
		if (utils.redirectToConnectPageIfNeeded(req, res)) {
			return;
		}
	}

	if (req.session.userMessage) {
		res.locals.userMessage = req.session.userMessage;
		
		if (req.session.userMessageType) {
			res.locals.userMessageType = req.session.userMessageType;
			
		} else {
			res.locals.userMessageType = "warning";
		}

		req.session.userMessage = null;
		req.session.userMessageType = null;
	}

	if (req.session.query) {
		res.locals.query = req.session.query;

		req.session.query = null;
	}


	if (!global.rpcConnected) {
		res.status(500);
		res.render('error', {
			errorType: "noRpcConnection"
		});

		return;
	}
	

	// make some var available to all request
	// ex: req.cheeseStr = "cheese";

	next();
});

const csrfProtection = csrfApi();
expressApp.use(csrfProtection, (req, res, next) => {
	res.locals.csrfToken = req.csrfToken();

	next();
});

expressApp.use(config.baseUrl, cleanupRouter);
expressApp.use(config.baseUrl, baseActionsRouter);
expressApp.use(config.baseUrl + 'internal-api/', internalApiActionsRouter);
expressApp.use(config.baseUrl + 'api/', apiActionsRouter);
expressApp.use(config.baseUrl + 'snippet/', snippetActionsRouter);
expressApp.use(config.baseUrl + 'admin/', adminActionsRouter);

if (expressApp.get("env") === "local") {
	expressApp.use(config.baseUrl + 'test/', testActionsRouter);
}


expressApp.use(function(req, res, next) {
	var time = Date.now() - req.startTime;
	var userAgent = req.headers['user-agent'];
	var crawler = utils.getCrawlerFromUserAgentString(userAgent);
	let ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();

	if (crawler) {
		debugAccessLog(`Finished action '${req.path}' (${res.statusCode}) in ${time}ms for crawler '${crawler}' / '${userAgent}', ip=${ip}`);

	} else {
		debugAccessLog(`Finished action '${req.path}' (${res.statusCode}) in ${time}ms for UA '${userAgent}', ip=${ip}`);
	}

	if (!res.headersSent) {
		next();
	}
});

/// catch 404 and forwarding to error handler
expressApp.use(function(req, res, next) {
	utils.trackAppEvent("error404");

	var err = new Error(`Not Found: ${req ? req.url : 'unknown url'}`);
	err.status = 404;

	next(err);
});

/// error handlers

const sharedErrorHandler = (req, err) => {
	if (err && err.message && err.message.includes("Not Found")) {
		const path = err.toString().substring(err.toString().lastIndexOf(" ") + 1);
		const userAgent = req.headers['user-agent'];
		const crawler = utils.getCrawlerFromUserAgentString(userAgent);
		const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress; 

		const attributes = { path:path };

		if (crawler) {
			attributes.crawler = crawler;

			utils.trackAppEvent("crawlRequest", 1, {"crawler": crawler});
		}

		debugErrorLog(`404 NotFound: path=${path}, ip=${ip}, userAgent=${userAgent} (crawler=${(crawler != null)}${crawler ? crawler : ""})`);

		utils.logError(`NotFound`, err, attributes, false);

	} else {
		utils.logError("ExpressUncaughtError", err);
	}
};

// development error handler
// will print stacktrace
if (expressApp.get("env") === "development" || expressApp.get("env") === "local") {
	expressApp.use(function(err, req, res, next) {
		if (err) {
			sharedErrorHandler(req, err);
		}

		res.status(err.status || 500);
		res.render('error', {
			message: err.message,
			error: err
		});
	});
}

// production error handler
// no stacktraces leaked to user
expressApp.use(function(err, req, res, next) {
	if (err) {
		sharedErrorHandler(req, err);
	}

	res.status(err.status || 500);
	res.render('error', {
		message: err.message,
		error: {}
	});
});

expressApp.locals.moment = moment;
expressApp.locals.Decimal = Decimal;
expressApp.locals.utils = utils;
expressApp.locals.markdown = src => markdown.render(src);

expressApp.locals.assetUrl = (path) => {
	// trim off leading "./"
	let normalizedPath = path.substring(2);

	//console.log("assetUrl: " + path + " -> " + normalizedPath);

	if (config.cdn.active && cdnFilepathMap[normalizedPath]) {
		return `${config.cdn.baseUrl}/${global.cacheId}/${normalizedPath}`;

	} else {
		return `${path}?v=${global.cacheId}`;
	}
};

// debug setting to skip js/css integrity checks
const skipIntegrityChecks = false;
const resourceIntegrityHashes = require("./app/resourceIntegrityHashes.js");

expressApp.locals.assetIntegrity = (filename) => {
	if (!skipIntegrityChecks && resourceIntegrityHashes[filename]) {
		return resourceIntegrityHashes[filename];

	} else {
		return "";
	}
};


module.exports = expressApp;
