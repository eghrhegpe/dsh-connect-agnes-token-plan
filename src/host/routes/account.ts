/**
 * The account route: the panel configures itself without editing `.env`.
 *
 * Part of the routes split (see `../routes.ts` for the family map). The
 * credential red lines live here in their HTTP form: the GET and every error
 * answer carry `tokenStore.state()` — shape facts only, never the password;
 * a rejected login persists the sanitized trace and reports the platform's
 * own words plus any `retryAfterMs` window so the panel can grey the form out
 * instead of letting the user knock an account into lockout.
 *
 * @module dsh-connect-agnes-token-plan/routes/account
 */

import { name } from "../host-config.ts";
import { isAdmittedWithAudit } from "../admission-audit.ts";
import { CODE } from "../codes.ts";
import { writeLoginTrace } from "../trace.ts";
import { redactError, redactSecrets, str } from "../util.ts";
import { writeJson, refuseOrigin, refuseMethod, readJsonBodyOr400 } from "./http.ts";
import type { HostCtx, HostWiring } from "../types.ts";

/** The account route: the panel configures itself without editing `.env`. */
export const ACCOUNT_PATH = `/api/${name}/account`;

/**
 * Register the account route. Wiring subset: `settings`, `cache`, `tokenStore`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {object} wiring - as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerAccountRoute(ctx: HostCtx, wiring: HostWiring) {
  const { settings, cache, tokenStore } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: ACCOUNT_PATH,
    handler: async (request, response) => {
      // The same fence as the snapshot route: without it, any page the
      // browser visits could post an account into this panel.
      if (!isAdmittedWithAudit(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
      const method = request.method === undefined ? "POST" : request.method;
      if (method === "GET") {
        // The form needs to know whether an account is already stored, and
        // must never be told the password.
        writeJson(response, 200, { ok: true, ...(await tokenStore.state()) }, { "cache-control": "no-store" });
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // `forget: true` clears the account without logging in again; the grant
      // survives on its refresh token until it needs the password again.
      if (body.value.forget === true) {
        try {
          await tokenStore.forgetAccount();
        } catch (error) {
          // The state is spread FIRST: it carries its own `error` field, and
          // spreading it after this one would overwrite the real reason with
          // whatever the store last saw.
          writeJson(response, 200, {
            ...(await tokenStore.state().catch(() => null)),
            ok: false,
            error: redactError(error)
          }, { "cache-control": "no-store" });
          return;
        }
        // The grant that just cleared answers the very next poll, so the cached
        // console responses from the previous account must not survive it.
        // (saveAccount does the same on its success path.)
        cache.clear();
        writeJson(response, 200, { ...(await tokenStore.state()), ok: true }, { "cache-control": "no-store" });
        return;
      }
      try {
        await tokenStore.saveAccount({ username: body.value.username, password: body.value.password });
        // The success trace is persisted through `onTrace`; no path is owed
        // to the panel for a sign-in that worked.
      } catch (error) {
        // A rejected password is the common case, and it is the user's to
        // correct: report the reason and leave the panel usable.
        const failure = error as { code?: unknown; trace?: object[]; detail?: unknown; retryAfterMs?: number };
        const traceFile = await writeLoginTrace(failure?.trace, str(failure?.code, CODE.AUTH_ERROR));
        writeJson(response, 200, {
          ...(await tokenStore.state().catch(() => null)),
          ok: false,
          code: str(failure?.code, CODE.AUTH_ERROR),
          error: redactError(error),
          // The platform's own words ride along so the panel can show them
          // beneath the classified line.
          ...(failure?.detail === undefined ? {} : { detail: redactSecrets(String(failure.detail)) }),
          // The sanitized hop-by-hop record of this attempt: the panel links
          // to it, and a support question becomes answerable.
          ...(traceFile !== null ? { traceFile } : {}),
          // When the platform names a wait, the panel greys the form out for
          // that long: retrying inside the window is what extends a lockout.
          ...(typeof failure?.retryAfterMs === "number" ? { retryAfterMs: failure.retryAfterMs } : {})
        }, { "cache-control": "no-store" });
        return;
      }
      // The grant that just landed answers the very next poll, so the cached
      // console responses from the previous account must not survive it.
      cache.clear();
      writeJson(response, 200, { ...(await tokenStore.state()), ok: true }, { "cache-control": "no-store" });
    }
  });
}
