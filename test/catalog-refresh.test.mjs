/**
 * The catalogue's Host-side clock and its single writer (ADR-015).
 *
 * `GET /snapshot` used to carry three side effects: persist the catalogue,
 * rebuild the provider registration, write the settings row. That made the
 * browser the Host's clock — no panel open meant no discovery, and two open
 * clients could drive the same control-plane write. The write half moved into
 * `catalog-refresh.ts` and the Host now ticks at its own declared cadence.
 *
 * What this suite pins, and why each one can only be pinned here:
 *
 *   - `run` is ONE writer: the signature check and the write it guards cannot
 *     interleave, even when two callers arrive together. Before the chain, both
 *     would read the same stale signature and both persist + republish.
 *   - a swallowed write failure must not advance the signature (PITFALLS §40).
 *     `routes.test.mjs` §S drives this through the route; that route now
 *     delegates here, so the invariant needs a pin at the module that owns it.
 *   - `refresh` must be free when there is nothing to do. The tick runs every
 *     `pollSeconds`; if the fresh-cache and no-key exits regress, the Host
 *     starts asking the credentials service (and possibly the gateway) on a
 *     timer nobody asked for.
 *   - `start` must not tick immediately, must `unref` its timer (an idle Host
 *     has to be able to exit), and must stop cleanly — a leaked interval keeps
 *     publishing into a Host that withdrew the plugin.
 *
 * Peer-free and network-free: `fetchCatalog` and the credentials read are
 * injected, and the timer is faked, so every branch is driven deterministically
 * with no sleeps and no peers to resolve.
 */
import { createCatalogEffects, CATALOG_CACHE_MS, CATALOG_RETRY_BASE_MS, CATALOG_RETRY_MAX_MS, retryDelayMs } from "../src/host/catalog-refresh.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

const API_BASE = "https://api.example.test/v1";
const CATALOG_URL = `${API_BASE}/models`;
/** The two models every fixture catalogue carries; ids are what the signature reads. */
const CATALOG_A = [{ id: "Agnes-Lite" }, { id: "Agnes-Vision" }];
const CATALOG_B = [{ id: "Agnes-Lite" }];

/** Let every queued microtask/timer-free continuation run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A settings row with only the fields this module reads. */
function makeSettings() {
  return { apiBase: API_BASE, consoleTimeoutMs: 15_000 };
}

/**
 * A stand-in for `createProviderPublisher` that mirrors the ONE behaviour the
 * catalogue writer depends on: `publish` adopts the entries it was handed.
 * Without that mirror, a fake would let "publish then read state.entries" pass
 * while the real publisher did something else.
 */
function makePublisher(options = {}) {
  const publishes = [];
  const state = {
    entries: options.entries ?? [],
    enabledIds: options.enabledIds ?? [],
    unavailableIds: [],
    signature: options.signature ?? "",
    quotaSignature: ""
  };
  return {
    state,
    publishes,
    async publish(entries, enabledIds, unavailableModelIds) {
      publishes.push({ entries, enabledIds, unavailableModelIds });
      state.entries = entries;
      state.enabledIds = enabledIds;
      state.unavailableIds = unavailableModelIds;
      return { ok: true };
    }
  };
}

/** The catalog store seam: `replace` reports whether the disk took the write. */
function makeCatalogStore(options = {}) {
  const persisted = [];
  return {
    persisted,
    async list() { return options.entries ?? []; },
    async listEnabledIds() {
      if (options.failEnabledIds === true) throw new Error("state dir unreadable");
      return options.enabledIds ?? [];
    },
    async replace(entries, enabledIds) {
      if (options.onReplace !== undefined) return options.onReplace(entries, enabledIds);
      persisted.push({ entries, enabledIds });
      return true;
    },
    async setEnabledIds() { return true; },
    async clear() {}
  };
}

/** The credentials seam: counts how often the key was asked for. */
function makeKeyStore(value) {
  const calls = [];
  return {
    calls,
    async resolve() {
      calls.push(value);
      return { value, source: value === "" ? null : "env" };
    }
  };
}

