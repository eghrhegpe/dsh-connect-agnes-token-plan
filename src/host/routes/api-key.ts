/**
 * The inference API-key route (`sk-…`) — step three of the one-stop plan.
 *
 * Part of the routes split (see `../routes.ts` for the family map). The
 * secret-free discipline holds at this edge: every answer carries
 * `apiKeyStore.state()` (present or not, which source), never the key; a
 * forget drops the REFERENCE and every cached answer that was fetched with
 * the old key, then publishes the empty offer.
 *
 * @module dsh-connect-agnes-token-plan/routes/api-key
 */

import { name } from "../host-config.ts";
import { isAdmittedWithAudit } from "../admission-audit.ts";
import { redactError } from "../util.ts";
import { writeJson, refuseOrigin, refuseMethod, requestMethod, readJsonBodyOr400 } from "./http.ts";
import type { HostCtx, HostWiring } from "../types.ts";

/** The inference API-key route (`sk-…`), step three of the one-stop plan. */
export const API_KEY_PATH = `/api/${name}/api-key`;

/**
 * The site a key action addresses (ADR-021): the CN reference by default,
 * the INTL one when the body names it. The two references never cross — the
 * account systems do not interoperate, so a CN key offered to the INTL
 * gateway is a guaranteed 401, exactly the accident the split exists for.
 * @param {unknown} value - the posted body value.
 * @returns {"cn"|"intl"}
 */
function keySite(value: unknown): "cn" | "intl" {
  return (value as { site?: unknown })?.site === "intl" ? "intl" : "cn";
}

/**
 * Register the API-key route. Wiring subset: `settings`, `apiKeyStore`,
 * `catalogStore`, `cache`, `providerState`, `publishProvider`, `logger`,
 * and the INTL row's pair (`intlApiKeyStore` / `intlCatalogStore` /
 * `intlPublisher`, ADR-021 — all optional; absent means the INTL half of
 * the route answers "row not active" and touches nothing).
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {object} wiring - as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerApiKeyRoute(ctx: HostCtx, wiring: HostWiring) {
  const { settings, apiKeyStore, catalogStore, cache, providerState, publishProvider, logger } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: API_KEY_PATH,
    handler: async (request, response) => {
      // Same trust fence as every write route: a foreign page must not be
      // able to plant or wipe an inference key.
      if (!isAdmittedWithAudit(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
      const method = requestMethod(request, "GET");
      const NO_KEY_STATE = { hasApiKey: false, keySource: null, ephemeral: false };
      // The secret-free state is all the form ever gets: present or not, and
      // whether it came from the credentials service or the environment.
      // The INTL reference's state rides alongside under `intl` (ADR-021):
      // the panel's two key editors each read their own half, and a Host
      // that has no INTL row omits the field entirely.
      const intlKeyState = wiring.intlApiKeyStore === undefined
        ? null
        : await wiring.intlApiKeyStore.state().catch(() => ({
            hasApiKey: false,
            keySource: null,
            ephemeral: false
          }));
      const answer = async (extra = {}) =>
        writeJson(
          response,
          200,
          {
            ok: true,
            ...(await apiKeyStore.state().catch(() => ({ ...NO_KEY_STATE }))),
            ...(intlKeyState !== null ? { intl: intlKeyState } : {}),
            ...extra
          },
          { "cache-control": "no-store" }
        );
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
      // Which reference this action addresses. The INTL half degrades to a
      // plain refusal (not a write) when the Host did not assemble the row:
      // saving a key for a row that cannot use it would be a lie the panel
      // could not explain.
      const site = keySite(body.value);
      if (site === "intl" && (wiring.intlApiKeyStore === undefined || wiring.intlCatalogStore === undefined)) {
        await answer({ ok: false, error: "the INTL row is not active on this host", code: "intl_inactive" });
        return;
      }
      const activeKeyStore = site === "intl" ? wiring.intlApiKeyStore! : apiKeyStore;
      const activeCatalogStore = site === "intl" ? wiring.intlCatalogStore! : catalogStore;
      // Forget: drop the panel-saved REFERENCE only. An environment value is
      // deliberately left standing (forget cannot delete an operator's .env),
      // and the cached catalog answers the old key until the poll after.
      if (body.value.forget === true) {
        try {
          await activeKeyStore.forget();
          // The key itself is already gone; a leftover cached catalog would only
          // surface stale models on the next poll. `clear()` REPORTS rather than
          // rejects (a failure must not fail the forget the user asked for), so
          // the warning is on the returned flag — it used to hang off a
          // `.catch()` that could never run, which made a "forgot the key but
          // old models still offered" report undebuggable in exactly the way
          // this comment says it must not be (PITFALLS §42).
          const cleared = await activeCatalogStore.clear().catch(() => false);
          if (cleared === false) {
            // A LOG EXIT: the redaction the panel applies to error text applies
            // here too, so a credential can never reach a log line even if the
            // clear path starts throwing one (util.ts).
            logger?.warn?.(`${name}: catalog cache clear failed after api-key forget${site === "intl" ? " (INTL row)" : ""}; the next poll may still offer the old models`);
          }
          cache.clear();
          // The CN row's signature + publish: forgetting the INTL key must
          // not reset the CN row's registration (ADR-021: the two rows share
          // nothing mutable, and this was the seam that would have coupled
          // them). Each row clears its own signature and republishes itself.
          if (site === "cn") {
            providerState.signature = "";
            providerState.quotaSignature = "";
            await publishProvider([], [], []);
          } else {
            const intlState = wiring.intlPublisher?.state;
            if (intlState !== undefined) {
              intlState.signature = "";
              intlState.quotaSignature = "";
            }
            if (wiring.intlPublisher !== undefined) {
              await wiring.intlPublisher.publish([], [], []);
            }
          }
          await answer();
        } catch (error) {
          await answer({ ok: false, error: redactError(error) });
        }
        return;
      }
      try {
        await activeKeyStore.save(String(body.value.apiKey));
      } catch (error) {
        await answer({ ok: false, error: redactError(error) });
        return;
      }
      // The next poll fetches the catalog with the new key; a stale catalog
      // cached under a previous key must not survive it. The key itself is
      // resolved per REQUEST by the adapter, so no provider rebuild is needed.
      // (The cache is shared across the two rows — every entry keys on its
      // own URL, and the two rows' bases differ, so a clear stays a clear.)
      cache.clear();
      await answer();
    }
  });
}
