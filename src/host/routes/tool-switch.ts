/**
 * The live tool-switch routes — the draw and video toggles.
 *
 * Part of the routes split (see `../routes.ts` for the family map). Both
 * routes perform the same four operations in the same order — report the
 * effective value, forget the saved one, save a model preference, save the
 * boolean — and differ only in which store and which settings keys they name.
 * Writing them ONCE is what keeps the two switches from drifting into
 * behaving differently: a panel able to enable video but not disable drawing
 * would be a bug with no visible cause.
 *
 * @module dsh-connect-agnes-token-plan/routes/tool-switch
 */

import { name } from "../host-config.ts";
import { isAdmittedWithAudit } from "../admission-audit.ts";
import { writeJson, refuseOrigin, refuseMethod, readJsonBodyOr400 } from "./http.ts";

/** The draw-tool switch route (docs/PROVIDER-HOT-RELOAD.md, same discipline). */
export const DRAW_PATH = `/api/${name}/draw`;

/** The video-tool switch route (same discipline, its own store and opt-in). */
export const VIDEO_PATH = `/api/${name}/video`;

/**
 * Register one live tool-switch route (the draw and video switches).
 *
 * Both routes perform the same four operations in the same order — report the
 * effective value, forget the saved one, save a model preference, save the
 * boolean — and differ only in which store and which settings keys they name.
 * Writing them ONCE is what keeps the two switches from drifting into
 * behaving differently: a panel able to enable video but not disable drawing
 * would be a bug with no visible cause.
 *
 * Three purposes are distinguished by the POST body, the same shape the
 * account and api-key routes use: a saved boolean, a saved model preference
 * (`null` = auto), or a forget that returns the saved values to the config
 * default.
 * @param ctx - the host root context.
 * @param {object} options - wiring.
 * @param {string} options.path - the exact route path.
 * @param {string} options.label - the noun used in "… store is unavailable" (`draw` / `video`).
 * @param {object} [options.store] - the switch store (absent = every write refuses).
 * @param {string} options.enabledKey - the response key carrying the boolean.
 * @param {string} options.enabledSourceKey - the response key carrying its source.
 * @param {boolean} options.configEnabled - the config default for the boolean.
 * @param {string} options.modelKey - the response key carrying the model id.
 * @param {string} options.modelSourceKey - the response key carrying its source.
 * @param {string} options.configModelId - the config default for the model id.
 * @param {Set<string>} options.allowedHosts - the trust fence.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerToolSwitchRoute(ctx, { path, label, store, enabledKey, enabledSourceKey, configEnabled, modelKey, modelSourceKey, configModelId, allowedHosts }) {
  return ctx.webServer.register({
    kind: "exact",
    path,
    handler: async (request, response) => {
      // Same trust fence as the other routes: a foreign page must not be able
      // to turn an agent tool on or off.
      if (!isAdmittedWithAudit(request, allowedHosts)) {
        refuseOrigin(response);
        return;
      }
      const method = request.method === undefined ? "GET" : request.method;
      const answer = async (extra = {}) => {
        const panelEnabled = await (store ? store.enabled() : null).catch(() => null);
        const panelModel = await (store ? store.modelId() : null).catch(() => null);
        // The effective value: a saved panel value always wins, otherwise the
        // config default. The source tells the panel which side is in charge.
        writeJson(
          response,
          200,
          {
            ok: true,
            [enabledKey]: (panelEnabled ?? configEnabled) === true,
            [enabledSourceKey]: panelEnabled === null ? "config" : "panel",
            [modelKey]: panelModel ?? configModelId,
            [modelSourceKey]: panelModel === null ? "config" : "panel",
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
      if (body.value.forget === true) {
        if (!store) {
          await answer({ ok: false, error: `${label} store is unavailable` });
          return;
        }
        try {
          await store.forget();
        } catch (error) {
          await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        await answer();
        return;
      }
      if (body.value[modelKey] !== undefined) {
        const raw = body.value[modelKey];
        if (raw !== null && (typeof raw !== "string" || raw.trim() === "")) {
          writeJson(response, 400, { ok: false, error: `${modelKey} expects a non-empty string or null` }, { "cache-control": "no-store" });
          return;
        }
        if (!store) {
          await answer({ ok: false, error: `${label} store is unavailable` });
          return;
        }
        try {
          await store.saveModel(raw);
        } catch (error) {
          await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        await answer();
        return;
      }
      if (typeof body.value.enabled !== "boolean") {
        writeJson(response, 400, { ok: false, error: `expected { enabled: boolean }, { ${modelKey} }, or { forget: true }` }, { "cache-control": "no-store" });
        return;
      }
      if (!store) {
        await answer({ ok: false, error: `${label} store is unavailable` });
        return;
      }
      try {
        await store.save(body.value.enabled);
      } catch (error) {
        await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      await answer();
    }
  });
}

/**
 * Register the draw switch route. Wiring subset: `settings`, `drawStore`.
 * @param ctx - the host root context.
 * @param {object} wiring - as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerDrawRoute(ctx, wiring) {
  const { settings, drawStore } = wiring;
  return registerToolSwitchRoute(ctx, {
    path: DRAW_PATH,
    label: "draw",
    store: drawStore,
    enabledKey: "drawEnabled",
    enabledSourceKey: "drawSource",
    configEnabled: settings.drawEnabled,
    modelKey: "drawModelId",
    modelSourceKey: "drawModelSource",
    configModelId: settings.drawModelId,
    allowedHosts: settings.allowedHosts
  });
}

/**
 * Register the video switch route. Wiring subset: `settings`, `videoStore`.
 * @param ctx - the host root context.
 * @param {object} wiring - as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerVideoRoute(ctx, wiring) {
  const { settings, videoStore } = wiring;
  return registerToolSwitchRoute(ctx, {
    path: VIDEO_PATH,
    label: "video",
    store: videoStore,
    enabledKey: "videoEnabled",
    enabledSourceKey: "videoSource",
    configEnabled: settings.videoEnabled,
    modelKey: "videoModelId",
    modelSourceKey: "videoModelSource",
    configModelId: settings.videoModelId,
    allowedHosts: settings.allowedHosts
  });
}
