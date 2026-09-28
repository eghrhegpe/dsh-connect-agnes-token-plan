/**
 * The plugin's real wiring, driven by a real Cordis container.
 *
 * The route tests call `apply()` with a hand-rolled object that quacks like a
 * Host. That covers the handler bodies, and nothing else: not the plugin's
 * `inject` declaration, not service resolution, not the mount/unmount
 * lifecycle, not whether the routes are registered at all before something asks
 * for them. A plugin whose `inject` names a service the Host does not provide
 * would stay invisible in that suite and simply never appear in the UI.
 *
 * So this file boots an actual `@deepseek-ai/cordis` container, loads the
 * plugin the way the Loader does, and inspects what really got registered.
 * It stops short of a full `dsh web` process — no such CLI is installed here,
 * and the Electron runtime is not a server you can script — but it does cover
 * the seam that a fake context cannot.
 */
import { loadPeer, installNetworkGuard, isolateHostEnv, isolateStateDir } from "./peer-roots.mjs";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();
/** This machine's own SenseNova keys must not steer a check. */
const restoreHostEnv = isolateHostEnv();

const { Context } = await loadPeer("cordis");

/** After the peers are found: mounting must not write into the real Home. */
const restoreStateDir = isolateStateDir();

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

/** A webServer service that records what a plugin registers with it. */
function makeWebServer() {
  const registered = new Map();
  return {
    registered,
    register(spec) {
      if (spec === null || typeof spec !== "object") throw new TypeError("register(spec) needs a spec");
      if (typeof spec.path !== "string") throw new TypeError("a route spec needs a path");
      if (typeof spec.handler !== "function") throw new TypeError("a route spec needs a handler");
      if (spec.kind !== undefined && spec.kind !== "exact") {
        throw new TypeError(`unexpected route kind: ${String(spec.kind)}`);
      }
      registered.set(spec.path, spec.handler);
      return () => { registered.delete(spec.path); };
    }
  };
}

/** A credentials service with the same surface the store uses. */
function makeCredentials() {
  const records = new Map();
  const refs = new Map();
  return {
    records,
    refs,
    async readRecord(k) { return records.get(k); },
    async modifyRecord(k, mutate) {
      const next = await mutate(records.get(k));
      if (next === undefined) return records.get(k);
      records.set(k, next);
      return next;
    },
    async deleteRecord(k) { records.delete(k); },
    async resolve(ref) {
      const v = refs.get(ref);
      return typeof v === "string" && v !== "" ? { value: v, source: "file" } : undefined;
    },
    async set(ref, value) { refs.set(ref, value); },
    async unset(ref) { refs.delete(ref); }
  };
}

/** A fake llm registration service recording the provider pair lifecycle. */
function makeLlm() {
  const calls = { adapter: 0, directory: 0, released: 0 };
  return {
    calls,
    registerAdapter(ids, adapter) {
      calls.adapter += 1;
      calls.lastIds = ids;
      calls.lastAdapter = adapter;
      return () => { calls.released += 1; };
    },
    registerConfigurableProviders(rows) {
      calls.directory += 1;
      calls.lastRows = rows;
      return () => { calls.released += 1; };
    }
  };
}

/** The peer adapter seam replacement: no Host peers are needed in wiring. */
function adapterDeps() {
  const builds = [];
  return {
    builds,
    loadAdapterModule: async () => ({
      createSensenovaAdapter(options) {
        builds.push(options);
        return { providerIds: ["sensenova-token-plan"], adapter: { fake: true } };
      }
    })
  };
}

/** A minimal Host request, as Cordis would hand one to a handler. */
function request(extra = {}) {
  return { method: "GET", headers: { host: "127.0.0.1:19387", ...extra } };
}

function response() {
  return {
    statusCode: null,
    headers: null,
    payload: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(text) { this.payload = text === undefined ? null : JSON.parse(text); }
  };
}