/**
 * Build one effects instance over fakes.
 * @param {object} [options]
 * @param {string} [options.apiKey] - what the credentials seam answers.
 * @param {number} [options.cachedAt] - when the cache entry was stored (`null` = no entry).
 * @param {object} [options.publisher]
 * @param {object} [options.catalogStore]
 * @param {object} [options.fetchResult] - what the injected fetch returns (or throws).
 */
function harness(options = {}) {
  const cache = new Map();
  const inflight = new Map();
  if (options.cachedAt !== undefined && options.cachedAt !== null) {
    cache.set(CATALOG_URL, { body: CATALOG_A, at: options.cachedAt });
  }
  const publisher = options.publisher ?? makePublisher();
  const catalogStore = options.catalogStore ?? makeCatalogStore();
  const apiKeyStore = makeKeyStore(options.apiKey ?? "sk-test");
  const fetchCalls = [];
  const logs = [];
  const effects = createCatalogEffects({
    settings: makeSettings(),
    cache,
    inflight,
    apiKeyStore,
    catalogStore,
    publisher,
    logger: { warn: (message) => logs.push(message) },
    fetchCatalog: async (...args) => {
      fetchCalls.push(args);
      if (options.fetchThrows === true) throw new Error("gateway down");
      return options.fetchResult === undefined ? CATALOG_A : options.fetchResult;
    }
  });
  return { effects, cache, inflight, publisher, catalogStore, apiKeyStore, fetchCalls, logs };
}

