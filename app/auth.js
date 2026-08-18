"use strict";

const crypto = require("crypto");
const basicAuth = require('basic-auth');

module.exports = pass => (req, res, next) => {
	var cred = basicAuth(req);

	// Constant-time comparison: a plain `===` on strings short-circuits on
	// the first differing byte and leaks the password length + prefix via
	// response timing. Pad both sides to the same length before comparing
	// so timingSafeEqual's length check doesn't itself become the oracle.
	if (cred && typeof cred.pass === "string") {
		const expected = Buffer.from(pass, "utf8");
		const supplied = Buffer.from(cred.pass, "utf8");

		if (expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)) {
			req.authenticated = true;
			return next();
		}
	}

	res.set('WWW-Authenticate', `Basic realm="Private Area"`)
		.sendStatus(401);
}
