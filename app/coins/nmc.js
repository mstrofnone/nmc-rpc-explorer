"use strict";

// Namecoin coin definition for nmc-rpc-explorer.
//
// Tracks Bitcoin-style economics (50-coin initial reward, 210k-block
// halving schedule). The btc coin module supplies a lot of one-off Bitcoin
// flavour data (BIP fun, holidays, exchange rates) — for Namecoin we keep
// those empty/null and rely on coreApi callers tolerating their absence.
//
// IMPORTANT: do NOT require ./btcFun, ./btcHolidays or ./btcQuotes here.
// They are Bitcoin-specific and would leak into a Namecoin-mode UI.

const Decimal = require("decimal.js");
const Decimal8 = Decimal.clone({ precision: 8, rounding: 8 });

const blockRewardEras = [new Decimal8(50)];
for (let i = 1; i < 34; i++) {
	const previous = blockRewardEras[i - 1];
	blockRewardEras.push(new Decimal8(previous).dividedBy(2));
}

const currencyUnits = [
	{
		type: "native",
		name: "NMC",
		multiplier: 1,
		default: true,
		values: ["", "nmc", "NMC"],
		decimalPlaces: 8,
	},
	{
		type: "native",
		name: "mNMC",
		multiplier: 1000,
		values: ["mnmc"],
		decimalPlaces: 5,
	},
	{
		type: "native",
		name: "swartz",
		multiplier: 1000000,
		values: ["swartz"],
		decimalPlaces: 2,
	},
	{
		type: "native",
		name: "sat",
		multiplier: 100000000,
		values: ["sat", "satoshi"],
		decimalPlaces: 0,
	},
];

module.exports = {
	name: "Namecoin",
	ticker: "NMC",
	logoUrlsByNetwork: {
		"main": "./img/network-mainnet/logo.svg",
		"test": "./img/network-testnet/logo.svg",
		"regtest": "./img/network-regtest/logo.svg",
	},
	coinIconUrlsByNetwork: {
		"main": "./img/network-mainnet/coin-icon.svg",
		"test": "./img/network-testnet/coin-icon.svg",
		"regtest": "./img/network-regtest/coin-icon.svg",
	},
	coinColorsByNetwork: {
		"main": "#1a78d8",
		"test": "#1daf00",
		"regtest": "#777",
	},
	siteTitlesByNetwork: {
		"main": "Namecoin Explorer",
		"test": "Namecoin Testnet Explorer",
		"regtest": "Namecoin Regtest Explorer",
	},
	demoSiteUrlsByNetwork: {},
	knownTransactionsByNetwork: {
		// Namecoin block 173 (the first name_firstupdate of d/nf, by Vincent Durham)
		main: "a0fa5c1ce58c2da82bbc4ee3ef9bbb7c0e35c9c3736edd0fdf3c95ad4d3d56c7",
	},
	miningPoolsConfigUrls: [],
	maxBlockWeight: 4000000,
	maxBlockSize: 1000000,
	minTxBytes: 100,
	minTxWeight: 100 * 4,
	difficultyAdjustmentBlockCount: 2016,
	maxSupplyByNetwork: {
		"main": new Decimal(20999999.97690000),
		"test": new Decimal(21000000),
		"regtest": new Decimal(21000000),
	},
	targetBlockTimeSeconds: 600,
	targetBlockTimeMinutes: 10,
	currencyUnits: currencyUnits,
	currencyUnitsByName: {
		"NMC": currencyUnits[0],
		"mNMC": currencyUnits[1],
		"swartz": currencyUnits[2],
		"sat": currencyUnits[3],
	},
	baseCurrencyUnit: currencyUnits[3],
	defaultCurrencyUnit: currencyUnits[0],
	feeSatoshiPerByteBucketMaxima: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 50, 75, 100, 150],

	halvingBlockIntervalsByNetwork: {
		"main": 210000,
		"test": 210000,
		"regtest": 150,
	},

	terminalHalvingCountByNetwork: {
		"main": 32,
		"test": 32,
		"regtest": 32,
	},

	coinSupplyCheckpointsByNetwork: {
		"main": [822000, new Decimal(20857000)],
		"test": [0, new Decimal(0)],
		"regtest": [0, new Decimal(0)],
	},

	utxoSetCheckpointsByNetwork: {},

	genesisBlockHashesByNetwork: {
		"main": "000000000062b72c5e2ceb45fbc8587e807c155b0da735e6483dfba2f0a9c770",
	},
	genesisCoinbaseTransactionIdsByNetwork: {
		"main": "41c62dbd9068c89a449525e3cd5ac61b20ece28c3c38b3f35b2161f0e6d3cb0d",
	},
	genesisCoinbaseTransactionsByNetwork: {
		"main": {
			"hex": "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff3804ffff001d020f274e2e2e2e204e616d65636f696e2061206d65726765642d6d696e696e672063757272656e637920706565722d746f2d706565720effffffff0100f2052a01000000434104b620369050cd899ffbbc4e8ee651cc87a44f0f3a4d4cb1c3a3afe0d2cb6e2eea2bcafa50d2b9b1c0bff36f7c2c7d2e1f8f2c5cf8e9d3a1ad8f7e1d2bc8d6e0a4ac00000000",
			"txid": "41c62dbd9068c89a449525e3cd5ac61b20ece28c3c38b3f35b2161f0e6d3cb0d",
			"size": 0,
			"vsize": 0,
			"version": 1,
			"locktime": 0,
			"vin": [
				{
					"coinbase": "04ffff001d020f274e2e2e2e204e616d65636f696e2061206d65726765642d6d696e696e672063757272656e637920706565722d746f2d70656572",
					"sequence": 4294967295,
				},
			],
			"vout": [
				{
					"value": 50.0,
					"n": 0,
					"scriptPubKey": {
						"asm": "",
						"hex": "",
						"type": "pubkey",
					},
				},
			],
			"blockhash": "000000000062b72c5e2ceb45fbc8587e807c155b0da735e6483dfba2f0a9c770",
			"time": 1303000001,
			"blocktime": 1303000001,
		},
	},
	genesisBlockStatsByNetwork: {
		"main": {
			"avgfee": 0,
			"avgfeerate": 0,
			"avgtxsize": 0,
			"blockhash": "000000000062b72c5e2ceb45fbc8587e807c155b0da735e6483dfba2f0a9c770",
			"feerate_percentiles": [0, 0, 0, 0, 0],
			"height": 0,
			"ins": 0,
			"maxfee": 0,
			"maxfeerate": 0,
			"maxtxsize": 0,
			"medianfee": 0,
			"mediantime": 1303000001,
			"mediantxsize": 0,
			"minfee": 0,
			"minfeerate": 0,
			"mintxsize": 0,
			"outs": 1,
			"subsidy": 5000000000,
			"swtotal_size": 0,
			"swtotal_weight": 0,
			"swtxs": 0,
			"time": 1303000001,
			"total_out": 0,
			"total_size": 0,
			"total_weight": 0,
			"totalfee": 0,
			"txs": 1,
			"utxo_increase": 1,
			"utxo_size_inc": 117,
		},
	},
	testData: { txDisplayTestList: {} },
	genesisCoinbaseOutputAddressScripthash: "",
	historicalData: [],
	exchangeRateData: null,
	goldExchangeRateData: null,
	blockRewardFunction: function (blockHeight, chain) {
		const halvingBlockInterval = chain == "regtest" ? 150 : 210000;
		const index = Math.floor(blockHeight / halvingBlockInterval);
		return blockRewardEras[index] || new Decimal8(0);
	},
};