// === A. `run` — the one writer ============================================
{
  try {
    // A1: a changed catalogue is persisted AND republished.
    {
      const h = harness();
      const result = await h.effects.run(CATALOG_A, [], []);
      check("A1 a changed catalogue is persisted once and republished once",
        h.catalogStore.persisted.length === 1 && h.publisher.publishes.length === 1,
        `persisted=${h.catalogStore.persisted.length} published=${h.publisher.publishes.length}`);
      check("A1b run reports the catalogue it offered and that it changed",
        result.catalogChanged === true && result.offered === CATALOG_A,
        JSON.stringify({ changed: result.catalogChanged, offered: result.offered }));
    }

    // A2: the same catalogue again does NOT touch the disk or the registration.
    // This is the whole reason the tick is affordable: 30 s ticks against an
    // unchanged catalogue must be one string comparison.
    {
      const h = harness();
      await h.effects.run(CATALOG_A, [], []);
      const second = await h.effects.run(CATALOG_A, [], []);
      check("A2 an unchanged catalogue is not persisted or republished again",
        h.catalogStore.persisted.length === 1 && h.publisher.publishes.length === 1,
        `persisted=${h.catalogStore.persisted.length} published=${h.publisher.publishes.length}`);
      check("A2b the unchanged run says so", second.catalogChanged === false, String(second.catalogChanged));
    }

    // A3: a non-array catalogue is not a catalogue. It must not clear what is
    // already persisted (that would un-offer every model on one bad response).
    {
      const h = harness();
      await h.effects.run(CATALOG_A, [], []);
      const result = await h.effects.run(null, [], []);
      check("A3 a malformed catalogue leaves the persisted set untouched",
        h.catalogStore.persisted.length === 1 && h.publisher.publishes.length === 1,
        `persisted=${h.catalogStore.persisted.length} published=${h.publisher.publishes.length}`);
      check("A3b a malformed catalogue offers what was already registered",
        result.offered === CATALOG_A && result.catalogChanged === false,
        JSON.stringify({ offered: result.offered, changed: result.catalogChanged }));
    }

    // A4: PITFALLS §40 — the signature must describe what the DISK holds.
    // A store that reports `false` (write swallowed) must leave the signature
    // alone, so the next run with the same catalogue persists again instead of
    // skipping the write that would fix the disk.
    {
      const store = makeCatalogStore({ onReplace: () => false });
      const h = harness({ catalogStore: store });
      await h.effects.run(CATALOG_A, [], []);
      const firstPublished = h.publisher.publishes.length;
      const again = await h.effects.run(CATALOG_A, [], []);
      check("A4 a swallowed write failure does not advance the signature",
        again.catalogChanged === true && h.publisher.publishes.length === firstPublished + 1,
        `changed=${again.catalogChanged} publishes=${h.publisher.publishes.length}`);
    }

    // A5: two callers at once. Without the chain both would read the same
    // signature and both write; the negative control is `maxInFlight === 2`.
    {
      let inFlight = 0;
      let maxInFlight = 0;
      const order = [];
      const store = makeCatalogStore({
        async onReplace(entries) {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight--;
          order.push(entries.map((entry) => entry.id).join("+"));
          return true;
        }
      });
      const h = harness({ catalogStore: store });
      await Promise.all([
        h.effects.run(CATALOG_A, [], []),
        h.effects.run(CATALOG_B, [], [])
      ]);
      check("A5 concurrent runs never overlap their signature-check-and-write",
        maxInFlight === 1, `max in flight = ${maxInFlight}`);
      check("A5b concurrent runs apply in arrival order",
        order.join(" | ") === "Agnes-Lite+Agnes-Vision | Agnes-Lite", order.join(" | "));
    }

    // A6: one rejected write must not poison the queue forever.
    {
      let first = true;
      const store = makeCatalogStore({
        async onReplace(entries) {
          if (first) {
            first = false;
            throw new Error("disk full");
          }
          return true;
        }
      });
      const h = harness({ catalogStore: store });
      const rejected = await h.effects.run(CATALOG_A, [], []).then(() => null, (error) => error);
      check("A6 a failing write rejects the caller rather than passing silently",
        rejected instanceof Error && rejected.message === "disk full", String(rejected));
      const after = await h.effects.run(CATALOG_B, [], []).then(() => "resolved", (error) => String(error));
      check("A6b the chain survives a rejection and the next run works",
        after === "resolved", after);
    }

    // A7: the quota-exhausted set can flip without the catalogue changing.
    // The tick always passes `[]` (red line 7: nothing computes a blocked set),
    // so this branch must stay inert for it — the route owns that flip.
    {
      const h = harness();
      await h.effects.run(CATALOG_A, [], []);
      const publishesAfterFirst = h.publisher.publishes.length;
      await h.effects.run(CATALOG_A, [], []);
      check("A7 an unchanged blocked set republishes nothing",
        h.publisher.publishes.length === publishesAfterFirst,
        `${publishesAfterFirst} -> ${h.publisher.publishes.length}`);
      await h.effects.run(CATALOG_A, [], ["Agnes-Vision"]);
      check("A7b a changed blocked set rebuilds the registration without re-persisting",
        h.publisher.publishes.length === publishesAfterFirst + 1 && h.catalogStore.persisted.length === 1,
        `publishes=${h.publisher.publishes.length} persisted=${h.catalogStore.persisted.length}`);
    }
    // A8: a background caller asserts the CATALOGUE, never the allow-list.
    // `undefined` means "keep the stored list", so a refresh that started
    // before a panel save cannot write the stale copy it was holding over it.
    {
      const h = harness({ catalogStore: makeCatalogStore({ enabledIds: ["Agnes-Vision"] }) });
      await h.effects.run(CATALOG_A, undefined, []);
      check("A8 an undefined allow-list is forwarded as undefined, not as a list",
        h.catalogStore.persisted.length === 1 && h.catalogStore.persisted[0].enabledIds === undefined,
        JSON.stringify(h.catalogStore.persisted[0]?.enabledIds));
      check("A8b ... and the offer still quotes the STORED list",
        JSON.stringify(h.publisher.publishes[0]?.enabledIds) === '["Agnes-Vision"]',
        JSON.stringify(h.publisher.publishes[0]?.enabledIds));
    }

    // A9: the same run, but the save lands while the write is in flight. This is
    // the lost-update shape the tick used to open: a list read before the write
    // and asserted after it. The background path must not be able to do that.
    {
      let releaseReplace;
      const gate = new Promise((resolve) => { releaseReplace = resolve; });
      const store = makeCatalogStore({
        async onReplace(entries, enabledIds) {
          // The save lands in the window between "the store read the record"
          // and "the store wrote it".
          await gate;
          store.persisted.push({ entries, enabledIds });
          return true;
        }
      });
      const h = harness({ catalogStore: store });
      const running = h.effects.run(CATALOG_A, undefined, []);
      await settle();
      await store.setEnabledIds(["Agnes-Lite"]);   // the panel's save
      releaseReplace();
      await running;
      check("A9 a save landing mid-write is not overwritten by the background run",
        store.persisted[0]?.enabledIds === undefined,
        JSON.stringify(store.persisted[0]?.enabledIds));
    }
  } catch (error) { fail("A: run — the one writer", error); }
}

