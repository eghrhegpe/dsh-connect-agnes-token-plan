/**
 * The INTL provider-registration switch route (ADR-021) — the INTERNATIONAL
 * row's twin of `routes/provider.ts`.
 *
 * Same discipline, one site apart: the switch lives in its own state file
 * (`intl-provider.json`, dialect A — the panel value beats the patch's
 * `registerProviderIntl`), a save republishes the INTL row with the CURRENT
 * INTL catalogue, and a failed publish rolls back inside the INTL publisher's
 * own queue. The route answers the EFFECTIVE value plus its source, so the
 * panel can say "面板 / 配置" for the switch it shows — a value without a
 * source is a line the operator cannot act on.
 *
 * @module dsh-connect-agnes-token-plan/routes/provider-intl
 */

import { name } from "../host-config.ts";
import { LLM_PROVIDER_ID_INTL } from "../llm-models.ts";
import { isAdmittedWithAudit } from "../admission-audit.ts";
import { readPanelValue, resolveSwitchEnabled } from "../switch-precedence.ts";
import { redactError } from "../util.ts";
import { writeJson, refuseOrigin, refuseMethod, requestMethod, readJsonBodyOr400 } from "./http.ts";
import type { HostCtx, HostWiring } from "../types.ts";

/** The INTL provider-registration switch route (ADR-021). */
export const PROVIDER_INTL_PATH = `/api/${name}/provider-intl`;

/**
 * Register the INTL provider switch route. Wiring subset: `settings`,
 * `intlProviderStore`, `intlPublisher` (its `state` and `publish`).
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {object} wiring - as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerProviderIntlRoute(ctx: HostCtx, wiring: HostWiring) {
  const { settings, intlProviderStore, intlPublisher } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: PROVIDER_INTL_PATH,
    handler: async (request, response) => {
      // The same fence as every write route: a foreign page must not be able
      // to flip a whole Host's INTL model routing.
      if (!isAdmittedWithAudit(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
      const method = requestMethod(request, "GET");
      // Secret-free by construction: the effective switch, where it came
      // from, and whether the INTL provider is registered right now. A Host
      // that did not assemble the INTL row (a pre-ADR-021 build) still
      // answers: the switch state it can read, and `providerRegistered:false`
      // — the panel degrades to "row not active", never to an error page.
      const answer = async (extra = {}) => {
        const intlSwitch = resolveSwitchEnabled(
          await readPanelValue(
            intlProviderStore === undefined ? undefined : () => intlProviderStore.enabled().catch(() => null)
          ),
          settings.registerProviderIntl
        );
        const state = intlPublisher?.state;
        writeJson(
          response,
          200,
          {
            ok: true,
            registerProvider: intlSwitch.enabled,
            registerSource: intlSwitch.source,
            providerId: LLM_PROVIDER_ID_INTL,
            providerRegistered: state?.registered === true,
            ...(state?.error !== null && state?.error !== undefined ? { providerError: state.error } : {})
          },
          { "cache-control": "no-store" }
        );
        return extra;
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
        if (intlProviderStore === undefined) {
          // The row's switch file exists but the row's machinery was not
          // assembled (a misconfigured host): saving the value alone would
          // flip a switch nothing reads — report it, write nothing.
          throw new Error("the INTL row is not active on this host");
        }
        await intlProviderStore.save(body.value.enabled);
        // Republish the INTL row with its CURRENT catalogue: the switch
        // decides whether the models are offered at all, not what they are.
        // When the row's publisher is absent there is nothing to publish —
        // the save alone is the whole effect.
        if (intlPublisher !== undefined) {
          await intlPublisher.publish(
            intlPublisher.state.entries,
            intlPublisher.state.enabledIds,
            intlPublisher.state.unavailableIds ?? []
          );
        }
      } catch (error) {
        await answer({ ok: false, error: redactError(error) });
        return;
      }
      await answer();
    }
  });
}
