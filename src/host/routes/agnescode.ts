/**
 * The AgnesCode provider route — the desktop-app upstream (ROADMAP §6.3).
 *
 * Part of the routes split (see `../routes.ts` for the family map). The
 * credential is HARVESTED from the desktop App's os_crypt session file (the
 * user logs in THERE, WeChat-side), so the login-equivalent action is
 * 「检测本机登录态」— a harvest-then-save walk whose failure mode is the
 * per-file diagnosis list the tab renders. Every answer is secret-free:
 * tier codes and shape facts only — a token NEVER enters this payload, and
 * error text passes `redactSecrets` before it can.
 *
 * The last walk's rows and the in-flight walk live at the ROUTE scope, not
 * per request. Two reasons, and the first one is a bug that shipped:
 *   * per-request `let lastHarvest` sat AFTER the GET branch, so the GET ran
 *     `agnescodeState()` while the binding was still in its temporal dead
 *     zone and the whole route threw — the panel's poll never saw the
 *     harvested account and kept showing「未关联」while the credential was
 *     already stored;
 *   * the single-flight comment only holds across requests if the promise
 *     outlives one, and the panel genuinely does poll while a walk runs.
 *
 * @module dsh-connect-agnes-token-plan/routes/agnescode
 */

import { createHash } from "node:crypto";
import { name } from "../host-config.ts";
import { isAdmittedWithAudit } from "../admission-audit.ts";
import { readPanelValue, resolveSwitchEnabled } from "../switch-precedence.ts";
import { obj, redactSecrets, str } from "../util.ts";
import {
  fetchAgnescodeCatalog,
  fetchAgnescodeBalance,
  fetchAgnescodeLedger,
  harvestAgnescodeLocalSession,
  decodeAgnescodeJwtExpMs,
  AGNESCODE_FALLBACK_MODELS,
  AGNESCODE_FALLBACK_ASOF
} from "../agnescode.ts";
import { filterAgnescodeRows, agnescodeRoster } from "../agnescode-models.ts";
import { createFileAgnescodeStatsStore } from "../agnescode-stats-store.ts";
import { writeJson, refuseOrigin, refuseMethod, requestMethod, readJsonBody } from "./http.ts";
import type { CacheMap, HostCtx, HostWiring, InflightMap } from "../types.ts";

/** One row of the harvest diagnosis the panel shows: which file was probed, how
 * it was classified, and why. `detail` is an error string, not a token — but it
 * is still red-line #1 material the moment it leaves the route, so every
 * detail is redacted before the rows can be answered. */
type HarvestAttempt = { file: string | null; tier: string; detail: string };

/** Map the harvest rows through `redactSecrets`, at the single choke point. */
function redactHarvestAttempts(attempts: HarvestAttempt[]): HarvestAttempt[] {
  return attempts.map((attempt) => ({ ...attempt, detail: redactSecrets(attempt.detail) }));
}

/** The AgnesCode provider route (ROADMAP §6.3 "third upstream provider"). */
export const AGNESCODE_PATH = `/api/${name}/agnescode`;

/** Ceiling on an AgnesCode action body: every action posts a bare `{action}`. */
const MAX_AGNESCODE_BODY_BYTES = 2048;

/** The GET self-heal publishes at most once per this window (see the GET branch). */
const AGNESCODE_SELF_HEAL_COOLDOWN_MS = 60_000;

/**
 * How long one AgnesCode BFF read is reused. The tab polls every 60 s
 * (`AGNESCODE_POLL_MS`) and the composer pill polls this same route on the same
 * cadence, so a window shorter than the cadence would de-duplicate only the
 * concurrent readers; this one also absorbs a poll that lands while the
 * previous answer is still fresh (two panels, two sessions, a re-render).
 */
const AGNESCODE_READ_CACHE_MS = 60_000;

/**
 * How long one credits-ledger aggregate is reused. It is a SLOW-CHANGING fact
 * (window totals over 30 days), NOT a per-poll read: re-walking up to five
 * pages on every 60 s poll would pound the BFF. A 5-minute TTL keeps the
 * numbers fresh enough for "am I close to the limit" while capping upstream
 * load; the panel picks up the settled value on its next tick.
 */
const AGNESCODE_LEDGER_TTL_MS = 5 * 60_000;

/** The keys THIS route owns inside the shared cache map. */
const AGNESCODE_CACHE_PREFIX = "agnescode:";