// === B. `refresh` — the read half, and its two cheap exits ================
{
  try {
    // B1: a fresh cache means no key read, no request, no disk. This is the
    // exit that makes a 30 s tick affordable; if it regresses, every tick
    // becomes a credentials read.
    {
      const h = harness({ cachedAt: Date.now() - (CATALOG_CACHE_MS - 60_000) });
      await h.effects.refresh();
      check("B1 a cache entry inside its TTL short-circuits before any work",
        h.fetchCalls.length === 0 && h.apiKeyStore.calls.length === 0 &&
          h.catalogStore.persisted.length === 0,
        JSON.stringify({
          fetch: h.fetchCalls.length,
          key: h.apiKeyStore.calls.length,
          persisted: h.catalogStore.persisted.length
        }));
    }

    // B2: no key at all — the fresh-install case. Silent, and nothing fetched.
    {
      const h = harness({ apiKey: "" });
      await h.effects.refresh();
      check("B2 no inference key means no fetch and no log line",
        h.fetchCalls.length === 0 && h.logs.length === 0,
        JSON.stringify({ fetch: h.fetchCalls.length, logs: h.logs }));
    }

    // B3: and the no-key answer is memoized, so the tick does not re-ask the
    // credentials service every interval. The cache can never answer for this
    // shape (nothing is ever cached without a key), which is exactly why the
    // memo has to exist.
    {
      const h = harness({ apiKey: "" });
      await h.effects.refresh();
      await h.effects.refresh();
      await h.effects.refresh();
      check("B3 repeated refreshes with no key ask the credentials seam once",
        h.apiKeyStore.calls.length === 1, `key reads = ${h.apiKeyStore.calls.length}`);
    }

    // B4: an expired cache with a key fetches once and applies the result.
    {
      const h = harness({ cachedAt: Date.now() - (CATALOG_CACHE_MS + 60_000) });
      await h.effects.refresh();
      check("B4 an expired cache is refetched exactly once",
        h.fetchCalls.length === 1, `fetch calls = ${h.fetchCalls.length}`);
      check("B4b the fetched catalogue is persisted and republished",
        h.catalogStore.persisted.length === 1 && h.publisher.publishes.length === 1,
        `persisted=${h.catalogStore.persisted.length} published=${h.publisher.publishes.length}`);
      check("B4c the fetch is handed the live key and the shared cache maps",
        h.fetchCalls[0]?.[4] === "sk-test" && h.fetchCalls[0]?.[2] instanceof Map,
        String(h.fetchCalls[0]?.[4]));
    }

    // B5: a gateway failure is a soft failure. The persisted catalogue and the
    // live registration must survive it untouched (ARCHITECTURE §5 invariant 3).
    // It is no longer SILENT, though: one line per failure STREAK is what makes
    // the backoff visible instead of looking like a quiet Host (D4 pins the
    // "once, not per attempt" half).
    {
      const h = harness({ fetchThrows: true });
      const threw = await h.effects.refresh().then(() => null, (error) => error);
      check("B5 a failing gateway does not reject the caller",
        threw === null, String(threw ?? "no throw"));
      check("B5c a failing gateway is reported exactly once",
        h.logs.length === 1, `logs=${JSON.stringify(h.logs)}`);
      check("B5b a failing gateway leaves the persisted catalogue alone",
        h.catalogStore.persisted.length === 0 && h.publisher.publishes.length === 0,
        `persisted=${h.catalogStore.persisted.length} published=${h.publisher.publishes.length}`);
    }

    // B6: a non-array answer is treated like no answer.
    {
      const h = harness({ fetchResult: { error: "unexpected" } });
      await h.effects.refresh();
      check("B6 a non-array catalogue answer changes nothing",
        h.catalogStore.persisted.length === 0 && h.publisher.publishes.length === 0,
        `persisted=${h.catalogStore.persisted.length} published=${h.publisher.publishes.length}`);
    }

    // B7: an unreadable allow-list falls back to the live registration's, which
    // is the last known-good curation — not to "no curation", which would
    // silently offer every model the account can reach.
    {
      const h = harness({ catalogStore: makeCatalogStore({ failEnabledIds: true }) });
      h.publisher.state.enabledIds = ["Agnes-Lite"];
      await h.effects.refresh();
      check("B7 an unreadable allow-list falls back to the live one",
        h.publisher.publishes.length === 1 &&
          JSON.stringify(h.publisher.publishes[0]?.enabledIds) === '["Agnes-Lite"]',
        JSON.stringify(h.publisher.publishes[0]?.enabledIds));
    }
    // B8: the tick asserts the catalogue, never the allow-list. It has no
    // curation of its own, so the only list it could pass is one it read
    // earlier — which is exactly the stale copy a save can land behind.
    {
      const h = harness({
        cachedAt: Date.now() - (CATALOG_CACHE_MS + 60_000),
        catalogStore: makeCatalogStore({ enabledIds: ["Agnes-Vision"] })
      });
      await h.effects.refresh();
      check("B8 refresh forwards 'keep the stored list', not a copy it read",
        h.catalogStore.persisted.length === 1 && h.catalogStore.persisted[0].enabledIds === undefined,
        JSON.stringify(h.catalogStore.persisted[0]?.enabledIds));
      check("B8b ... and the offer still quotes the stored list",
        JSON.stringify(h.publisher.publishes[0]?.enabledIds) === '["Agnes-Vision"]',
        JSON.stringify(h.publisher.publishes[0]?.enabledIds));
    }
  } catch (error) { fail("B: refresh — the read half", error); }
}