/** Boot a container with the given services and load the plugin into it. */
async function bootPlugin({ withCredentials = true, withLlm = false, config = {}, de } = {}) {
  const webServer = makeWebServer();
  const credentials = withCredentials ? makeCredentials() : undefined;
  const llm = withLlm ? makeLlm() : undefined;
  const ctx = new Context();
  // Services are published with `ctx.provide`, the way a Host publishes its
  // own. Assigning `ctx.webServer` from a plugin's apply would be too late:
  // `inject` is resolved BEFORE apply runs, so a plugin declaring
  // `inject: ["webServer"]` would never see it and would silently never
  // activate — exactly the wiring bug this file exists to catch.
  ctx.provide("webServer", webServer);
  if (credentials !== undefined) ctx.provide("credentials", credentials);
  // `llm` is consumed optionally through `ctx.get` (this plugin injects only
  // webServer), the same optional seam the settings/attachments services use.
  if (llm !== undefined) ctx.provide("llm", llm);
  const host = await import(`../index.js?wiring=${Math.random()}`);
  // The Loader hands Cordis the plugin object; the module's named exports are
  // that object, so pass exactly them. `ctx.plugin` returns the fiber, and
  // disposing that fiber is how a plugin is stopped — the teardown path the
  // route's `ctx.effect` return value hangs off. The third apply argument is
  // test-only seam wiring (the peer adapter module); the real Loader passes
  // nothing there.
  const plugin = { name: host.name, inject: host.inject, apply: (fiberCtx, row) => host.apply(fiberCtx, row, de) };
  const fiber = await ctx.plugin(plugin, config);
  return { ctx, webServer, credentials, llm, host, plugin, fiber, stop: () => fiber?.dispose?.() };
}

// === A. a bad endpoint override is refused, not silently applied ========
// `apply` now builds a `createAuth(settings.auth)` instance of its own, so each
// boot gets a fresh config — there is no module-level state to inherit and no
// hidden-state trap. This case still confirms a malformed override is reported
// as a config error rather than silently aimed at the real platform.
{
  // `consoleBase` is the operator-facing key (see cordis.patch.yml); the
  // `auth.*` overrides are the lower-level ones `createAuth` also accepts.
  const { webServer, stop } = await bootPlugin({ config: { consoleBase: "not-a-url" } });
  const res = response();
  await webServer.registered.get("/api/dsh-connect-sensenova-token-plan/snapshot")(request(), res);
  // A malformed override must fail loudly: the alternative is a baffling
  // network error on every poll, with nothing saying why.
  check("a malformed endpoint is reported as a config error",
    res.payload?.ok === false && res.payload?.code === "config_error",
    JSON.stringify(res.payload ?? {}).slice(0, 120));
  check("the config error explains itself", typeof res.payload?.error === "string" && res.payload.error.length > 0,
    String(res.payload?.error));
  await stop();
}

// === A2. a NESTED auth block is refused, not silently ignored ===========
// Found by the end-to-end run, and the most dangerous shape this plugin has.
// The loader accepts `auth: { iamBase: ... }`; the plugin reads its overrides
// from the TOP level, so the block is dropped without a word — and the panel
// then runs on its shipped defaults, which point at the REAL platform. A test
// run meant for a local stub posted a real login attempt before this check
// existed. Silence here is what makes that possible, so it must be loud.
{
  const { webServer, stop } = await bootPlugin({
    config: { consoleBase: "http://127.0.0.1:19399", auth: { iamBase: "http://127.0.0.1:19399" } }
  });
  const res = response();
  await webServer.registered.get("/api/dsh-connect-sensenova-token-plan/snapshot")(request(), res);
  check("a nested auth block is reported as a config error",
    res.payload?.ok === false && res.payload?.code === "config_error",
    JSON.stringify(res.payload ?? {}).slice(0, 140));
  check("the message names the top-level keys to use",
    typeof res.payload?.error === "string" && res.payload.error.includes("iamBase"),
    String(res.payload?.error).slice(0, 160));
  // The panel must still mount and still answer: an operator who misconfigured
  // a key needs to be told, not left with a plugin that vanished.
  check("the plugin still mounts despite the bad row",
    webServer.registered.has("/api/dsh-connect-sensenova-token-plan/snapshot"));
  await stop();
}