/**
 * A stable, non-reversible account discriminator for a cache key.
 *
 * The token must not become part of a key (red line #1 governs where a
 * credential is allowed to BE), and the base URL alone cannot be the key: one
 * URL answers with a DIFFERENT balance per account, and serving one account's
 * balance beside another's catalogue is the identity-mixing bug this route
 * already fixed once by resolving the credential exactly once. A truncated
 * SHA-256 of a high-entropy JWT cannot be walked back to the token.
 * @param {string} token - the session token.
 * @returns {string} 16 hex chars.
 */
function accountFingerprint(token: string) {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * The cache / single-flight key for one account's read of one BFF endpoint.
 * @param {string} kind - `"balance"` or `"catalog"`.
 * @param {unknown} credential - `{ accessToken, bffBase }`.
 * @returns {string} the key.
 */
function agnescodeReadKey(kind: string, credential: unknown) {
  const source = obj(credential);
  return `${AGNESCODE_CACHE_PREFIX}${kind}:${str(source.bffBase, "")}:${accountFingerprint(str(source.accessToken, ""))}`;
}

/**
 * Read-through cache + single-flight for the two AgnesCode BFF reads.
 *
 * WHY THIS IS NOT `console-client.ts`'s `sharedFetch`, which performs the same
 * three moves for the Token Plan fetches — the difference is in the interface,
 * not in the intent:
 *
 * 1. **The key is the ACCOUNT, not the URL.** One URL answers per account, so a
 *    URL key would hand account A's balance to account B.
 * 2. **These producers report failure by RETURNING `null`** (`fetchAgnescode*`
 *    catch their own transport errors), while `sharedFetch` requires a throw —
 *    it writes the map only after the value has been judged. Here a `null`/
 *    `undefined` is the ABSENCE of an answer and must not be written down:
 *    caching one would freeze「暂无数据」for the whole window and turn a
 *    transient BFF hiccup into a minute with no balance. A throw caches nothing
 *    either, and the `finally` drops the in-flight entry on both paths so the
 *    next poll genuinely retries instead of awaiting a rejected promise.
 *
 * The gain is the point of the whole thing: without it one GET costs TWO
 * upstream calls, and every additional open panel or pill multiplies that. The
 * tab and the composer pill now share a single upstream read through here.
 * @param {string} key - the account-scoped key (see `agnescodeReadKey`).
 * @param {CacheMap} cache - the shared response cache (`wiring.cache`).
 * @param {InflightMap} inflight - the shared single-flight map.
 * @param {() => Promise<unknown>} produce - performs the read.
 * @returns {Promise<unknown>} the cached, shared, or freshly produced answer.
 */
function readThroughAgnescode(
  key: string,
  cache: CacheMap,
  inflight: InflightMap,
  produce: () => Promise<unknown>
): Promise<unknown> {
  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - cached.at < AGNESCODE_READ_CACHE_MS) return Promise.resolve(cached.body);
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;
  const flight = (async () => {
    const body = await produce();
    if (body !== null && body !== undefined) {
      cache.set(key, { body, at: Date.now() });
      // `console-client`'s sweeper only runs on console traffic, so a machine
      // that stops polling there would leave OUR entries behind: expire this
      // route's own keys on every write. Bounded by accounts × 2 kinds.
      for (const [other, entry] of cache) {
        if (other !== key && other.startsWith(AGNESCODE_CACHE_PREFIX) && Date.now() - entry.at >= AGNESCODE_READ_CACHE_MS) {
          cache.delete(other);
        }
      }
    }
    return body;
  })().finally(() => { inflight.delete(key); });
  inflight.set(key, flight);
  return flight;
}

