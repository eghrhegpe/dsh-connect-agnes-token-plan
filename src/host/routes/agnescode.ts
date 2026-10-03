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

import { name } from "../host-config.ts";
import { isAdmittedWithAudit } from "../admission-audit.ts";
import { readPanelValue, resolveSwitchEnabled } from "../switch-precedence.ts";
import { redactSecrets } from "../util.ts";
import {
  fetchAgnescodeCatalog,
  fetchAgnescodeBalance,
  harvestAgnescodeLocalSession,
  decodeAgnescodeJwtExpMs,
  AGNESCODE_FALLBACK_MODELS
} from "../agnescode.ts";
import { filterAgnescodeRows } from "../agnescode-models.ts";
import { writeJson, refuseOrigin, refuseMethod, readJsonBody } from "./http.ts";
import type { HostCtx, HostWiring } from "../types.ts";

/** The AgnesCode provider route (ROADMAP §6.3 "third upstream provider"). */
export const AGNESCODE_PATH = `/api/${name}/agnescode`;

/** Ceiling on an AgnesCode action body: every action posts a bare `{action}`. */
const MAX_AGNESCODE_BODY_BYTES = 2048;

/** The GET self-heal publishes at most once per this window (see the GET branch). */
const AGNESCODE_SELF_HEAL_COOLDOWN_MS = 60_000;

/**
 * Register the AgnesCode route. Wiring subset: `settings`, `agnescodeStore`,
 * `agnescodeSwitch`, `agnescodePublisher`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {object} wiring - as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerAgnescodeRoute(ctx: HostCtx, wiring: HostWiring) {
  const { settings, agnescodeStore, agnescodeSwitch, agnescodePublisher, agnescodeModels } = wiring;

  // ── The AgnesCode route: the desktop-app upstream provider (ROADMAP §6.3) ──
  // The route-scoped state — declared BEFORE any handler runs, never after a
  // branch that reads it (the shipped TDZ bug lived exactly there).
  let lastHarvest: { ok: boolean; attempts: Array<{ file: string | null; tier: string; detail: string }> } | null = null;
  let agnescodeHarvestInFlight: Promise<{ ok: boolean; attempts: Array<{ file: string | null; tier: string; detail: string }> }> | null = null;
  // The GET self-heal's cooldown stamp (see the GET branch): one repair
  // publish per window, so a persistently failing publish cannot rebuild the
  // adapter on every panel poll.
  let agnescodeSelfHealAt = 0;

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
        let balance: unknown = null;
        let error: string | null = null;
        try {
          if (agnescodeStore !== null && agnescodeStore !== undefined) {
            const state = await agnescodeStore.state().catch(() => null);
            loggedIn = state?.hasCredential === true;
            nickname = state?.nickname ?? "";
            bffBase = state?.bffBase ?? "";
            expiresAtMs = state?.expiresAtMs ?? null;
            if (loggedIn) {
              const { credential } = await agnescodeStore.resolve().catch(() => ({ credential: null }));
              if (credential?.accessToken) {
                balance = await fetchAgnescodeBalance(credential).catch(() => null);
              }
            }
          }
        } catch (why) {
          error = redactSecrets(why instanceof Error ? why.message : String(why));
        }
        // The roster the adapter offers: the live catalogue when a credential
        // exists, else the static fallback so the panel still shows the
        // known models.
        let models: unknown = null;
        try {
          if (agnescodeStore !== null && agnescodeStore !== undefined) {
            const { credential } = await agnescodeStore.resolve().catch(() => ({ credential: null }));
            if (credential?.accessToken) {
              models = await fetchAgnescodeCatalog(credential).catch(() => null);
            }
          }
        } catch {
          models = null;
        }
        const roster = models !== null && Array.isArray(models) && models.length > 0
          ? models
          : AGNESCODE_FALLBACK_MODELS;
        const publisherState = agnescodePublisher?.state ?? null;
        // The curated subset (empty = no curation = push the roster whole).
        const enabledModelIds = agnescodeModels !== null && agnescodeModels !== undefined
          ? await agnescodeModels.listEnabledIds().catch(() => [])
          : [];
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
          balance,
          models: roster,
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
        let rows = AGNESCODE_FALLBACK_MODELS;
        let bffBase = "";
        try {
          const { credential } = agnescodeStore ? await agnescodeStore.resolve().catch(() => ({ credential: null })) : { credential: null };
          if (credential?.accessToken) {
            const live = await fetchAgnescodeCatalog(credential).catch(() => null);
            if (live !== null && live.length > 0) rows = live;
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

      const method = request.method === undefined ? "GET" : request.method;
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
              lastHarvest = { ok: walk.ok, attempts: walk.attempts };
              if (walk.ok !== true) return { ok: false, attempts: walk.attempts };
              const expMs = decodeAgnescodeJwtExpMs(walk.session.accessToken);
              await agnescodeStore.save({
                accessToken: walk.session.accessToken,
                bffBase: walk.session.bffBase,
                ...(walk.session.userId !== "" ? { userId: walk.session.userId } : {}),
                ...(walk.session.nickname !== "" ? { nickname: walk.session.nickname } : {}),
                ...(expMs !== undefined ? { expiresAtMs: expMs } : {})
              });
              return { ok: true, attempts: walk.attempts };
            })().finally(() => {
              agnescodeHarvestInFlight = null;
            });
          }
          const walk = await agnescodeHarvestInFlight;
          if (walk.ok !== true) {
            await answer({ ok: false, status: "not_found", harvest: walk });
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