// === C. `start` — the Host's clock =======================================
// The timer is faked rather than slept on: `start` is about WHEN it fires and
// what it hands the platform, and a real 30 s interval is neither observable
// nor affordable in a suite that must stay under a second.
{
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  try {
    const handles = [];
    const cleared = [];
    let unrefCalls = 0;
    globalThis.setInterval = (callback, ms) => {
      const handle = {
        callback,
        ms,
        unref() {
          unrefCalls++;
          return handle;
        }
      };
      handles.push(handle);
      return handle;
    };
    globalThis.clearInterval = (handle) => { cleared.push(handle); };

    // C1: nothing fires at start. Mount stays network-free (the seed reads
    // disk); an open panel is what drives the first fetch.
    {
      const h = harness({ cachedAt: null });
      h.effects.start(30_000);
      await settle();
      check("C1 start does not tick immediately", h.fetchCalls.length === 0,
        `fetch calls = ${h.fetchCalls.length}`);
      check("C1b start schedules exactly one interval at the requested cadence",
        handles.length === 1 && handles[0].ms === 30_000,
        handles.map((handle) => handle.ms).join(","));
      check("C1c the interval is unref'd so an idle Host can still exit",
        unrefCalls === 1, `unref calls = ${unrefCalls}`);
    }

    // C2: the floor. A misconfigured cadence must not become a busy loop.
    {
      const before = handles.length;
      harness().effects.start(5);
      check("C2 a sub-second interval is floored at one second",
        handles[before]?.ms === 1_000, String(handles[before]?.ms));
    }

    // C3: a tick actually refreshes.
    {
      const h = harness({ cachedAt: null });
      h.effects.start(30_000);
      const handle = handles[handles.length - 1];
      handle.callback();
      await settle();
      check("C3 a tick fetches and applies when the cache has nothing",
        h.fetchCalls.length === 1 && h.catalogStore.persisted.length === 1,
        `fetch=${h.fetchCalls.length} persisted=${h.catalogStore.persisted.length}`);
    }

    // C4: stop() clears the timer AND makes a late callback inert — a tick that
    // fires during unmount must not publish into a withdrawn Host.
    {
      const h = harness({ cachedAt: null });
      const stop = h.effects.start(30_000);
      const handle = handles[handles.length - 1];
      stop();
      check("C4 stop clears the interval it created",
        cleared.length === 1 && cleared[0] === handle, `cleared = ${cleared.length}`);
      handle.callback();
      await settle();
      check("C4b a tick delivered after stop does nothing",
        h.fetchCalls.length === 0, `fetch calls = ${h.fetchCalls.length}`);
      stop();
      check("C4c stop is idempotent", cleared.length === 2, `cleared = ${cleared.length}`);
    }

    // C5: a refresh that REJECTS is logged once and never escapes the tick.
    // `refresh` swallows fetch/key/store failures itself, so the only way to
    // reject it is a publish that throws — which is also the case that would
    // take the Host down if the tick did not catch.
    {
      const publisher = makePublisher();
      publisher.publish = async () => { throw new Error("registration exploded"); };
      const h = harness({ cachedAt: null, publisher });
      h.effects.start(30_000);
      handles[handles.length - 1].callback();
      await settle();
      check("C5 a throwing publish is logged once, not thrown at the Host",
        h.logs.length === 1 && /registration exploded/.test(h.logs[0] ?? ""),
        JSON.stringify(h.logs));
    }
  } catch (error) { fail("C: start — the Host's clock", error); } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
}