// === B. the plugin activates and registers all three routes ===============
{
  const { webServer, host, stop } = await bootPlugin();
  check("the plugin declares the services it needs", Array.isArray(host.inject) && host.inject.includes("webServer"),
    JSON.stringify(host.inject));
  check("the snapshot/account/api-key routes are registered on mount",
    webServer.registered.has("/api/dsh-connect-sensenova-token-plan/snapshot")
    && webServer.registered.has("/api/dsh-connect-sensenova-token-plan/account")
    && webServer.registered.has("/api/dsh-connect-sensenova-token-plan/api-key"),
    [...webServer.registered.keys()].join(", "));
  // The registered values must be callable handlers, not specs: the real
  // webServer invokes what it was given, and the panel depends on it.
  check("the snapshot route is a function",
    typeof webServer.registered.get("/api/dsh-connect-sensenova-token-plan/snapshot") === "function");
  check("the account route is a function",
    typeof webServer.registered.get("/api/dsh-connect-sensenova-token-plan/account") === "function");
  check("the api-key route is a function",
    typeof webServer.registered.get("/api/dsh-connect-sensenova-token-plan/api-key") === "function");
  await stop();
}

// === B. the routes answer through the container, not a stub ==============
{
  const { webServer, stop } = await bootPlugin();
  const handler = webServer.registered.get("/api/dsh-connect-sensenova-token-plan/snapshot");
  const res = response();
  // No account is configured, so this is the not_configured path — the one
  // that carries the `auth` block the panel needs to reach the form.
  await handler(request(), res);
  check("the snapshot route answers 200", res.statusCode === 200, String(res.statusCode));
  check("it reports a payload", res.payload !== null);
  check("an unconfigured Host is not an error state",
    res.payload?.ok === false && res.payload?.code === "not_configured",
    JSON.stringify(res.payload ?? {}).slice(0, 140));
  check("the answer carries the auth block the panel reads",
    res.payload?.auth !== undefined && res.payload?.auth?.needsAccount === true,
    JSON.stringify(res.payload?.auth));
  check("an unconfigured Host is not marked ephemeral",
    res.payload?.auth?.ephemeral === false, JSON.stringify(res.payload?.auth?.ephemeral));
  check("no wait is being served", res.payload?.auth?.retryAfterMs === null,
    String(res.payload?.auth?.retryAfterMs));
  check("no user action is demanded", res.payload?.auth?.needsUserAction === false,
    String(res.payload?.auth?.needsUserAction));
  check("the response is not cacheable", res.headers?.["cache-control"] === "no-store",
    JSON.stringify(res.headers));
  await stop();
}

// === C. a cross-origin request is refused at the real seam ===============
{
  const { webServer, stop } = await bootPlugin();
  const handler = webServer.registered.get("/api/dsh-connect-sensenova-token-plan/account");
  const res = response();
  await handler({ method: "POST", headers: { host: "127.0.0.1:19387", origin: "https://evil.test" } }, res);
  check("a cross-origin request is refused", res.statusCode === 403, String(res.statusCode));
  await stop();
}

// === D. unmounting withdraws the routes ==================================
// A plugin that leaks its routes keeps answering after it is disabled, which
// in the real Host means a stale panel still polling a route nobody owns.
{
  const { webServer, stop } = await bootPlugin();
  check("routes are present while mounted", webServer.registered.size === 3, String(webServer.registered.size));
  await stop();
  check("unmounting withdraws the routes", webServer.registered.size === 0,
    [...webServer.registered.keys()].join(", "));
}

