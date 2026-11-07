"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const vm = require("vm");

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

function ok(value, message) {
	assert.ok(value, message);
	assertionCount++;
}

const source = fs.readFileSync(__dirname + "/../views/index.pug", "utf8");
const scriptMarker = "\n\tscript.\n";
const scriptStart = source.indexOf(scriptMarker);
assert.notEqual(scriptStart, -1, "homepage inline script not found");
const inlineScript = source.slice(scriptStart + scriptMarker.length)
	.split(String.fromCharCode(10))
	.map(line => line.endsWith(String.fromCharCode(13)) ? line.slice(0, -1) : line)
	.map(line => line.startsWith("		") ? line.slice(2) : line)
	.join(String.fromCharCode(10));

const document = {getElementById: () => null};
const elements = new Map();
const readyCallbacks = [];
const getRequests = [];
const tipRequests = [];
const timers = new Map();
let nextTimerId = 1;
let audioPlayCount = 0;
let handledAudioRejections = 0;
let synchronousAudioThrows = 0;

const audio = {
	play: () => {
		audioPlayCount++;
		return {catch: handler => {
			handledAudioRejections++;
			handler();
		}};
	}
};

function element(selector) {
	if (!elements.has(selector)) {
		const el = {
			length: selector == "#index-halving-countdown-wrapper" ? 0 : 1,
			attrs: {},
			classes: new Set(selector == "#index-new-block-alert" ? ["d-none"] : []),
			textValue: "",
			attr(name, value) {
				this.attrs[name] = value;
				return this;
			},
			text(value) {
				this.textValue = value;
				return this;
			},
			html() {
				return this;
			},
			addClass(name) {
				name.split(/\s+/).filter(Boolean).forEach(value => this.classes.add(value));
				return this;
			},
			removeClass(name) {
				name.split(/\s+/).filter(Boolean).forEach(value => this.classes.delete(value));
				return this;
			}
		};
		elements.set(selector, el);
	}
	return elements.get(selector);
}

function $(selector) {
	if (selector === document) {
		return {ready: callback => readyCallbacks.push(callback)};
	}
	return element(selector);
}

$.get = (url, success) => {
	getRequests.push({url, success});
};

$.getJSON = (url, success) => {
	equal(url, "./api/blocks/tip");
	const request = {
		success,
		alwaysHandlers: [],
		xhr: null
	};
	request.xhr = {
		always: callback => {
			request.alwaysHandlers.push(callback);
			return request.xhr;
		}
	};
	tipRequests.push(request);
	return request.xhr;
};

function setTimeoutFake(callback, delay) {
	const id = nextTimerId++;
	timers.set(id, {callback, delay});
	return id;
}

function clearTimeoutFake(id) {
	timers.delete(id);
}

const context = {
	Audio: function() { return audio; },
	$,
	document,
	setTimeout: setTimeoutFake,
	clearTimeout: clearTimeoutFake,
	enableTooltipsAndPopovers: () => {},
	console
};
vm.createContext(context);
new vm.Script(inlineScript, {filename: "views/index.pug:inline-script"}).runInContext(context);

function respond(requestIndex, data) {
	const request = tipRequests[requestIndex];
	assert.ok(request, "missing tip request " + requestIndex);
	if (data !== undefined) request.success(data);
	for (const handler of request.alwaysHandlers) handler();
}

function timerCount(delay) {
	return Array.from(timers.values()).filter(timer => timer.delay == delay).length;
}

function runTimer(delay) {
	const entry = Array.from(timers.entries()).find(([, timer]) => timer.delay == delay);
	assert.ok(entry, "no active timer with delay " + delay);
	const [id, timer] = entry;
	timers.delete(id);
	timer.callback();
}

test("exposes an accessible alert and dedicated Latest Blocks region", () => {
	ok(source.includes('#index-new-block-alert.alert.alert-success.d-none(role="status", aria-live="polite", aria-atomic="true")'));
	ok(source.includes('#index-latest-blocks.rounded'));
	ok(source.includes('a#index-new-block-link.alert-link(href="#")'));
});

test("starts one polling chain without a halving countdown or initial cue", () => {
	equal(readyCallbacks.length, 1);
	readyCallbacks[0]();
	equal(tipRequests.length, 1);
	equal(context.tipPollInFlight, true);
	readyCallbacks[0]();
	equal(tipRequests.length, 1);
	respond(0, {height: 100, hash: "aaa"});
	equal(context.tipPollInFlight, false);
	equal(context.tipInfo.height, 100);
	equal(audioPlayCount, 0);
	ok(element("#index-new-block-alert").classes.has("d-none"));
	equal(timerCount(3000), 1);

	readyCallbacks[0]();
	equal(tipRequests.length, 1);
	equal(timerCount(3000), 1);
	equal(getRequests.filter(request => request.url == "./snippet/index-halving-countdown").length, 0);
});

test("ignores an unchanged tip, then shows a linked cue for a higher block", () => {
	runTimer(3000);
	equal(tipRequests.length, 2);
	respond(1, {height: 100, hash: "aaa"});
	ok(element("#index-new-block-alert").classes.has("d-none"));
	equal(audioPlayCount, 0);
	equal(timerCount(3000), 1);

	runTimer(3000);
	equal(tipRequests.length, 3);
	respond(2, {height: 101, hash: "bbb"});
	ok(!element("#index-new-block-alert").classes.has("d-none"));
	equal(element("#index-new-block-link").attrs.href, "./block/bbb");
	equal(element("#index-new-block-link").textValue, "#101");
	ok(element("#index-latest-blocks").classes.has("border") && element("#index-latest-blocks").classes.has("border-success"));
	equal(audioPlayCount, 1);
	equal(handledAudioRejections, 1);
	equal(timerCount(10000), 1);
	equal(timerCount(3000), 1);
});

test("treats a same-height hash change as a new tip and resets highlighting", () => {
	runTimer(3000);
	equal(tipRequests.length, 4);
	respond(3, {height: 101, hash: "ccc"});
	equal(context.tipInfo.hash, "ccc");
	equal(element("#index-new-block-link").attrs.href, "./block/ccc");
	equal(element("#index-new-block-link").textValue, "#101");
	equal(audioPlayCount, 2);
	equal(handledAudioRejections, 2);
	equal(timerCount(10000), 1);
	equal(timerCount(3000), 1);
});

test("keeps the visual cue working through synchronous audio failure", () => {
	audio.play = () => {
		synchronousAudioThrows++;
		throw new Error("autoplay blocked");
	};
	runTimer(3000);
	equal(tipRequests.length, 5);
	respond(4, {height: 102, hash: "ddd"});
	equal(synchronousAudioThrows, 1);
	equal(element("#index-new-block-link").attrs.href, "./block/ddd");
	equal(element("#index-new-block-link").textValue, "#102");
	ok(!element("#index-new-block-alert").classes.has("d-none"));
	ok(element("#index-latest-blocks").classes.has("border") && element("#index-latest-blocks").classes.has("border-success"));
	equal(timerCount(3000), 1);

	runTimer(10000);
	ok(!element("#index-latest-blocks").classes.has("border-success"));
	ok(!element("#index-new-block-alert").classes.has("d-none"));
});

console.log("homepage live tip: " + testCount + " tests, " + assertionCount + " assertions passed");
