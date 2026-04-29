"use strict";

const btc = require("./coins/btc.js");
const nmc = require("./coins/nmc.js");

module.exports = {
	"BTC": btc,
	"NMC": nmc,

	"coins": ["BTC", "NMC"],
};