/**
 * Register the AgnesCode route. Wiring subset: `settings`, `agnescodeStore`,
 * `agnescodeSwitch`, `agnescodePublisher`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {object} wiring - as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerAgnescodeRoute(ctx: HostCtx, wiring: HostWiring) {
  const { settings, agnescodeStore, agnescodeSwitch, agnescodePublisher, agnescodeModels, cache, inflight, agnescodeFetch } = wiring;

  // ── The AgnesCode route: the desktop-app upstream provider (ROADMAP §6.3) ──
  // The route-scoped state — declared BEFORE any handler runs, never after a
  // branch that reads it (the shipped TDZ bug lived exactly there).
  let lastHarvest: { ok: boolean; attempts: Array<{ file: string | null; tier: string; detail: string }> } | null = null;
  let agnescodeHarvestInFlight: Promise<{ ok: boolean; attempts: Array<{ file: string | null; tier: string; detail: string }> }> | null = null;
  // The GET self-heal's cooldown stamp (see the GET branch): one repair
  // publish per window, so a persistently failing publish cannot rebuild the
  // adapter on every panel poll.
  let agnescodeSelfHealAt = 0;
  // The plugin's own rate-limit record. NOT per-profile: the count is a fact
  // about this machine's traffic against the account, so a restarted profile
  // must still see what the other logged minutes ago (PITFALLS §23, same
  // reasoning as the throttle store).
  const agnescodeStats = createFileAgnescodeStatsStore();

  // ── Ledger aggregate: its OWN route-scoped cache + single-flight ──
  // Decoupled from the shared `cache`/`inflight` on purpose:
  //   * it is a SLOW-CHANGING fact, so it gets the longer `AGNESCODE_LEDGER_TTL_MS`
  //     (the shared sweep runs on the 60 s read TTL and would thrash it);
  //   * the GET must NEVER await the multi-page walk. `readOrPrimeLedger` serves
  //     whatever is cached (or null) and primes a BACKGROUND refresh when the
  //     entry is stale — the panel's 60 s poll picks up the settled value on the
  //     next tick. First appearance is one poll late: an honest "not yet", not
  //     a failure, and the panel renders the rest of the card meanwhile.
  const ledgerCache = new Map<string, { body: unknown; at: number }>();
  const ledgerInflight = new Map<string, Promise<unknown>>();
  const readOrPrimeLedger = (key: string, produce: () => Promise<unknown>): Promise<unknown> => {
    const cached = ledgerCache.get(key);
    const isFresh = cached !== undefined && Date.now() - cached.at < AGNESCODE_LEDGER_TTL_MS;
    if (!isFresh && ledgerInflight.get(key) === undefined) {
      const flight = (async () => {
        let body: unknown = null;
        try {
          body = await produce();
        } catch {
          body = null;
        }
        if (body !== null && body !== undefined) ledgerCache.set(key, { body, at: Date.now() });
        return body;
      })();
      flight.finally(() => ledgerInflight.delete(key));
      ledgerInflight.set(key, flight);
    }
    return Promise.resolve(cached?.body ?? null);
  };

  return ctx.webServer.register({
    kind: "exact",
    path: AGNESCODE_PATH,
    handler: async (request, response) => {
      if (!isAdmittedWithAudit(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
      // The GET's secret-free state, reused by every POST branch. The
      // `harvest` block carries the last walk's diagnosis rows (tier codes
      // and shape facts only — a token NEVER enters this payload).
      const agnescodeState = async () => {
        // AgnesCode has NO config default — `Settings` carries no key for it.
        // Omitting the second argument is what says so: an unset panel value
        // resolves to "off", never to a default nobody declared. Writing this
        // as `(switch ?? settings.x) === true` would make the provider
        // register itself the day such a key is added to the patch schema.
        const { enabled: effectiveEnabled, source: switchSource } = resolveSwitchEnabled(
          await readPanelValue(() => agnescodeSwitch?.enabled())
        );
        let loggedIn = false;
        let nickname = "";
        let bffBase = "";
        let expiresAtMs: number | null = null;
        // Host-side, not client-derived: the panel renders this as a warning,
        // and a browser that computed it from `expiresAtMs` would own a second
        // copy of the expiry rule.
        let expired = false;
        let balance: unknown = null;
        let error: string | null = null;
        // Resolved ONCE and reused for both BFF calls. Each was its own
        // `resolve()`, so a walk landing between the two (the re-harvest is a
        // live path, not a rare one) could leave one account's balance beside
        // another account's catalogue in the SAME payload — which the panel
        // presents as a single identity.
        let credential: { accessToken: string; bffBase?: string } | null = null;
        try {
          if (agnescodeStore !== null && agnescodeStore !== undefined) {
            const state = await agnescodeStore.state().catch(() => null);
            loggedIn = state?.hasCredential === true;
            nickname = state?.nickname ?? "";
            bffBase = state?.bffBase ?? "";
            expiresAtMs = state?.expiresAtMs ?? null;
            expired = state?.expired === true;
            credential = (await agnescodeStore.resolve().catch(() => ({ credential: null }))).credential ?? null;
          }
        } catch (why) {
          error = redactSecrets(why instanceof Error ? why.message : String(why));
        }
        // Both BFF reads share the ONE resolved credential above, and they run
        // IN PARALLEL (2026-10-10; they used to await one after the other).
        // Each carries its own 30 s ceiling, so the serial shape held this
        // route — and a browser connection — for up to ~60 s whenever the
        // upstream was slow or unreachable; the parallel shape bounds the GET
        // to the SLOWER of the two. (A DEAD token is the fast case: the BFF
        // refuses it in seconds, so it never reaches either ceiling.)
        let models: unknown = null;
        let ledger: unknown = null;
        if (credential?.accessToken) {
          // Both reads go through the account-keyed cache + single-flight, so
          // the two readers of this route (the tab and the composer pill, both
          // on the 60 s cadence) share ONE upstream read instead of costing two
          // calls each on every poll. See `readThroughAgnescode`.
          const [b, m] = await Promise.all([
            // Balance stays gated on `loggedIn` as before: no stored identity,
            // no balance call.
            loggedIn
              ? readThroughAgnescode(agnescodeReadKey("balance", credential), cache, inflight,
                () => fetchAgnescodeBalance(credential, agnescodeFetch)).catch(() => null)
              : Promise.resolve(null),
            readThroughAgnescode(agnescodeReadKey("catalog", credential), cache, inflight,
              () => fetchAgnescodeCatalog(credential, agnescodeFetch)).catch(() => null)
          ]);
          balance = b;
          models = m;
          // The ledger is account-scoped, so it gates on `loggedIn` exactly like
          // balance: no stored identity, no call. It is a SLOW-CHANGING window
          // aggregate, so it goes through `readOrPrimeLedger` (background
          // prime, serve-cached) rather than `readThroughAgnescode` (awaited):
          // this GET's worst case stays the SLOWER of balance/catalog, and the
          // multi-page walk settles out of band for the next poll. See the
          // block above for why that decoupling exists.
          if (loggedIn) {
            ledger = await readOrPrimeLedger(
              agnescodeReadKey("ledger", credential),
              () => fetchAgnescodeLedger(credential, agnescodeFetch)
            );
          }
        }
        // WHICH roster the panel is about to show — the live `/v2/models`
        // answer or the built-in list of FROZEN rates — decided once, so the
        // flag and the rows can never disagree. The panel prints the fallback's
        // `asOf` date, so a rate captured at probe time is never presented as a
        // live one.
        const liveRoster = models !== null && Array.isArray(models) && models.length > 0;
        // Through `agnescodeRoster`, NOT the raw array: it applies
        // `maxTokensOverrides` with the same resolver the descriptor build uses,
        // so the "最大输出" badge the panel prints is the figure the request
        // actually carries. Passing the bare catalogue here was the trap — the
        // panel would have shown the platform's claim while the wire sent the
        // operator's correction.
        const roster = agnescodeRoster(liveRoster ? models : AGNESCODE_FALLBACK_MODELS, settings.maxTokensOverrides);
        const publisherState = agnescodePublisher?.state ?? null;
        // The curated subset (empty = no curation = push the roster whole).
        const enabledModelIds = agnescodeModels !== null && agnescodeModels !== undefined
          ? await agnescodeModels.listEnabledIds().catch(() => [])
          : [];
        // Host-side aggregate of this plugin's OWN traffic. The daily breakdown
        // stays here — only the windowed counts and the last-event times go
        // out, so the wire never carries per-day history. `read()` returns the
        // rate-limit roll and the per-client usage roll together; they are
        // served as two sibling keys because they answer two different
        // questions ("did I get throttled" vs "how much did my calls spend").
        const { usage, ...rateLimit } = await agnescodeStats.read();
        return {
          ok: true,
          enabled: effectiveEnabled,
          switchSource,
          loggedIn,
          nickname,
          // The per-account base is a fact the panel can show (it is WHERE
          // the account's requests go) — secret-free, from the session file.
          bffBase,
          expiresAtMs,
          expired,
          balance,
          rateLimit,
          // This plugin's OWN per-client usage roll (request count + token
          // totals, today and 30-day). Sibling of `rateLimit`, from the same
          // stats read. Flat scalars only — the daily buckets stay Host-side.
          usage,
          // Window aggregate of the credits ledger (today / last-30-day totals
          // plus the "covered" flag). Account-scoped; `null` when not logged in
          // or the background prime has not settled yet (first poll after a
          // fresh login). The panel renders a row for it only when present.
          ledger,
          models: roster,
          // Flat scalars, not a nested block: §11b's contract fence walks this
          // literal by brace depth, and `modelsSource` is what lets the panel
          // say "this is the built-in list, rates as of <date>" instead of
          // presenting frozen prices as live ones.
          modelsSource: liveRoster ? "live" : "fallback",
          ...(liveRoster ? {} : { modelsAsOf: AGNESCODE_FALLBACK_ASOF }),
          enabledModelIds,
          providerRegistered: publisherState?.registered === true,
          ...(publisherState?.error !== null && publisherState?.error !== undefined ? { providerError: publisherState.error } : {}),
          ...(lastHarvest !== null ? { harvest: lastHarvest } : {}),
          ...(error !== null ? { error } : {})
        };
      };

      /** Drive the registration from the CURRENT stored credential: the live
       *  catalogue wins over the fallback, the base comes from the credential
       *  (empty when there is none — the publisher's gate then releases). */
      const publishFromStore = async () => {
        if (agnescodePublisher === null || agnescodePublisher === undefined) return;
        // Annotated (not inferred from the fallback): the fallback happens to
        // carry `multiplier` on every row, so inference would make it required
        // and reject a LIVE catalogue row whose model has no published price
        // (`auto` is excluded, but a future unpriced model would hit this).
        let rows: ReadonlyArray<{ id: string; name: string; vision: boolean; memberOnly: boolean; multiplier?: number; contextWindow?: number; maxOutputLength: number }> = AGNESCODE_FALLBACK_MODELS;
        let bffBase = "";
        try {
          const { credential } = agnescodeStore ? await agnescodeStore.resolve().catch(() => ({ credential: null })) : { credential: null };
          if (credential?.accessToken) {
            // The catalogue read is shared with the GET (same key), so a
            // self-heal publish does not add a third call on a poll that just
            // read the catalogue — and a save that re-publishes reuses the
            // answer the save itself already triggered.
            const live = await readThroughAgnescode(agnescodeReadKey("catalog", credential), cache, inflight,
              () => fetchAgnescodeCatalog(credential, agnescodeFetch)).catch(() => null);
            // `Array.isArray` (not `!== null`): the read returns `unknown`, and
            // only the array check narrows it to a roster — the same move the
            // GET's `liveRoster` makes.
            if (Array.isArray(live) && live.length > 0) rows = live;
            bffBase = credential.bffBase ?? "";
          }
        } catch {
          // Fallback roster is already the safe default.
        }
        // The panel's curation is a filter over the roster, never a catalogue
        // of its own: only the ticked ids ride into the registration.
        const enabledIds = agnescodeModels !== null && agnescodeModels !== undefined
          ? await agnescodeModels.listEnabledIds().catch(() => [])
          : [];
        await agnescodePublisher.publish(filterAgnescodeRows(rows, enabledIds), bffBase);
      };

      const method = requestMethod(request, "GET");
      if (method === "GET") {
        let state = await agnescodeState();
        // Self-heal: an UNREGISTERED state alongside a stored credential is a
        // STALE publish — the switch was toggled before the harvest (leaving
        // `not_configured`), or the mount seed ran before the `llm`/credentials
        // services were resolvable (leaving `no llm registration service`), and
        // nothing after that failure re-ran the publish. GET used to only read.
        // One queued publish per cooldown lets any poll repair it, so the
        // reader never has to click anything to converge; a publish that fails
        // again stops holding this exact condition only if it reports
        // differently, so the cooldown keeps a persistently failing publish
        // from rebuilding the adapter every 60 s.
        const staleRegistration = state.providerRegistered !== true
          && state.providerError !== null && state.providerError !== undefined && state.providerError !== "";
        if (
          state.enabled === true && state.loggedIn === true && staleRegistration
          && Date.now() - agnescodeSelfHealAt > AGNESCODE_SELF_HEAL_COOLDOWN_MS
        ) {
          agnescodeSelfHealAt = Date.now();
          await publishFromStore();
          state = await agnescodeState();
        }
        writeJson(response, 200, state, { "cache-control": "no-store" });
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBody(request, MAX_AGNESCODE_BODY_BYTES);
      if (!body.ok) {
        writeJson(response, 400, { ok: false, error: body.error }, { "cache-control": "no-store" });
        return;
      }
      const { action } = body.value;
      const answer = async (extra = {}) => {
        const state = await agnescodeState();
        writeJson(response, 200, { ...state, ...extra }, { "cache-control": "no-store" });
      };

      // ── switch: register / deregister the AgnesCode provider with DSH ──
      if (action === "switch") {
        if (typeof body.value.enabled !== "boolean") {
          writeJson(response, 400, { ok: false, error: "expected { action: \"switch\", enabled: boolean }" }, { "cache-control": "no-store" });
          return;
        }
        if (agnescodeSwitch === null || agnescodeSwitch === undefined) {
          await answer({ ok: false, error: "the agnescode switch is unavailable" });
          return;
        }
        try {
          await agnescodeSwitch.save(body.value.enabled);
          await publishFromStore();
        } catch (error) {
          await answer({ ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) });
          return;
        }
        await answer();
        return;
      }

      // ── saveModels: curate which of the roster's models the adapter offers ──
      // The panel's tick-list, persisted then re-published, so a curation is
      // LIVE the moment it is saved ("改动即时生效") rather than on the next poll.
      if (action === "saveModels") {
        if (!Array.isArray(body.value.enabledModelIds)) {
          writeJson(response, 400, { ok: false, error: 'expected { action: "saveModels", enabledModelIds: string[] }' }, { "cache-control": "no-store" });
          return;
        }
        if (agnescodeModels === null || agnescodeModels === undefined) {
          await answer({ ok: false, error: "the agnescode model store is unavailable" });
          return;
        }
        try {
          await agnescodeModels.save(body.value.enabledModelIds);
          await publishFromStore();
        } catch (error) {
          await answer({ ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) });
          return;
        }
        await answer();
        return;
      }

      // ── harvest: re-read the desktop App's session file and store it ──
      if (action === "harvest") {
        if (agnescodeStore === null || agnescodeStore === undefined) {
          await answer({ ok: false, error: "the agnescode credential store is unavailable" });
          return;
        }
        try {
          // Single-flighted: the WHOLE walk (harvest + store save) runs once;
          // a concurrent request joins the same promise and shares both the
          // saved credential and the diagnosis rows.
          if (agnescodeHarvestInFlight === null) {
            agnescodeHarvestInFlight = (async () => {
              const walk = await harvestAgnescodeLocalSession();
              // The rows carry tier codes and shape facts — never the token —
              // but each `detail` is an error string (a file path, a fs reason)
              // that reaches the panel, so it is redacted at this single choke
              // point rather than trusting the harvest to remember.
              const attempts = redactHarvestAttempts(walk.attempts);
              if (walk.ok !== true) {
                lastHarvest = { ok: false, attempts };
                return { ok: false, attempts };
              }
              const expMs = decodeAgnescodeJwtExpMs(walk.session.accessToken);
              try {
                await agnescodeStore.save({
                  accessToken: walk.session.accessToken,
                  bffBase: walk.session.bffBase,
                  ...(walk.session.userId !== "" ? { userId: walk.session.userId } : {}),
                  ...(walk.session.nickname !== "" ? { nickname: walk.session.nickname } : {}),
                  ...(expMs !== undefined ? { expiresAtMs: expMs } : {})
                });
              } catch (saveError) {
                // The store refused the credential: the harvest WALKED ok, but
                // nothing was persisted. Mark the attempt failed so the next GET
                // does not report success for a save that never landed, then
                // rethrow so the route's catch answers the POST with the error.
                lastHarvest = { ok: false, attempts };
                throw saveError;
              }
              lastHarvest = { ok: true, attempts };
              return { ok: true, attempts };
            })().finally(() => {
              agnescodeHarvestInFlight = null;
            });
          }
          const walk = await agnescodeHarvestInFlight;
          if (walk.ok !== true) {
            await answer({ ok: false, status: "not_found", error: "no usable session found in the desktop App's session file", harvest: walk });
            return;
          }
        } catch (error) {
          await answer({ ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) });
          return;
        }
        if (agnescodePublisher !== null && agnescodePublisher !== undefined && agnescodePublisher.isDisposed() === false) {
          if (resolveSwitchEnabled(await readPanelValue(() => agnescodeSwitch?.enabled())).enabled) {
            await publishFromStore();
          }
        }
        await answer({ ok: true, status: "harvested" });
        return;
      }

      writeJson(response, 400, { ok: false, error: "expected { action: \"switch\"|\"harvest\"|\"saveModels\" }" }, { "cache-control": "no-store" });
    }
  });
}
