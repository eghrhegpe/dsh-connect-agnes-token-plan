/**
 * The HTTP route handlers.
 *
 * `apply()` stays the single mount seam: it assembles a `wiring` object and
 * hands it to {@link registerRoutes}; the handlers keep exactly the behaviour
 * they had inline (the trust fence, the method allowances, the body ceilings,
 * the trace writes, the publish-after-save calls). Nothing here imports a Host
 * peer — the only lazy peer loads (the adapter / tools modules) live in
 * `lifecycle.ts` and are injected from `apply` via `deps`.
 *
 * @module dsh-connect-agnes-token-plan/routes
 */
import { isAdmitted, name } from "./host-config.ts";
import { buildSnapshotBody } from "./snapshot-aggregate.ts";
import { CODE, isAuthFailure } from "./codes.ts";
import { writeLoginTrace } from "./trace.ts";
import { str, redactSecrets } from "./util.ts";
import { normalizeEnabledIds } from "./catalog-store.ts";
import { catalogSignature } from "./provider-publish.ts";
import {
  fetchAgnescodeCatalog,
  fetchAgnescodeBalance,
  harvestAgnescodeLocalSession,
  decodeAgnescodeJwtExpMs,
  AGNESCODE_FALLBACK_MODELS
} from "./agnescode.ts";

/** The one read-only route the Client panel polls. */
const SNAPSHOT_PATH = `/api/${name}/snapshot`;
/** The account route: the panel configures itself without editing `.env`. */
const ACCOUNT_PATH = `/api/${name}/account`;
/** The inference API-key route (`sk-…`), step three of the one-stop plan. */
const API_KEY_PATH = `/api/${name}/api-key`;
/** The provider-registration switch route (docs/PROVIDER-HOT-RELOAD.md). */
const PROVIDER_PATH = `/api/${name}/provider`;
/** The model-roster route (docs/API.md). */
const MODELS_PATH = `/api/${name}/models`;
/** The draw-tool switch route (docs/PROVIDER-HOT-RELOAD.md, same discipline). */
const DRAW_PATH = `/api/${name}/draw`;
/** The video-tool switch route (same discipline, its own store and opt-in). */
const VIDEO_PATH = `/api/${name}/video`;
/** The AgnesCode provider route (ROADMAP §6.3 "third upstream provider"). */
const AGNESCODE_PATH = `/api/${name}/agnescode`;
/** Ceiling on an AgnesCode action body: every action posts a bare `{action}`. */
const MAX_AGNESCODE_BODY_BYTES = 2048;
/** The GET self-heal publishes at most once per this window (see the GET branch). */
const AGNESCODE_SELF_HEAL_COOLDOWN_MS = 60_000;
/** Ceiling on a submitted account, so a hostile page cannot stream a body. */
const MAX_ACCOUNT_BODY_BYTES = 4096;
/** Ceiling on the curated allow-list: a catalogue this large is a posting accident. */
const MAX_ENABLED_MODEL_IDS = 500;
/** Family default response headers for a JSON route. */
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer"
};

/** Write one JSON response with the family headers. */
function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(payload);
}

/**
 * Read a small JSON request body, refusing anything oversized.
 *
 * The account form is the only thing that posts here, so the ceiling is tiny
 * and the reader is deliberately dull: no content-type negotiation, no
 * streaming, just a bounded collect and a parse.
 * @param request - the incoming HTTP request.
 * @param limit - the byte ceiling.
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: string}>}
 */
async function readJsonBody(request, limit = MAX_ACCOUNT_BODY_BYTES) {
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.byteLength;
      if (received > limit) return { ok: false, error: "request body is too large" };
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, error: "could not read the request body" };
  }
  if (chunks.length === 0) return { ok: false, error: "a JSON body is required" };
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "the body must be a JSON object" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: "the body is not valid JSON" };
  }
}

/**
 * Refuse a request the trust fence rejects, with the one body the panel reads.
 *
 * Every route opens with the identical line, so the wording and the 403 shape
 * live in one place: a route that forgets the fence, or words it differently,
 * is now the odd one out rather than a second truth.
 * @param response - the outgoing HTTP response.
 * @returns {void}
 */
