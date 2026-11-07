"use strict";

const assert = require("assert").strict;
const utils = require("../app/utils.js");

let assertionCount = 0;
let testCount = 0;

function test(name, callback) {
	callback();
	testCount++;
	console.log("ok - " + name);
}

function equal(actual, expected) {
	assert.equal(actual, expected);
	assertionCount++;
}

function close(actual, expected, tolerance = 1e-12) {
	assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
		"expected " + actual + " to be within " + tolerance + " of " + expected);
	assertionCount++;
}

function referencePoissonAtLeast(lambda, k) {
	if (k == 0) return 1;
	let term = Math.exp(-lambda);
	let sum = term;
	for (let i = 1; i < k; i++) {
		term *= lambda / i;
		sum += term;
	}
	return 1 - sum;
}

test("validates inputs and boundary probabilities", () => {
	equal(utils.poissonAtLeast(5, 0), 1);
	equal(utils.poissonAtLeast(0, 4), 0);
	equal(utils.poissonAtLeast(-1, 2), null);
	equal(utils.poissonAtLeast(NaN, 2), null);
	equal(utils.poissonAtLeast(Infinity, 2), null);
	equal(utils.poissonAtLeast(1, -1), null);
	equal(utils.poissonAtLeast(1, 1.5), null);
});

test("matches the defining lower-tail formula", () => {
	for (const [lambda, k] of [[1, 1], [1, 3], [2, 3], [5 / 6, 2], [1.5, 3], [10, 4], [10, 20]]) {
		close(utils.poissonAtLeast(lambda, k), referencePoissonAtLeast(lambda, k));
	}
});

test("preserves a small upper-tail probability without cancellation", () => {
	const probability = utils.poissonAtLeast(1, 100);
	assert.ok(probability > 0 && probability < 1e-150, "unexpected upper tail: " + probability);
	assertionCount++;
});

test("accumulates descending lists from the oldest visible block", () => {
	const blocks = [
		{height: 103, time: 1900},
		{height: 102, time: 1500},
		{height: 101, time: 1200},
		{height: 100, time: 1000}
	];
	const original = JSON.stringify(blocks);
	const values = utils.cumulativePoissonData(blocks, "desc");

	equal(values.length, 4);
	equal(values[3], null);
	equal(values[2].intervalCount, 1);
	equal(values[2].elapsedSeconds, 200);
	equal(values[1].intervalCount, 2);
	equal(values[1].elapsedSeconds, 500);
	equal(values[0].intervalCount, 3);
	equal(values[0].elapsedSeconds, 900);
	close(values[2].probability, referencePoissonAtLeast(200 / 600, 1));
	close(values[1].probability, referencePoissonAtLeast(500 / 600, 2));
	close(values[0].probability, referencePoissonAtLeast(900 / 600, 3));
	equal(JSON.stringify(blocks), original);
});

test("handles ascending lists with identical chronological results", () => {
	const descending = [
		{height: 103, time: 1900},
		{height: 102, time: 1500},
		{height: 101, time: 1200},
		{height: 100, time: 1000}
	];
	const ascending = descending.slice().reverse();
	const descValues = utils.cumulativePoissonData(descending, "desc");
	const ascValues = utils.cumulativePoissonData(ascending, "asc");

	equal(ascValues[0], null);
	for (let i = 0; i < descending.length; i++) {
		if (descValues[i] === null) {
			equal(ascValues[ascending.length - 1 - i], null);
		} else {
			close(ascValues[ascending.length - 1 - i].probability, descValues[i].probability);
		}
	}
});

test("counts zero and negative gaps as elapsed intervals but zero seconds", () => {
	const values = utils.cumulativePoissonData([
		{height: 0, time: 1000},
		{height: 1, time: 900},
		{height: 2, time: 900},
		{height: 3, time: 1500}
	], "asc");

	equal(values[0], null);
	equal(values[1].elapsedSeconds, 0);
	equal(values[1].intervalCount, 1);
	equal(values[1].probability, 0);
	equal(values[2].elapsedSeconds, 0);
	equal(values[2].intervalCount, 2);
	equal(values[2].probability, 0);
	equal(values[3].elapsedSeconds, 600);
	equal(values[3].intervalCount, 3);
	close(values[3].probability, referencePoissonAtLeast(1, 3));
});

test("does not invent values for a lone block or genesis baseline", () => {
	assert.deepEqual(utils.cumulativePoissonData([], "desc"), []);
	assertionCount++;
	assert.deepEqual(utils.cumulativePoissonData([{height: 50, time: 1000}], "desc"), [null]);
	assertionCount++;
	assert.deepEqual(utils.cumulativePoissonData([{height: 0, time: 1000}], "asc"), [null]);
	assertionCount++;
});

test("suppresses cumulative values after an invalid timestamp", () => {
	const values = utils.cumulativePoissonData([
		{height: 0, time: 1000},
		{height: 1, time: 1100},
		{height: 2},
		{height: 3, time: 1300}
	], "asc");

	equal(values[0], null);
	equal(values[1].elapsedSeconds, 100);
	equal(values[2], null);
	equal(values[3], null);
});

console.log("cumulative Poisson: " + testCount + " tests, " + assertionCount + " assertions passed");

// app/utils.js owns a long-lived cache interval. This focused synchronous test
// has completed all of its assertions, so do not keep the process open for it.
process.exit(0);
