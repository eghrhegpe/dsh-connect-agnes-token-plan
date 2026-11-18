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
import { writeJson, refuseOrigin, refuseMethod, requestMethod, readJsonBodyOr400 } from "./http.ts";
import type { HostCtx, HostWiring } from "../types.ts";
import type { createTokenStore } from "../token-store.ts";

/** The account route: the panel configures itself without editing `.env`. */
export const ACCOUNT_PATH = `/api/${name}/account`;

/**
 * Which site's console account the body addresses (ADR-021). The CN store is
 * the default; `site: "intl"` switches every action in the body to the INTL
 * row's own store — its own grant record, its own references, its own trace
 * label — so one panel can carry both of the operator's accounts without the
 * two sites' credentials ever touching the same record.
 * @param {unknown} value - the posted body value.
 * @returns {"cn"|"intl"}
 */
function accountSite(value: unknown): "cn" | "intl" {
  return (value as { site?: unknown })?.site === "intl" ? "intl" : "cn";
}

/**
 * Register the account route. Wiring subset: `settings`, `cache`, `tokenStore`,
 * and the INTL row's `intlTokenStore` (ADR-021, optional: a Host that did not
 * assemble it answers INTL actions with `intl_inactive` and writes nothing).
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {object} wiring - as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerAccountRoute(ctx: HostCtx, wiring: HostWiring) {
  const { settings, cache, tokenStore, logger } = wiring;

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
      const method = requestMethod(request, "POST");
      if (method === "GET") {
        // The form needs to know whether an account is already stored, and
        // must never be told the password.
        //
        // A state read that rejects degrades to `{}` rather than failing the
        // route: the form's whole question here is "is an account stored", and
        // an error page answers it with nothing at all.
        //
        // The INTL half rides alongside under `intl` (ADR-021): the panel's
        // INTL form reads its own state, and a Host without the INTL row
        // omits the field entirely.
        const intlState = wiring.intlTokenStore === undefined
          ? null
          : await wiring.intlTokenStore.state().catch(() => null);
        writeJson(response, 200, {
          ok: true,
          ...(await tokenStore.state().catch(() => null)),
          ...(intlState !== null ? { intl: intlState } : {})
        }, { "cache-control": "no-store" });
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // The site this action addresses, and the store that answers it. An
      // INTL action on a Host that did not assemble the INTL row is a
      // DECLINED action, not a write: the panel tells the reader the row is
      // inactive instead of planting an account nobody will ever read.
      const site = accountSite(body.value);
      const activeStore: ReturnType<typeof createTokenStore> | undefined =
        site === "intl" ? wiring.intlTokenStore : tokenStore;
      if (activeStore === undefined) {
        writeJson(response, 200, {
          ok: false,
          code: CODE.INTL_INACTIVE,
          error: "the INTL row is not active on this host"
        }, { "cache-control": "no-store" });
        return;
      }
      // `forget: true` clears the account without logging in again; the grant
      // survives on its refresh token until it needs the password again.
      // Each site's forget touches ONLY its own references and record
      // (ADR-021): clearing the INTL account must never sweep the CN one.
      if (body.value.forget === true) {
        try {
          await activeStore.forgetAccount();
        } catch (error) {
          // The state is spread FIRST: it carries its own `error` field, and
          // spreading it after this one would overwrite the real reason with
          // whatever the store last saw.
          writeJson(response, 200, {
            ...(await activeStore.state().catch(() => null)),
            ok: false,
            error: redactError(error)
          }, { "cache-control": "no-store" });
          return;
        }
        // The grant that just cleared answers the very next poll, so the cached
        // console responses from the previous account must not survive it.
        // (saveAccount does the same on its success path.) The cache keys its
        // entries on the URL, so the shared map's one `clear()` serves both
        // sites without one site's entries surviving for the other.
        cache.clear();
        writeJson(response, 200, { ...(await activeStore.state().catch(() => null)), ok: true }, { "cache-control": "no-store" });
        return;
      }
      try {
        // The raw values are passed through WITHOUT String(): a missing or
        // non-string field keeps its original shape through the store's
        // local guard (empty/missing → a local refusal, zero network), which
        // turns a malformed POST into a clean ok:false instead of writing
        // the literal "undefined" into the account reference and triggering a
        // useless real login. A panel always sends strings, so this only
        // guards third-party/malformed POSTs.
        await activeStore.saveAccount({ username: body.value.username, password: body.value.password });
        // The success trace is persisted through `onTrace` (the INTL store's
        // own labelled trace writer, ADR-021); no path is owed to the panel
        // for a sign-in that worked.
      } catch (error) {
        // A rejected password is the common case, and it is the user's to
        // correct: report the reason and leave the panel usable.
        const failure = error as { code?: unknown; trace?: object[]; detail?: unknown; retryAfterMs?: number };
        // A logger is handed in so a trace that could not be written says so
        // instead of returning a `null` nobody inspects (see `trace.ts`).
        const traceFile = await writeLoginTrace(failure?.trace, str(failure?.code, CODE.AUTH_ERROR), { logger });
        writeJson(response, 200, {
          ...(await activeStore.state().catch(() => null)),
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
      writeJson(response, 200, { ...(await activeStore.state().catch(() => null)), ok: true }, { "cache-control": "no-store" });
    }
  });
}
