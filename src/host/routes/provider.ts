/**
 * The provider-registration switch route (docs/PROVIDER-HOT-RELOAD.md).
 *
 * Part of the routes split (see `../routes.ts` for the family map). Secret-free
 * by construction: the effective switch, its source, and whether a provider is
 * registered right now. A save publishes immediately with the CURRENT catalog —
 * the switch decides whether the models are offered, not what they are; a
 * failed publish rolls back inside `publishProvider`.
 *
 * @module dsh-connect-agnes-token-plan/routes/provider
 */

import { name } from "../host-config.ts";
import { isAdmittedWithAudit } from "../admission-audit.ts";
import { writeJson, refuseOrigin, refuseMethod, readJsonBodyOr400 } from "./http.ts";

/** The provider-registration switch route (docs/PROVIDER-HOT-RELOAD.md). */
export const PROVIDER_PATH = `/api/${name}/provider`;

/**
 * Register the provider switch route. Wiring subset: `settings`,
 * `providerStore`, `providerState`, `publishProvider`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {object} wiring - as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerProviderRoute(ctx, wiring) {
  const { settings, providerStore, providerState, publishProvider } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: PROVIDER_PATH,
    handler: async (request, response) => {
      // Same trust fence as the other three routes: a foreign page must not be
      // able to flip model routing for the whole Host.
      if (!isAdmittedWithAudit(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
      const method = request.method === undefined ? "GET" : request.method;
      // Secret-free by construction: the effective switch, where it came from,
      // and whether a provider is registered right now.
      const answer = async (extra = {}) => {
        const panelSwitch = await providerStore.enabled().catch(() => null);
        writeJson(
          response,
          200,
          {
            ok: true,
            registerProvider: (panelSwitch ?? settings.registerProvider) === true,
            registerSource: panelSwitch === null ? "config" : "panel",
            providerRegistered: providerState.registered,
            ...(providerState.error !== null ? { providerError: providerState.error } : {}),
            ...extra
          },
          { "cache-control": "no-store" }
        );
      };
      if (method === "GET") {
        await answer();
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      if (typeof body.value.enabled !== "boolean") {
        writeJson(response, 400, { ok: false, error: "expected { enabled: boolean }" }, { "cache-control": "no-store" });
        return;
      }
      try {
        await providerStore.save(body.value.enabled);
        // Publish immediately with the CURRENT catalog: the switch decides
        // whether the models are offered at all, not what they are. A failed
        // publish rolls back to the previous pair inside publishProvider and
        // surfaces its reason in providerState.error.
        await publishProvider(providerState.entries, providerState.enabledIds, providerState.unavailableIds ?? []);
      } catch (error) {
        await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      await answer();
    }
  });
}
