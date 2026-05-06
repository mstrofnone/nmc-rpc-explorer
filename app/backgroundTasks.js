"use strict";

// Lightweight registry for the background `refresh*` tasks defined in app.js.
//
// Goal: one place to ask "is this refresher healthy?" — useful for ops
// (the /metrics endpoint) and for /admin diagnostics. Each registered
// task tracks its enable flag, run count, last success/failure timestamp,
// last duration, last error message, and next scheduled run.
//
// Usage from app.js:
//
//   const bg = require("./app/backgroundTasks");
//   const task = bg.register({
//     id: "namesSummary",
//     intervalMs: 30 * 60 * 1000,
//     disableEnv: "BTCEXP_DISABLE_NAMES_SUMMARY",
//     fn: refreshNamesSummary,
//   });
//   task.startSoon();   // kicks off the first run + sets the interval
//
// `task.runOnce()` is exposed for /admin "force refresh" buttons.
//
// All state lives in module-local state; we never persist across restarts.

const tasks = new Map();

function _now() { return Date.now(); }

function register({ id, intervalMs, disableEnv = null, fn, name = null, description = null }) {
	if (!id || typeof id !== "string") throw new Error("BackgroundTask: id required");
	if (typeof fn !== "function") throw new Error("BackgroundTask: fn required");
	if (tasks.has(id)) throw new Error(`BackgroundTask: id already registered: ${id}`);

	const task = {
		id,
		name: name || id,
		description,
		intervalMs: intervalMs > 0 ? intervalMs : null,
		disableEnv,
		fn,
		// runtime state
		enabled: !(disableEnv && process.env[disableEnv] === "true"),
		runs: 0,
		successes: 0,
		failures: 0,
		lastStartedAt: null,
		lastFinishedAt: null,
		lastDurationMs: null,
		lastError: null,
		nextRunAt: null,
		_inFlight: false,
		_timer: null,
		// methods
		runOnce: async function () {
			if (!this.enabled) return { skipped: "disabled" };
			if (this._inFlight) return { skipped: "in-flight" };
			this._inFlight = true;
			this.runs++;
			this.lastStartedAt = _now();
			const t0 = this.lastStartedAt;
			try {
				const out = await this.fn();
				this.lastFinishedAt = _now();
				this.lastDurationMs = this.lastFinishedAt - t0;
				this.lastError = null;
				this.successes++;
				return { ok: true, value: out };
			} catch (e) {
				this.lastFinishedAt = _now();
				this.lastDurationMs = this.lastFinishedAt - t0;
				this.lastError = (e && e.message) ? e.message : String(e);
				this.failures++;
				return { ok: false, error: this.lastError };
			} finally {
				this._inFlight = false;
				if (this.intervalMs) this.nextRunAt = _now() + this.intervalMs;
			}
		},
		startSoon: function () {
			if (!this.enabled) return;
			// kick off the first run on next tick so registration order
			// in app.js doesn't matter; then schedule the interval.
			setImmediate(() => { this.runOnce(); });
			if (this.intervalMs) {
				this._timer = setInterval(() => { this.runOnce(); }, this.intervalMs);
				this.nextRunAt = _now() + this.intervalMs;
			}
		},
		stop: function () {
			if (this._timer) { clearInterval(this._timer); this._timer = null; }
		},
	};
	tasks.set(id, task);
	return task;
}

function get(id) { return tasks.get(id) || null; }

function list() {
	const out = [];
	for (const t of tasks.values()) {
		out.push({
			id: t.id, name: t.name, description: t.description,
			enabled: t.enabled, intervalMs: t.intervalMs, disableEnv: t.disableEnv,
			runs: t.runs, successes: t.successes, failures: t.failures,
			lastStartedAt: t.lastStartedAt, lastFinishedAt: t.lastFinishedAt,
			lastDurationMs: t.lastDurationMs, lastError: t.lastError,
			nextRunAt: t.nextRunAt, inFlight: t._inFlight,
		});
	}
	return out;
}

module.exports = { register, get, list };
