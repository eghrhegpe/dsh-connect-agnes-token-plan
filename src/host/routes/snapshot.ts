/**
 * The snapshot route — the one read-only route the Client panel polls.
 *
 * Part of the routes split (see `../routes.ts` for the family map). The
 * aggregation itself lives in `snapshot-aggregate.ts`; this module is the
 * HTTP edge: the trust fence, the config-error short-circuit, the vision
 * write-back, and the last-resort `ok:false` shape with its code taxonomy.
 *
 * @module dsh-connect-agnes-token-plan/routes/snapshot
 */

import { isAdmitted, name } from "../host-config.ts";
import { buildSnapshotBody } from "../snapshot-aggregate.ts";
import { CODE, isAuthFailure } from "../codes.ts";
import { redactError } from "../util.ts";
import { writeJson, refuseOrigin, refuseMethod } from "./http.ts";
import type { HostCtx, HostWiring } from "../types.ts";

/** The one read-only route the Client panel polls. */
export const SNAPSHOT_PATH = `/api/${name}/snapshot`;

/**
 * Map a thrown console/auth error to the one code the panel branches on.
 *
 * A raw error message carries no intent, so the panel keys its guidance off
 * this taxonomy instead: `not_configured` (the user can fix it) and
 * `jwt_expired` (renewal already failed) pass through verbatim because the
 * panel words them differently from every other case; an auth-shaped failure
 * becomes `auth_error`; anything else is a console failure, which usually
 * self-heals on the next poll.
 * @param {unknown} error - the error a fetch or parse threw.
 * @returns {string} the panel-facing code.
 */
function failureCode(error) {
  const code = error && typeof error === "object" ? /** @type {{code?: string}} */ (error).code : undefined;
  if (code === CODE.NOT_CONFIGURED || code === CODE.JWT_EXPIRED) return code;
  return isAuthFailure(error) ? CODE.AUTH_ERROR : CODE.CONSOLE_ERROR;
}

/**
 * Register the snapshot route. Wiring subset: `settings`, `configError`,
 * `cache`, `inflight`, `tokenStore`, `apiKeyStore`, `publisher`,
 * `catalogStore`, `providerStore`, `drawStore`, `videoStore`,
 * `visionPublish`, `logger`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {object} wiring - as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerSnapshotRoute(ctx: HostCtx, wiring: HostWiring) {
  const { settings, configError, cache, inflight, tokenStore, apiKeyStore, catalogStore, providerStore, drawStore, videoStore, publisher, visionPublish, logger } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: SNAPSHOT_PATH,
    handler: async (request, response) => {
      if (!isAdmitted(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
      if (request.method !== undefined && request.method !== "GET" && request.method !== "HEAD") {
        refuseMethod(response);
        return;
      }
      if (configError !== null) {
        // The panel maps this code to its own line, so the operator sees the
        // misconfiguration instead of a generic network failure.
        writeJson(response, 200, {
          ok: false,
          code: CODE.CONFIG_ERROR,
          error: configError,
          auth: await tokenStore.state().catch(() => null)
        }, { "cache-control": "no-store" });
        return;
      }
      try {
        // Step two (vision, ARCHITECTURE.md §5.1): publish the computed list to
        // this row's own settings namespace so a later LLM connect plugin can
        // read it. The aggregate needs to know the vision list before it builds
        // the body (it carries `visionModels`), so the caller computes it up
        // front and hands it in.
        const body = await buildSnapshotBody({
          settings,
          cache,
          inflight,
          tokenStore,
          apiKeyStore,
          publisher,
          catalogStore,
          panelSwitch: () => providerStore.enabled().catch(() => null),
          drawSwitch: async () => (drawStore ? await drawStore.enabled().catch(() => null) : null),
          drawModelId: async () => (drawStore ? await drawStore.modelId().catch(() => null) : null),
          videoSwitch: async () => (videoStore ? await videoStore.enabled().catch(() => null) : null),
          videoModelId: async () => (videoStore ? await videoStore.modelId().catch(() => null) : null)
        });
        if (body.visionModels !== undefined) {
          // A write failure here is silent otherwise: the vision list fails to
          // persist to this row's settings, so the later image-routing plugin
          // reads a stale or empty set with no trace to explain why. Log it; the
          // in-memory body the panel already got is unaffected.
          void visionPublish.current?.(body.visionModels, body.visionModels.map((entry) => entry.id))
            .catch((error) => {
              // The value is a best-effort write, and its error provably carries
              // no credential today — but this is still a LOG EXIT, so it goes
              // through the same redaction the panel does (util.ts: a credential
              // never reaches a log). A future change to what this publish
              // throws cannot regress that.
              logger?.warn?.(`${name}: vision model list write failed: ${redactError(error)}`);
            });
        }
        writeJson(response, 200, body, { "cache-control": "no-store" });
      } catch (error) {
        // The LAST-RESORT path, and a narrow one: `buildSnapshotBody` degrades
        // every console source on its own, so a signed-out console or a dead
        // token answers `ok:true` with `quota.consoleConnected:false` and never
        // reaches here. What does is a failure outside that set — a store read,
        // a catalogue write, a provider publish, `tokenStore.state()` itself.
        // The shape stays `ok:false` because the panel still reads it as "no
        // numbers this time"; `failureCode` keeps `not_configured` /
        // `jwt_expired` distinguishable from a plain console error so the
        // guidance line still names the right fix.
        writeJson(response, 200, {
          ok: false,
          // Red line: the route is one of the three places an error message
          // must pass `redactSecrets`. What reaches here is usually a store or
          // publish failure, but the console client's own refusals ride this
          // path and must not echo a credential back to the panel.
          error: redactError(error),
          code: failureCode(error),
          auth: await tokenStore.state().catch(() => null)
        }, { "cache-control": "no-store" });
      }
    }
  });
}
