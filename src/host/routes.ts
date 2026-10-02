/**
 * The HTTP route handlers — the registry facade of the routes family.
 *
 * `apply()` stays the single mount seam: it assembles a `wiring` object and
 * hands it to {@link registerRoutes}; the handlers keep exactly the behaviour
 * they had inline (the trust fence, the method allowances, the body ceilings,
 * the trace writes, the publish-after-save calls). Nothing here imports a Host
 * peer — the only lazy peer loads (the adapter / tools modules) live in
 * `lifecycle.ts` and are injected from `apply` via `deps`.
 *
 * 2026-10 split (the token-store playbook: behaviour frozen first —
 * `routes.test.mjs` + `agnescode.test.mjs` + `wiring.test.mjs` ran green
 * against THIS facade, unchanged, before and after the move). The family:
 *
 *   - `routes/http.ts`         — the shared primitives (writeJson, the bounded
 *                                body reader, the fence/method refusals);
 *   - `routes/snapshot.ts`     — the polled read-only snapshot (and the
 *                                failure-code taxonomy);
 *   - `routes/account.ts`      — panel sign-in / forget, trace writes;
 *   - `routes/api-key.ts`      — the `sk-` reference, forget-and-republish;
 *   - `routes/provider.ts`     — the registration switch;
 *   - `routes/models.ts`       — the curated allow-list;
 *   - `routes/tool-switch.ts`  — ONE handler body serving draw AND video;
 *   - `routes/agnescode.ts`    — the desktop-upstream provider (switch /
 *                                harvest / logout, route-scoped state).
 *
 * The registration ORDER is load-bearing: the returned `off()` callbacks run
 * in this order on teardown. Public API and export surface are unchanged.
 *
 * @module dsh-connect-agnes-token-plan/routes
 */

import { registerSnapshotRoute } from "./routes/snapshot.ts";
import { registerAccountRoute } from "./routes/account.ts";
import { registerApiKeyRoute } from "./routes/api-key.ts";
import { registerProviderRoute } from "./routes/provider.ts";
import { registerModelsRoute } from "./routes/models.ts";
import { registerDrawRoute, registerVideoRoute } from "./routes/tool-switch.ts";
import { registerAgnescodeRoute } from "./routes/agnescode.ts";
import type { HostCtx, HostWiring } from "./types.ts";

/**
 * Register the routes on the Host's web server.
 *
 * The handlers close over `wiring` only — every service they touch is listed
 * there, so `apply()` is the single place that decides what a route can do.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {object} wiring - assembled by `apply()` in `index.ts`.
 * @param {object} wiring.settings - the resolved settings row.
 * @param {string|null} wiring.configError - a settings/auth misconfiguration
 *   surfaced through the snapshot instead of a mount crash.
 * @param {Map} wiring.cache - the console-response cache (shared across polls).
 * @param {Map} wiring.inflight - the single-flight map (shared across polls).
 * @param {object} wiring.tokenStore - the `createTokenStore` instance.
 * @param {object} wiring.apiKeyStore - the `createApiKeyStore` instance.
 * @param {object} wiring.catalogStore - the `createFileCatalogStore` instance.
 * @param {object} wiring.providerStore - the `createFileProviderStore` instance.
 * @param {object} wiring.publisher - the `createProviderPublisher` instance.
 * @param {object} wiring.providerState - `publisher.state` (shared reference).
 * @param {Function} wiring.publishProvider - (entries, enabledIds, unavailableIds) =>
 *   publisher.publish with rollback.
 * @param {{current: Function|null}} wiring.visionPublish - the settings-row
 *   writer filled by `startSideEffects` (no-op until then).
 * @param {object} wiring.drawStore - the `createFileDrawStore` instance; the
 *   draw switch route reads and writes it.
 * @param {object} wiring.videoStore - the `createFileVideoStore` instance; the
 *   video switch route reads and writes it (a SEPARATE opt-in from drawing).
 * @param {object} [wiring.logger] - `ctx.logger` (Host logging), used by the
 *   trace-write handler; optional so tests may omit it.
 * @param {object} [wiring.agnescodeStore] - the AgnesCode credential store
 *   (ROADMAP §6.3); the agnescode route reads, harvests and forgets through it.
 * @param {object} [wiring.agnescodeSwitch] - the AgnesCode panel switch.
 * @param {object} [wiring.agnescodePublisher] - the AgnesCode provider
 *   publisher (a SEPARATE provider from the main one; same route discipline).
 * @returns {Function[]} the `off()` unregister callbacks, in registration
 *   order — `teardown` runs them last.
 */
export function registerRoutes(ctx: HostCtx, wiring: HostWiring) {
  const offRoute = registerSnapshotRoute(ctx, wiring);
  const offAccount = registerAccountRoute(ctx, wiring);
  const offApiKey = registerApiKeyRoute(ctx, wiring);
  const offProvider = registerProviderRoute(ctx, wiring);
  const offModels = registerModelsRoute(ctx, wiring);
  const offDraw = registerDrawRoute(ctx, wiring);
  const offVideo = registerVideoRoute(ctx, wiring);
  const offAgnescode = registerAgnescodeRoute(ctx, wiring);
  return [offRoute, offAccount, offApiKey, offProvider, offModels, offDraw, offVideo, offAgnescode];
}