function refuseOrigin(response) {
  writeJson(response, 403, { ok: false, error: "forbidden: origin mismatch" });
}

/**
 * Refuse a disallowed method with the family's 405 shape.
 *
 * The 405 carries no `cache-control`: unlike a snapshot, a method refusal is
 * not a fresh answer anyone would want to keep, so there is nothing to tell a
 * cache not to store.
 * @param response - the outgoing HTTP response.
 * @returns {void}
 */
function refuseMethod(response) {
  writeJson(response, 405, { ok: false, error: "method not allowed" });
}

/**
 * Read and validate a JSON body, or answer 400 and signal the caller to stop.
 *
 * Collapses the "read body -> not ok ? write 400 and return" block every POST
 * route repeats. Returns the `readJsonBody` result on success (so callers keep
 * reading the parsed object through `body.value`, exactly as before), or `null`
 * after it has already written the 400 — a `null` is the caller's cue to return.
 * @param request - the incoming HTTP request.
 * @param response - the outgoing HTTP response (written on failure).
 * @returns {Promise<object|null>} the read result, or null if a 400 was sent.
 */
async function readJsonBodyOr400(request, response) {
  const body = await readJsonBody(request);
  if (!body.ok) {
    writeJson(response, 400, { ok: false, error: /** @type {{ok: false, error: string}} */ (body).error }, { "cache-control": "no-store" });
    return null;
  }
  return body;
}

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
function registerToolSwitchRoute(ctx, { path, label, store, enabledKey, enabledSourceKey, configEnabled, modelKey, modelSourceKey, configModelId, allowedHosts }) {
  return ctx.webServer.register({
    kind: "exact",
    path,
    handler: async (request, response) => {
      // Same trust fence as the other routes: a foreign page must not be able
      // to turn an agent tool on or off.
      if (!isAdmitted(request, allowedHosts)) {
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
 * Register the seven routes on the Host's web server.
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
 * @returns {Function[]} the eight `off()` unregister callbacks, in registration
 *   order — `teardown` runs them last.
 */
export function registerRoutes(ctx, wiring) {
  const { settings, configError, cache, inflight, tokenStore, apiKeyStore, catalogStore, providerStore, drawStore, videoStore, publisher, providerState, publishProvider, visionPublish, logger, agnescodeStore, agnescodeSwitch, agnescodePublisher } = wiring;

  const offRoute = ctx.webServer.register({
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
          drawSwitch: () => (drawStore ? drawStore.enabled().catch(() => null) : null),
          drawModelId: () => (drawStore ? drawStore.modelId().catch(() => null) : null),
          videoSwitch: () => (videoStore ? videoStore.enabled().catch(() => null) : null),
          videoModelId: () => (videoStore ? videoStore.modelId().catch(() => null) : null)
        });
        if (body.visionModels !== undefined) {
          // A write failure here is silent otherwise: the vision list fails to
          // persist to this row's settings, so the later image-routing plugin
          // reads a stale or empty set with no trace to explain why. Log it; the
          // in-memory body the panel already got is unaffected.
          void visionPublish.current?.(body.visionModels, body.visionModels.map((entry) => entry.id))
            .catch((error) => logger?.warn?.(`${name}: vision model list write failed`, error));
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
          error: error instanceof Error ? error.message : String(error),
          code: failureCode(error),
          auth: await tokenStore.state().catch(() => null)
        }, { "cache-control": "no-store" });
      }
    }
  });

  const offAccount = ctx.webServer.register({
    kind: "exact",
    path: ACCOUNT_PATH,
    handler: async (request, response) => {
      // The same fence as the snapshot route: without it, any page the
      // browser visits could post an account into this panel.
      if (!isAdmitted(request, settings.allowedHosts)) {
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
            error: error instanceof Error ? error.message : String(error)
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
        const failure = error as { code?: unknown; trace?: unknown; detail?: unknown; retryAfterMs?: number };
        const traceFile = await writeLoginTrace(failure?.trace, str(failure?.code, CODE.AUTH_ERROR));
        writeJson(response, 200, {
          ...(await tokenStore.state().catch(() => null)),
          ok: false,
          code: str(failure?.code, CODE.AUTH_ERROR),
          error: error instanceof Error ? error.message : String(error),
          // The platform's own words ride along so the panel can show them
          // beneath the classified line.
          ...(failure?.detail === undefined ? {} : { detail: String(failure.detail) }),
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

  const offApiKey = ctx.webServer.register({
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

  const offProvider = ctx.webServer.register({
    kind: "exact",
    path: PROVIDER_PATH,
    handler: async (request, response) => {
      // Same trust fence as the other three routes: a foreign page must not be
      // able to flip model routing for the whole Host.
      if (!isAdmitted(request, settings.allowedHosts)) {
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

  const offModels = ctx.webServer.register({
    kind: "exact",
    path: MODELS_PATH,
    handler: async (request, response) => {
      // Same fence as the other routes: a foreign page must not be able to
      // decide which models this Host offers.
      if (!isAdmitted(request, settings.allowedHosts)) {
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
          registerProvider:
            ((await providerStore.enabled().catch(() => null)) ?? settings.registerProvider) === true,
          providerRegistered: providerState.registered,
          ...(providerState.error !== null ? { providerError: providerState.error } : {}),
          ...extra
        }, { "cache-control": "no-store" });
      };
      try {
        await catalogStore.setEnabledIds(ids);
        // The next poll must not re-publish the same offer: adopt the signature
        // of what was just offered, or every poll would churn the registration.
        providerState.signature = catalogSignature(providerState.entries, ids);
        // Publish immediately with the CURRENT catalogue: the offer must not
        // wait for the next poll. A failed publish rolls back to the previous
        // pair inside publishProvider and surfaces its reason.
        await publishProvider(providerState.entries, ids, providerState.unavailableIds ?? []);
      } catch (error) {
        await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      await answer();
    }
  });

  const offDraw = registerToolSwitchRoute(ctx, {
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

  const offVideo = registerToolSwitchRoute(ctx, {
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

  // ── The AgnesCode route: the desktop-app upstream provider (ROADMAP §6.3) ──
  // The credential is HARVESTED from the desktop App's os_crypt session file
  // (the user logs in THERE, WeChat-side), so the login-equivalent action is
  // 「检测本机登录态」— a harvest-then-save walk whose failure mode is the
  // per-file diagnosis list the tab renders.
  //
  // The last walk's rows and the in-flight walk live at the ROUTE scope, not
  // per request. Two reasons, and the first one is a bug that shipped:
  //   * per-request `let lastHarvest` sat AFTER the GET branch, so the GET ran
  //     `agnescodeState()` while the binding was still in its temporal dead
  //     zone and the whole route threw — the panel's poll never saw the
  //     harvested account and kept showing「未关联」while the credential was
  //     already stored;
  //   * the single-flight comment below only holds across requests if the
  //     promise outlives one, and the panel genuinely does poll while a walk
  //     runs.
  let lastHarvest: { ok: boolean; attempts: Array<{ file: string | null; tier: string; detail: string }> } | null = null;
  let agnescodeHarvestInFlight: Promise<{ ok: boolean; attempts: Array<{ file: string | null; tier: string; detail: string }> }> | null = null;
  // The GET self-heal's cooldown stamp (see the GET branch): one repair
  // publish per window, so a persistently failing publish cannot rebuild the
  // adapter on every panel poll.
  let agnescodeSelfHealAt = 0;
  const offAgnescode = ctx.webServer.register({
    kind: "exact",
    path: AGNESCODE_PATH,
    handler: async (request, response) => {
      if (!isAdmitted(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
      // The GET's secret-free state, reused by every POST branch. The
      // `harvest` block carries the last walk's diagnosis rows (tier codes
      // and shape facts only — a token NEVER enters this payload).
      const agnescodeState = async () => {
        const switchState = await (agnescodeSwitch ? agnescodeSwitch.enabled() : null).catch(() => null);
        const effectiveEnabled = switchState === true;
        let loggedIn = false;
        let nickname = "";
        let bffBase = "";
        let expiresAtMs: number | null = null;
        let balance: unknown = null;
        let error: string | null = null;
        try {
          if (agnescodeStore !== null && agnescodeStore !== undefined) {
            const state = await agnescodeStore.state().catch(() => null);
            loggedIn = state?.hasCredential === true;
            nickname = state?.nickname ?? "";
            bffBase = state?.bffBase ?? "";
            expiresAtMs = state?.expiresAtMs ?? null;
            if (loggedIn) {
              const { credential } = await agnescodeStore.resolve().catch(() => ({ credential: null }));
              if (credential?.accessToken) {
                balance = await fetchAgnescodeBalance(credential).catch(() => null);
              }
            }
          }
        } catch (why) {
          error = redactSecrets(why instanceof Error ? why.message : String(why));
        }
        // The roster the adapter offers: the live catalogue when a credential
        // exists, else the static fallback so the panel still shows the
        // known models.
        let models: unknown = null;
        try {
          if (agnescodeStore !== null && agnescodeStore !== undefined) {
            const { credential } = await agnescodeStore.resolve().catch(() => ({ credential: null }));
            if (credential?.accessToken) {
              models = await fetchAgnescodeCatalog(credential).catch(() => null);
            }
          }
        } catch {
          models = null;
        }
        const roster = models !== null && Array.isArray(models) && models.length > 0
          ? models
          : AGNESCODE_FALLBACK_MODELS;
        const publisherState = agnescodePublisher?.state ?? null;
        return {
          ok: true,
          enabled: effectiveEnabled,
          switchSource: switchState === null ? "off" : "panel",
          loggedIn,
          nickname,
          // The per-account base is a fact the panel can show (it is WHERE
          // the account's requests go) — secret-free, from the session file.
          bffBase,
          expiresAtMs,
          balance,
          models: roster,
          providerRegistered: publisherState?.registered === true,
          ...(publisherState?.error !== null && publisherState?.error !== undefined ? { providerError: publisherState.error } : {}),
          ...(lastHarvest !== null ? { harvest: lastHarvest } : {}),
          ...(error !== null ? { error } : {})
        };
      };

      /** Drive the registration from the CURRENT stored credential: the live
       *  catalogue wins over the fallback, the base comes from the credential
       *  (empty when there is none — the publisher's gate then releases). */
      const publishFromStore = async () => {
        if (agnescodePublisher === null || agnescodePublisher === undefined) return;
        let rows = AGNESCODE_FALLBACK_MODELS;
        let bffBase = "";
        try {
          const { credential } = agnescodeStore ? await agnescodeStore.resolve().catch(() => ({ credential: null })) : { credential: null };
          if (credential?.accessToken) {
            const live = await fetchAgnescodeCatalog(credential).catch(() => null);
            if (live !== null && live.length > 0) rows = live;
            bffBase = credential.bffBase ?? "";
          }
        } catch {
          // Fallback roster is already the safe default.
        }
        await agnescodePublisher.publish(rows, bffBase);
      };

      const method = request.method === undefined ? "GET" : request.method;
      if (method === "GET") {
        let state = await agnescodeState();
        // Self-heal: `not_configured` alongside a stored credential is a STALE
        // publish (the switch was toggled before the harvest, and nothing
        // after that failure re-ran the publish — GET used to only read). One
        // queued publish per cooldown lets any poll repair it, so the reader
        // never has to click anything to converge; a publish that fails again
        // stops holding this exact condition only if it reports differently,
        // so the cooldown keeps a persistently failing publish from rebuilding
        // the adapter every 60 s.
        if (
          state.enabled === true && state.loggedIn === true
          && state.providerError === "not_configured"
          && Date.now() - agnescodeSelfHealAt > AGNESCODE_SELF_HEAL_COOLDOWN_MS
        ) {
          agnescodeSelfHealAt = Date.now();
          await publishFromStore();
          state = await agnescodeState();
        }
        writeJson(response, 200, state, { "cache-control": "no-store" });
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBody(request, MAX_AGNESCODE_BODY_BYTES);
      if (!body.ok) {
        writeJson(response, 400, { ok: false, error: body.error }, { "cache-control": "no-store" });
        return;
      }
      const { action } = body.value;
      const answer = async (extra = {}) => {
        const state = await agnescodeState();
        writeJson(response, 200, { ...state, ...extra }, { "cache-control": "no-store" });
      };

      // ── switch: register / deregister the AgnesCode provider with DSH ──
      if (action === "switch") {
        if (typeof body.value.enabled !== "boolean") {
          writeJson(response, 400, { ok: false, error: "expected { action: \"switch\", enabled: boolean }" }, { "cache-control": "no-store" });
          return;
        }
        if (agnescodeSwitch === null || agnescodeSwitch === undefined) {
          await answer({ ok: false, error: "the agnescode switch is unavailable" });
          return;
        }
        try {
          await agnescodeSwitch.save(body.value.enabled);
          await publishFromStore();
        } catch (error) {
          await answer({ ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) });
          return;
        }
        await answer();
        return;
      }

      // ── harvest: re-read the desktop App's session file and store it ──
      if (action === "harvest") {
        if (agnescodeStore === null || agnescodeStore === undefined) {
          await answer({ ok: false, error: "the agnescode credential store is unavailable" });
          return;
        }
        try {
          // Single-flighted: the WHOLE walk (harvest + store save) runs once;
          // a concurrent request joins the same promise and shares both the
          // saved credential and the diagnosis rows.
          if (agnescodeHarvestInFlight === null) {
            agnescodeHarvestInFlight = (async () => {
              const walk = await harvestAgnescodeLocalSession();
              lastHarvest = { ok: walk.ok, attempts: walk.attempts };
              if (walk.ok !== true) return { ok: false, attempts: walk.attempts };
              const expMs = decodeAgnescodeJwtExpMs(walk.session.accessToken);
              await agnescodeStore.save({
                accessToken: walk.session.accessToken,
                bffBase: walk.session.bffBase,
                ...(walk.session.userId !== "" ? { userId: walk.session.userId } : {}),
                ...(walk.session.nickname !== "" ? { nickname: walk.session.nickname } : {}),
                ...(expMs !== undefined ? { expiresAtMs: expMs } : {})
              });
              return { ok: true, attempts: walk.attempts };
            })().finally(() => {
              agnescodeHarvestInFlight = null;
            });
          }
          const walk = await agnescodeHarvestInFlight;
          if (walk.ok !== true) {
            await answer({ ok: false, status: "not_found", harvest: walk });
            return;
          }
        } catch (error) {
          await answer({ ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) });
          return;
        }
        if (agnescodePublisher !== null && agnescodePublisher !== undefined && agnescodePublisher.isDisposed() === false) {
          const switchState = agnescodeSwitch ? await agnescodeSwitch.enabled().catch(() => null) : null;
          if (switchState === true) {
            await publishFromStore();
          }
        }
        await answer({ ok: true, status: "harvested" });
        return;
      }

      // ── logout: forget the stored credential and release the provider ──
      if (action === "logout") {
        if (agnescodeStore === null || agnescodeStore === undefined) {
          await answer({ ok: false, error: "the agnescode credential store is unavailable" });
          return;
        }
        try {
          await agnescodeStore.forget();
          if (agnescodePublisher !== null && agnescodePublisher !== undefined) {
            await agnescodePublisher.publish(AGNESCODE_FALLBACK_MODELS, "");
          }
        } catch (error) {
          await answer({ ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) });
          return;
        }
        await answer({ ok: true, status: "logged_out" });
        return;
      }

      writeJson(response, 400, { ok: false, error: "expected { action: \"switch\"|\"harvest\"|\"logout\" }" }, { "cache-control": "no-store" });
    }
  });

  return [offRoute, offAccount, offApiKey, offProvider, offModels, offDraw, offVideo, offAgnescode];
}