// === D. `refresh` — a refused gateway backs off ==========================
// `sharedFetch` caches only SUCCESSES, so a failing fetch leaves the entry as
// stale as it was. Without a backoff the "cache is fresh" exit above can never
// fire and the tick's own interval becomes the retry rate: 120 requests an hour
// at the default cadence, 2,880 a day, forever, against a gateway that is
// already saying no. The clock is faked so the schedule is observable.
{
  const realNow = Date.now;
  try {
    const runHour = async (h) => {
      // One simulated hour of ticks at the default 30 s cadence.
      for (let elapsed = 0; elapsed < 3_600_000; elapsed += 30_000) {
        await h.effects.refresh();
        clock += 30_000;
      }
    };
    let clock = 50_000_000;
    Date.now = () => clock;

    // D1: the next tick after a failure does not fetch.
    {
      const h = harness({ cachedAt: null, fetchThrows: true });
      await h.effects.refresh();
      await h.effects.refresh();
      check("D1 a refused gateway is not retried on the very next tick",
        h.fetchCalls.length === 1, `fetch calls = ${h.fetchCalls.length}`);
      clock += CATALOG_RETRY_BASE_MS;
      await h.effects.refresh();
      check("D1b the retry fires once the first backoff has elapsed",
        h.fetchCalls.length === 2, `fetch calls = ${h.fetchCalls.length}`);
    }

    // D2: the wait doubles, so a persistent refusal cannot hold the tick rate.
    {
      const h = harness({ cachedAt: null, fetchThrows: true });
      await h.effects.refresh();                 // failure 1 → wait 30 s
      clock += CATALOG_RETRY_BASE_MS;
      await h.effects.refresh();                 // failure 2 → wait 60 s
      clock += CATALOG_RETRY_BASE_MS;            // 30 s into a 60 s wait
      await h.effects.refresh();
      check("D2 the second wait is twice the first",
        h.fetchCalls.length === 2, `fetch calls = ${h.fetchCalls.length}`);
      clock += CATALOG_RETRY_BASE_MS;            // exactly 60 s
      await h.effects.refresh();
      check("D2b ... and it fires exactly at the doubled delay",
        h.fetchCalls.length === 3, `fetch calls = ${h.fetchCalls.length}`);
    }

    // D3: the number this whole section exists for.
    {
      const h = harness({ cachedAt: null, fetchThrows: true });
      await runHour(h);
      check("D3 an hour of a dead gateway costs at most 8 attempts, not 120",
        h.fetchCalls.length <= 8, `fetch calls in one hour = ${h.fetchCalls.length}`);
    }

    // D4: the streak is announced once — a line per attempt would trade a
    // request flood for a log flood.
    {
      const h = harness({ cachedAt: null, fetchThrows: true });
      await h.effects.refresh();
      await h.effects.refresh();
      clock += CATALOG_RETRY_BASE_MS;
      await h.effects.refresh();
      check("D4 a failure streak is logged exactly once",
        h.logs.length === 1, `logs=${JSON.stringify(h.logs)}`);
      check("D4b the line says it is backing off, and for how long",
        /backing off/.test(h.logs[0] ?? "") && /30s/.test(h.logs[0] ?? ""), String(h.logs[0]));
    }

    // D5: a success resets the schedule — the next failure starts at the base
    // delay again, not at wherever the old streak had climbed to.
    {
      const h = harness({ cachedAt: null });
      h.effects = createCatalogEffects({
        settings: makeSettings(),
        cache: new Map(),
        inflight: new Map(),
        apiKeyStore: makeKeyStore("sk-test"),
        catalogStore: makeCatalogStore(),
        publisher: makePublisher(),
        logger: { warn: (message) => h.logs.push(message) },
        fetchCatalog: async (...args) => {
          h.fetchCalls.push(args);
          // Fail twice, then succeed, then fail again.
          if (h.fetchCalls.length <= 2 || h.fetchCalls.length === 4) throw new Error("gateway down");
          return CATALOG_A;
        }
      });
      await h.effects.refresh();                 // fail 1 → 30 s
      clock += CATALOG_RETRY_BASE_MS;
      await h.effects.refresh();                 // fail 2 → 60 s
      clock += 60_000;
      await h.effects.refresh();                 // success → reset
      check("D5 a success logs the recovery",
        h.logs.some((line) => /recovered after 2/.test(line)), JSON.stringify(h.logs));
      // The cache is now fresh, so the next failure has to come from an expired
      // entry — advance past it, then let the fake fail once more.
      clock += CATALOG_CACHE_MS;
      await h.effects.refresh();                 // fail 3
      const before = h.fetchCalls.length;
      await h.effects.refresh();                 // still inside the NEW 30 s wait
      check("D5b the schedule restarts at the base delay after a success",
        before === 4 && h.fetchCalls.length === 4, `fetch calls = ${h.fetchCalls.length}`);
    }

    // D6: the schedule is capped, and the cap is what bounds recovery time.
    {
      check("D6 the delay doubles up to the cap and stays there",
        retryDelayMs(1) === CATALOG_RETRY_BASE_MS &&
          retryDelayMs(2) === 2 * CATALOG_RETRY_BASE_MS &&
          retryDelayMs(99) === CATALOG_RETRY_MAX_MS &&
          retryDelayMs(1e9) === CATALOG_RETRY_MAX_MS,
        [retryDelayMs(1), retryDelayMs(2), retryDelayMs(99), retryDelayMs(1e9)].join(","));
    }
  } catch (error) { fail("D: refresh — the backoff", error); } finally {
    Date.now = realNow;
  }
}

// --- report ---------------------------------------------------------------
for (const { name, pass, detail } of results) {
  if (!pass) process.stderr.write(`FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
}
const passed = results.filter((entry) => entry.pass).length;
process.stdout.write(`${passed}/${results.length} checks passed\n`);
if (passed !== results.length) process.exit(1);
