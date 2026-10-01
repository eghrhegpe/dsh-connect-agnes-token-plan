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

import { isAdmitted, name } from "../host-config.ts";
import { writeJson, refuseOrigin, refuseMethod, readJsonBodyOr400 } from "./http.ts";

/** The inference API-key route (`sk-…`), step three of the one-stop plan. */
export const API_KEY_PATH = `/api/${name}/api-key`;

/**
 * Register the API-key route. Wiring subset: `settings`, `apiKeyStore`,
 * `catalogStore`, `cache`, `providerState`, `publishProvider`, `logger`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {object} wiring - as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerApiKeyRoute(ctx, wiring) {
  const { settings, apiKeyStore, catalogStore, cache, providerState, publishProvider, logger } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: API_KEY_PATH,
    handler: async (request, response) => {
      // Same trust fence as the other two routes: a foreign page must not be
      // able to plant or wipe an inference key.
      if (!isAdmitted(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
      const method = request.method === undefined ? "GET" : request.method;
      // The secret-free state is all the form ever gets: present or not, and
      // whether it came from the credentials service or the environment.
      const answer = async (extra = {}) =>
        writeJson(
          response,
          200,
          { ok: true, ...(await apiKeyStore.state().catch(() => ({
            hasApiKey: false,
            keySource: null,
            ephemeral: false
          }))), ...extra },
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
      // Forget: drop the panel-saved REFERENCE only. An environment value is
      // deliberately left standing (forget cannot delete an operator's .env),
      // and the cached catalog answers the old key until the poll after.
      if (body.value.forget === true) {
        try {
          await apiKeyStore.forget();
          // The key itself is already gone; a leftover cached catalog would only
          // surface stale models on the next poll. If the clear fails we still
          // answer success, but record it — silently losing it would make a
          // "forgot the key but old models still offered" report undebuggable.
          await catalogStore.clear()
            .catch((error) => logger?.warn?.(`${name}: catalog cache clear failed after api-key forget`, error));
          cache.clear();
          providerState.signature = "";
          providerState.quotaSignature = "";
          await publishProvider([], [], []);
          await answer();
        } catch (error) {
          await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      try {
        await apiKeyStore.save(body.value.apiKey);
      } catch (error) {
        await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      // The next poll fetches the catalog with the new key; a stale catalog
      // cached under a previous key must not survive it. The key itself is
      // resolved per REQUEST by the adapter, so no provider rebuild is needed.
      cache.clear();
      await answer();
    }
  });
}
