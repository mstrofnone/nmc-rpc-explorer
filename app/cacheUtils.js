"use strict";

const debug = require("debug");
const debugLog = debug("btcexp:cache");

const utils = require("./utils.js");


const { LRUCache } = require("lru-cache");


const watchKeysRegex = /regexToMatchCacheKeysForDebugLogging/;

function createMemoryLruCache(cacheName, cacheObj, onCacheEvent) {
	return {
		get: (key) => {
			return new Promise((resolve, reject) => {
				onCacheEvent("memory", "try", key);

				var val = cacheObj.get(key);

				if (val != null) {
					onCacheEvent("memory", "hit", key);

					if (key.match(watchKeysRegex)) {
						debugLog(`cache.${cacheName}[${key}]: HIT  (${utils.addThousandsSeparators(JSON.stringify(val).length)} B)`);
					}
				} else {
					onCacheEvent("memory", "miss", key);

					if (key.match(watchKeysRegex)) {
						debugLog(`cache.${cacheName}[${key}]: MISS`);
					}
				}

				resolve(val);
			});
		},
		set: (key, obj, maxAge) => {
			cacheObj.set(key, obj, {ttl: maxAge});

			if (key.match(watchKeysRegex)) {
				debugLog(`cache.${cacheName}[${key}]: SET  (${utils.addThousandsSeparators(JSON.stringify(obj).length)} B), T=${maxAge}`);
			}

			onCacheEvent("memory", "set", key);
		},
		del: (key) => {
			cacheObj.delete(key);

			onCacheEvent("memory", "del", key);

			if (key.match(watchKeysRegex)) {
				debugLog(`cache.${cacheName}[${key}]: DEL`);
			}
		}
	}
}

function tryCache(cacheKey, cacheObjs, index, resolve, reject) {
	if (index == cacheObjs.length) {
		resolve(null);

		return;
	}

	cacheObjs[index].get(cacheKey).then((result) => {
		if (result != null) {
			resolve(result);

		} else {
			tryCache(cacheKey, cacheObjs, index + 1, resolve, reject);
		}
	});
}

function createTieredCache(cacheObjs) {
	return {
		get:(key) => {
			return new Promise((resolve, reject) => {
				tryCache(key, cacheObjs, 0, resolve, reject);
			});
		},
		set:(key, obj, maxAge) => {
			for (var i = 0; i < cacheObjs.length; i++) {
				cacheObjs[i].set(key, obj, maxAge);
			}
		}
	}
}

function lruCache(size) {
	// Note: per-call `ttl` (passed to .set(key, val, {ttl})) WORKS in
	// lru-cache v10 even without a default `ttl` here, BUT eviction is
	// lazy — stale entries are only purged on read.  Without
	// `ttlAutopurge: true`, write-once-never-read keys (the common case
	// for tx-fetch caches behind a one-shot page render) sit in memory
	// until LRU `max` pushes them out, inflating the working-set size
	// reported by `cache.size` / `cache.itemCount` and the per-cache
	// stat-tracker gauges.  `ttlAutopurge` registers an internal timer
	// per entry that frees expired ones eagerly.  This is the upstream
	// fix referenced as "the cache eviction bug" in our deploy notes —
	// once enabled, BTCEXP_NO_INMEMORY_RPC_CACHE=true is no longer
	// needed in production.  We also keep `allowStale: false` (the
	// default) so a per-call ttl miss never returns the old value.
	return new LRUCache({
		max: size,
		ttlAutopurge: true,
		allowStale: false,
	});
}

module.exports = {
	lruCache: lruCache,
	createMemoryLruCache: createMemoryLruCache,
	createTieredCache: createTieredCache
}