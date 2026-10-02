/**
 * The model-roster route (docs/API.md) — the curated allow-list.
 *
 * Part of the routes split (see `../routes.ts` for the family map). The
 * safety shape mirrors the provider switch: an absent field is REFUSED rather
 * than read as "all models" (writing that would silently widen the offer), and
 * a save adopts the signature of what was just offered so the next poll does
 * not churn the registration.
 *
 * @module dsh-connect-agnes-token-plan/routes/models
 */

import { name } from "../host-config.ts";
import { isAdmittedWithAudit } from "../admission-audit.ts";
import { readPanelValue, resolveSwitchEnabled } from "../switch-precedence.ts";
import { normalizeEnabledIds } from "../catalog-store.ts";
import { catalogSignature } from "../provider-publish.ts";
import { redactError } from "../util.ts";
import { writeJson, refuseOrigin, refuseMethod, readJsonBodyOr400 } from "./http.ts";
import type { HostCtx, HostWiring } from "../types.ts";

/** The model-roster route (docs/API.md). */
export const MODELS_PATH = `/api/${name}/models`;

/** Ceiling on the curated allow-list: a catalogue this large is a posting accident. */
export const MAX_ENABLED_MODEL_IDS = 500;

/**
 * Register the model-roster route. Wiring subset: `settings`, `catalogStore`,
 * `providerStore`, `providerState`, `publishProvider`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {object} wiring - as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerModelsRoute(ctx: HostCtx, wiring: HostWiring) {
  const { settings, catalogStore, providerStore, providerState, publishProvider } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: MODELS_PATH,
    handler: async (request, response) => {
      // Same fence as the other routes: a foreign page must not be able to
      // decide which models this Host offers.
      if (!isAdmittedWithAudit(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
      const method = request.method === undefined ? "POST" : request.method;
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // An absent field is refused rather than read as "all models": writing
      // that would silently widen the offer to every model in the catalogue.
      if (!Array.isArray(body.value.enabledModelIds)) {
        writeJson(response, 400, { ok: false, error: "expected { enabledModelIds: string[] }" },
          { "cache-control": "no-store" });
        return;
      }
      const ids = normalizeEnabledIds(body.value.enabledModelIds);
      if (ids.length > MAX_ENABLED_MODEL_IDS) {
        writeJson(response, 400,
          { ok: false, error: `enabledModelIds is too long (max ${MAX_ENABLED_MODEL_IDS})` },
          { "cache-control": "no-store" });
        return;
      }
      const answer = async (extra = {}) => {
        writeJson(response, 200, {
          ok: true,
          enabledModelIds: await catalogStore.listEnabledIds().catch(() => providerState.enabledIds),
          registerProvider: resolveSwitchEnabled(
            await readPanelValue(() => providerStore.enabled()),
            settings.registerProvider
          ).enabled,
          providerRegistered: providerState.registered,
          ...(providerState.error !== null ? { providerError: providerState.error } : {}),
          ...extra
        }, { "cache-control": "no-store" });
      };
      try {
        const persisted = await catalogStore.setEnabledIds(ids);
        // The next poll must not re-publish the same offer: adopt the signature
        // of what was just offered, or every poll would churn the registration.
        // But only when it actually reached disk — a signature describing an
        // offer the disk does not hold would skip the write that fixes it
        // (PITFALLS §40).
        if (persisted) providerState.signature = catalogSignature(providerState.entries, ids);
        // Publish immediately with the CURRENT catalogue: the offer must not
        // wait for the next poll. A failed publish rolls back to the previous
        // pair inside publishProvider and surfaces its reason.
        await publishProvider(providerState.entries, ids, providerState.unavailableIds ?? []);
      } catch (error) {
        await answer({ ok: false, error: redactError(error) });
        return;
      }
      await answer();
    }
  });
}