// === E. a Host WITHOUT the credentials service still activates ===========
{
  const { webServer, stop } = await bootPlugin({ withCredentials: false });
  check("the plugin activates without the credentials service",
    webServer.registered.has("/api/dsh-connect-sensenova-token-plan/snapshot"));
  const res = response();
  await webServer.registered.get("/api/dsh-connect-sensenova-token-plan/snapshot")(request(), res);
  check("it reports the account as needed", res.payload?.auth?.needsAccount === true,
    JSON.stringify(res.payload?.auth));
  // With no service to hold it, the account would not survive a restart, and
  // the panel has to say so rather than imply the account is safe on disk.
  check("it admits the account is ephemeral", res.payload?.auth?.ephemeral === true,
    String(res.payload?.auth?.ephemeral));
  await stop();
}

// === F. the direct provider registers through the real llm service =======
// With `registerProvider: true` the mount seed registers the provider even
// before a console login or a first poll (its model list may start empty).
// The peer-dependent factory is injected via apply's third arg; what is
// asserted here is the Cordis-level wiring: optional `ctx.get("llm")`, the
// register pair, and its release on dispose.
{
  const de = adapterDeps();
  const { webServer, llm, stop } = await bootPlugin({
    withLlm: true,
    config: { registerProvider: true },
    de
  });
  // Let the mount seed's async publish settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("the adapter pair was registered with the llm service",
    llm.calls.adapter === 1 && llm.calls.directory === 1,
    JSON.stringify({ adapter: llm.calls.adapter, directory: llm.calls.directory }));
  check("the adapter is owned by the non-colliding provider id",
    Array.isArray(llm.calls.lastIds) && llm.calls.lastIds[0] === "sensenova-token-plan",
    JSON.stringify(llm.calls.lastIds));
  check("the directory row names this plugin's settings namespace",
    llm.calls.lastRows?.[0]?.settingsNs === "dsh-connect-sensenova-token-plan" &&
    llm.calls.lastRows[0]?.declared === false,
    JSON.stringify(llm.calls.lastRows));
  check("the adapter was built for apiBase with the key resolver seam",
    de.builds.length === 1 && typeof de.builds[0].resolveApiKey === "function" &&
    de.builds[0].baseUrl === "https://token.sensenova.cn/v1",
    JSON.stringify({ builds: de.builds.length, baseUrl: de.builds[0]?.baseUrl }));
  // The API-key route is served by the same container while registered.
  const keyRes = response();
  await webServer.registered.get("/api/dsh-connect-sensenova-token-plan/api-key")(request(), keyRes);
  check("the api-key route answers inside the container",
    keyRes.statusCode === 200 && keyRes.payload?.ok === true && keyRes.payload?.hasApiKey === false,
    JSON.stringify(keyRes.payload));

  const releasedBefore = llm.calls.released;
  await stop();
  check("disposing the fiber released the registered pair",
    llm.calls.released >= releasedBefore + 2, String(llm.calls.released));
  check("disposing withdrew the routes too", webServer.registered.size === 0,
    [...webServer.registered.keys()].join(", "));
}

// === F2. the opt-in off registers NOTHING, even with an llm service =======
{
  const de = adapterDeps();
  const { llm, stop } = await bootPlugin({ withLlm: true, config: {}, de });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("with registerProvider off no pair is registered",
    llm.calls.adapter === 0 && llm.calls.directory === 0 && de.builds.length === 0,
    JSON.stringify({ adapter: llm.calls.adapter, builds: de.builds.length }));
  await stop();
  check("off leaves nothing to release", llm.calls.released === 0, String(llm.calls.released));
}

// === G. the wiring test itself stayed offline ===========================
const unstubbed = releaseNetworkGuard();
restoreHostEnv();
check("no check escaped its stub to the network", unstubbed.length === 0, unstubbed.join(", "));

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
