/**
 * The plugin's side effects — the parts of mounting that are not route
 * handlers.
 *
 * `apply()` is the single mount seam: it assembles the `wiring` object, calls
 * {@link registerRoutes} (routes.ts), then {@link startSideEffects} for:
 *
 *   - the mount seed (`seedPublisherFromCatalog`): offer models before the
 *     first poll, fire-and-forget;
 *   - the two generation tools (opt-in `drawEnabled` / `videoEnabled`,
 *     doubly degraded through the shared {@link createToolMount} ladder —
 *     each handle is stored on the wiring bag, so the switch route re-syncs it
 *     live and teardown disposes it);
 *   - vision step two: the settings-row writer filled for the snapshot route.
 *
 * and {@link teardown} for the unmount order that PITFALLS §18 pins
 * (`stop → dispose → release → tools → off` — it must NOT be simplified).
 *
 * Peer-free discipline: no Host peer is imported here. The only lazy peer
 * loads (the adapter / tools modules) are injected from `apply` via `deps`.
 *
 * @module dsh-connect-agnes-token-plan/lifecycle
 */
import { defineDrawTool } from "./draw.ts";
import { defineVideoTool } from "./video.ts";
import { seedPublisherFromCatalog, catalogSignature } from "./provider-publish.ts";
import { name } from "./host-config.ts";
import { retryBounded, redactError } from "./util.ts";
import { readPanelValue, resolveSwitchEnabled, resolveSwitchValue } from "./switch-precedence.ts";
import { rawDefineTool, type RawToolDefinition, type ToolDefinitionOptions } from "./tool-raw-definition.ts";
import type { HostCtx, HostWiring, ToolSide, ToolWiring, SwitchStore, Settings, ToolMount } from "./types.ts";

/** How many times a mount-time optional-service read is retried. */
const SERVICE_RETRY_ATTEMPTS = 3;
/** Base backoff between service-read attempts (× attempt index). */
const SERVICE_RETRY_DELAY_MS = 300;

/**
 * Read an optional Host service with a bounded retry.
 *
 * A service may register AFTER this plugin mounts: a one-shot read misses a
 * service that arrives a moment late, silently — the draw tool would be
 * absent with the switch visibly on, and no line on any panel naming the
 * reason. A late service is catchable LATER too, not only here: the tool
 * coordinator caches the service once found, but a `sync()` that has not
 * found one yet re-probes on every run (so a switch flip picks up a tools
 * service that registered late). The AgnesCode mount seed uses the same
 * retry for its publish.
 *
 * This retries the READ ONLY. Whatever it returns is used exactly once by the
 * caller: retrying a call that mutates (a tool registration) would register the
 * same tool twice, and the tools registry cannot tell.
 * @param {object} ctx - the host root context.
 * @param {string} service - the service name for `ctx.get`.
 * @param {object} [options]
 * @param {() => boolean} [options.isDisposed] - stop early when the plugin is
 *   withdrawing; a late registration into a withdrawing Host is worse than
 *   absence.
 * @param {number} [options.attempts] - test seam for the attempt count.
 * @param {number} [options.delayMs] - test seam for the backoff base.
 * @returns {Promise<unknown|null>} the service, or `null` when it never
 *   appeared inside the window.
 */
export async function resolveServiceWithRetry(
  ctx: HostCtx,
  service: string,
  options: { isDisposed?: () => boolean; attempts?: number; delayMs?: number } = {}
): Promise<unknown | null> {
  const {
    isDisposed = () => false,
    attempts = SERVICE_RETRY_ATTEMPTS,
    delayMs = SERVICE_RETRY_DELAY_MS
  } = options;
  let found: unknown | null = null;
  await retryBounded({
    attempts,
    delayMs,
    run: () => {
      if (isDisposed()) return true;
      try {
        const value = ctx.get?.(service) ?? (ctx as unknown as Record<string, unknown>)[service] ?? null;
        if (value !== null && value !== undefined) {
          found = value;
          return true;
        }
      } catch {
        // A resolver that refuses a read is treated like an absent service.
      }
      return false;
    }
  });
  return found;
}

/** The host tools service, narrowed to the one member this coordinator drives. */
type ToolsService = { register(definition: unknown): (() => void) | undefined };

/**
 * The live mount handle for ONE opt-in agent tool, through the shared
 * degradation ladder.
 *
 * `registerDrawTool` and `registerVideoTool` differ only in which switch, which
 * model preference, which fetch and which factory they name — everything else
 * (the config-error gate, the panel-beats-config precedence, the tools-service
 * probe, the lazy peer load, the refusing-registry catch, the catalog read at
 * call time) is the same ladder. It is written ONCE so the two tools cannot
 * degrade differently: a tool that vanished on a Host where the other survived
 * would be a bug with no visible cause.
 *
 * The returned {@link ToolMount} is what makes the tool HOT: the panel switch
 * route re-runs `sync()` after it writes the state file, and `sync()` mounts
 * or unmounts the tool in place using the disposer the host's
 * `tools.register` returns. Every rung still returns rather than throwing:
 * a Host without a tools service — or a registry that refuses the
 * definition — leaves the panel and the provider untouched, the tool simply
 * absent. The tools PEER is no longer one of those rungs: when
 * `@deepseek-ai/dsh-tools` cannot load (file-location resolution; installs
 * under `~/.dsh/plugins` never contain the Host runtime), the ladder falls
 * back to {@link rawDefineTool} — a hand-written `ToolDefinition` with the
 * same shape the peer would have produced (the workbuddy precedent) — and
 * logs one warning so the degrade is visible, not silent.
 *
 * State is per-handle (a closure), shared by the mount-time seed, every switch
 * POST and teardown, so the two callers cannot drift into registering the same
 * tool twice: all reconciliations are serialized behind one promise chain,
 * each re-reading the CURRENT effective value before it acts.
 * @param {object} options - wiring.
 * @param {HostCtx} options.ctx - the host root context.
 * @param {HostWiring} options.wiring - see {@link startSideEffects}.
 * @param {ToolSide} options.side - the test seams from `apply`'s `deps`.
 * @param {SwitchStore|null|undefined} [options.store] - the panel switch store.
 * @param {"drawEnabled"|"videoEnabled"} options.enabledKey - the config-default switch key.
 * @param {"drawModelId"|"videoModelId"} options.modelKey - the config-default model key.
 * @param {Function} options.fetchImpl - the request fetch (stubbed in tests).
 * @param {Function} options.factory - `defineDrawTool` / `defineVideoTool`.
 * @returns {ToolMount} the live handle; call `sync()` to reconcile.
 */
export function createToolMount({
  ctx,
  wiring,
  side,
  store,
  enabledKey,
  modelKey,
  fetchImpl,
  factory
}: {
  ctx: HostCtx;
  wiring: HostWiring;
  side: ToolSide;
  store?: SwitchStore | null;
  enabledKey: "drawEnabled" | "videoEnabled";
  modelKey: "drawModelId" | "videoModelId";
  fetchImpl: ToolWiring["fetchImpl"];
  factory: (options: ToolWiring) => unknown;
}): ToolMount {
  const { settings, configError, providerState, catalogStore, resolveApiKey, publisher } = wiring;

  // Per-handle live state. `registered` says the host actually holds a copy of
  // the tool; `disposer` is how we take it back (null when the host offered no
  // unregister path, in which case the tool is sticky for this process — the
  // old mount-once behavior, still correct, just not removable).
  let tools: ToolsService | null = null;
  let registered = false;
  let disposer: (() => void) | null = null;
  let regModel: string | null = null;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  // One degrade warning per handle (a model swap re-mounts; do not spam).
  let rawWarned = false;

  const safeCall = (fn: (() => void) | null): void => {
    if (fn === null) return;
    try {
      fn();
    } catch {
      // A disposer that throws (a Host already tearing down) still counts as
      // "called": the handle is cleared above, so we never retry it forever.
    }
  };

  async function syncImpl(): Promise<void> {
    if (closed) return;
    if (configError !== null) return;
    // Same precedence as every other switch in this plugin, from the same
    // single source (`switch-precedence`): panel-saved beats the patch default.
    const panelEnabled = await readPanelValue(async () => (await store?.enabled()) ?? null);
    const panelModel = await readPanelValue(async () => (await store?.modelId()) ?? null);
    const { enabled } = resolveSwitchEnabled(panelEnabled, settings[enabledKey]);
    const { value: targetModel } = resolveSwitchValue(panelModel, settings[modelKey]);

    // Off: take the tool back when we can.
    if (enabled !== true) {
      if (registered) {
        const d = disposer;
        registered = false;
        disposer = null;
        regModel = null;
        safeCall(d);
      }
      return;
    }

    // On: already mounted with the target model, nothing to do (idempotent).
    if (registered && regModel === targetModel) return;
    // Sticky (mounted with no disposer): the host gave us no way to remove or
    // swap the tool, so it is frozen at its first registration for this
    // process. Do NOT re-register — that would be a second copy.
    if (registered && disposer === null) return;

    // Otherwise: unmount the current one (we hold a disposer), then mount the
    // target. A model change on a mounted tool re-registers so the new pick is
    // live rather than waiting for the next Host start.
    if (registered && disposer !== null) {
      const d = disposer;
      registered = false;
      disposer = null;
      regModel = null;
      safeCall(d);
    }

    // The tools service is optional and may register a moment AFTER this
    // plugin mounts: retry the READ (never the registration). Because the
    // service is only cached once found, a later sync re-probes for free, so
    // a switch flip picks up a service that arrived late.
    const service = (tools ?? (await resolveServiceWithRetry(ctx, "tools", { isDisposed: () => publisher.isDisposed() }))) as ToolsService | null;
    if (service === null || typeof service.register !== "function") return;
    tools = service;

    // The tools peer is a FILE-LOCATION import: Node walks this install's
    // own ancestors for @deepseek-ai/dsh-tools, and plugin trees never
    // contain the Host runtime (CLI: global npm prefix; desktop: inside the
    // app bundle). When it fails the tool does NOT stay absent anymore —
    // fall back to the raw definition (same contract workbuddy hand-writes)
    // and make the degrade visible once per handle.
    let defineTool: ((options: ToolDefinitionOptions) => RawToolDefinition | unknown) | null = null;
    let peerFailure: string | null = null;
    try {
      const mod = await Promise.resolve(side.loadToolsModule?.());
      const candidate: ((options: ToolDefinitionOptions) => RawToolDefinition | unknown) | null =
        mod?.defineTool ?? mod?.default?.defineTool ?? null;
      defineTool = typeof candidate === "function" ? candidate : null;
      if (defineTool === null) peerFailure = "the tools module exports no defineTool";
    } catch (error) {
      // ERR_MODULE_NOT_FOUND (or any peer-load failure): raw fallback below.
      defineTool = null;
      peerFailure = redactError(error);
    }
    if (defineTool === null) {
      defineTool = rawDefineTool;
      if (!rawWarned) {
        rawWarned = true;
        wiring.logger?.warn?.(`${name}: ${enabledKey}: tools peer unavailable on this Host (${peerFailure}) — mounted the built-in raw tool definition instead`);
      }
    }

    // Same precedence as the switch: a panel-saved model preference beats the
    // patch's value (empty string = auto-pick from the catalog).
    const effectiveSettings = targetModel !== settings[modelKey]
      ? ({ ...settings, [modelKey]: targetModel } as Settings)
      : settings;
    const definition = factory({
      defineTool,
      resolveApiKey,
      // The discovery set is the catalog, NOT the LLM offer: the picker's
      // allow-list is a filter on what the picker OFFERS, and silently
      // binding the agent's generation tools to that curation would drop a
      // model from the tool's world the moment a user trimmed the picker.
      // The full persisted catalog is read at call time (after mount an
      // empty read is a no-op — `catalog-store.list()` is cached in memory),
      // so a catalog refresh lands without re-registering.
      getEntries: async () => {
        const live = Array.isArray(providerState.entries) && providerState.entries.length > 0
          ? providerState.entries
          : await catalogStore.list().catch(() => []);
        return Array.isArray(live) ? live : [];
      },
      settings: effectiveSettings,
      fetchImpl,
      isDisposed: () => publisher.isDisposed()
    });

    let newDisposer: (() => void) | undefined;
    try {
      newDisposer = service.register(definition);
    } catch {
      // A refusing registry degrades identically: tool absent, panel fine.
      return;
    }
    registered = true;
    regModel = targetModel;
    disposer = typeof newDisposer === "function" ? newDisposer : null;
  }

  return {
    sync: () => {
      // Serialize every reconciliation (the mount seed, a switch POST, a model
      // POST, a forget) behind ONE chain so two concurrent triggers cannot
      // register the tool twice. Each queued run re-reads the CURRENT value,
      // so a sync queued behind a stale one still converges to the latest state.
      const run = chain.then(() => syncImpl());
      chain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    dispose: () => {
      closed = true;
      const d = disposer;
      registered = false;
      disposer = null;
      regModel = null;
      safeCall(d);
    },
    isMounted: () => registered
  };
}

/**
 * Create the live mount handle for the `agnes_draw_image` agent tool
 * (ARCHITECTURE.md §5.4, route B). Opt-in (`drawEnabled`, default off) and
 * doubly degraded. The handle is stored on the wiring bag (`wiring.drawToolMount`)
 * so the switch route can re-sync it live and teardown can dispose it; the
 * initial `sync()` seeds the mount-time behavior (register now when the
 * effective value is on).
 * @param ctx - the host root context (reads `ctx.get("tools")` / `ctx.tools`).
 * @param {object} wiring - see {@link startSideEffects}.
 * @param {object} side - test seams from `apply`'s `deps`.
 * @returns {ToolMount} the live handle, also stored at `wiring.drawToolMount`.
 */
export function registerDrawTool(ctx: HostCtx, wiring: HostWiring, side: ToolSide): ToolMount {
  const mount = createToolMount({
    ctx,
    wiring,
    side,
    store: wiring.drawStore,
    enabledKey: "drawEnabled",
    modelKey: "drawModelId",
    fetchImpl: side.drawFetch,
    factory: defineDrawTool
  });
  wiring.drawToolMount = mount;
  void mount.sync();
  return mount;
}

/**
 * Create the live mount handle for the `agnes_video_generate` agent tool
 * (`video.ts`).
 *
 * A SEPARATE opt-in from the draw tool (`videoEnabled`), sharing only the
 * mounting ladder — see {@link createToolMount}. The protocol is the reason the
 * two are not one module: video is an asynchronous task, so this tool creates a
 * task and then polls it for minutes rather than issuing one request.
 * @param ctx - the host root context.
 * @param {object} wiring - see {@link startSideEffects}.
 * @param {object} side - test seams from `apply`'s `deps`.
 * @returns {ToolMount} the live handle, also stored at `wiring.videoToolMount`.
 */
export function registerVideoTool(ctx: HostCtx, wiring: HostWiring, side: ToolSide): ToolMount {
  const mount = createToolMount({
    ctx,
    wiring,
    side,
    store: wiring.videoStore,
    enabledKey: "videoEnabled",
    modelKey: "videoModelId",
    fetchImpl: side.videoFetch,
    factory: defineVideoTool
  });
  wiring.videoToolMount = mount;
  void mount.sync();
  return mount;
}

/**
 * Run the mount-time side effects: the persisted-catalog seed, the draw tool
 * (when opted in), and vision step two's settings-row writer.
 * @param ctx - the host root context.
 * @param {object} wiring - assembled by `apply()`.
 * @param {object} wiring.settings - the resolved settings row.
 * @param {string|null} wiring.configError - a settings/auth misconfiguration.
 * @param {object} wiring.publisher - the `createProviderPublisher` instance.
 * @param {object} wiring.providerState - `publisher.state` (shared reference).
 * @param {object} wiring.catalogStore - the `createFileCatalogStore` instance.
 * @param {Function} wiring.resolveApiKey - resolves the live `sk-` key.
 * @param {{current: Function|null}} wiring.visionPublish - filled here.
 * @param {object} [wiring.logger] - `ctx.logger` (Host logging).
 * @param {object} side - test seams from `apply`'s `deps`
 *   (`loadToolsModule`, `drawFetch`).
 * @returns {void} — seed and draw are fire-and-forget.
 */
export function startSideEffects(ctx: HostCtx, wiring: HostWiring, side: ToolSide) {
  const { publisher, catalogStore, settings, visionPublish } = wiring;

  // Seed the registration from the persisted catalog so a restarted Host
  // offers models before its first poll (and with no console login at all).
  // Fire-and-forget: a state dir that cannot be read just waits for the poll.
  void seedPublisherFromCatalog(
    publisher,
    () => catalogStore.list(),
    () => catalogStore.listEnabledIds(),
    catalogSignature
  );

  // Draw absorption: opt-in, doubly degraded (no tools service / no peer).
  // The effective value is panel-saved > config default (draw-store). The mount
  // handle is stored on the wiring bag (`wiring.drawToolMount`) so the switch
  // route can re-sync the tool LIVE after a write; the first `sync()` seeds the
  // mount-time behavior. `tools.register` returns a disposer, so a later
  // switch flip unmounts in place — no Host restart required.
  registerDrawTool(ctx, wiring, side);

  // Video absorption: a SEPARATE opt-in through the same ladder. Independent
  // of the draw switch on purpose — one switch would force both modalities on
  // together. Same live-mount story via `wiring.videoToolMount`.
  registerVideoTool(ctx, wiring, side);

  // ------------------------------------------------------------------
  // Vision step two (ARCHITECTURE.md §5.1): publish which of this key's
  // models take image input into THIS row's own settings namespace, for
  // a later LLM connect plugin (dsh-provider-Agnes, etc.) to read.
  //
  // The write goes to this plugin's settings row ONLY - never another
  // provider's `imageModelIds` - so a miscalculated model list can only
  // affect the panel, not DSH's model routing. It is opt-in
  // (`writeImageModelIds`), off by default, and idempotent: a no-change
  // pass costs one revision read and no write.
  //
  // `visionPublish.current` is filled in here from `ctx.get("settings")`
  // (the resolver-not-snapshot pattern: the service may register after
  // this plugin mounts); a Host without one leaves it null and the
  // publish simply never runs.
  // ------------------------------------------------------------------
  {
    // Read the optional `settings` service the way every sibling does —
    // index.ts:168 `getService` and state-store.ts `readOptionalService` both
    // use `ctx.get?.()` behind a try, because a Host that never publishes the
    // ReflectService mixin throws on an undeclared service read, and this block
    // runs inside `apply()` with no outer try to catch a mount-time throw. A
    // Host without a settings service simply leaves the vision publisher null
    // and it never runs — never a mount failure.
    const settingsService = (() => {
      try {
        return ctx.get?.("settings") ?? null;
      } catch {
        return null;
      }
    })();
    if (settingsService !== null && typeof settingsService.update === "function") {
      const descriptorOf = () => {
        try {
          const view = settingsService.describe?.({ redactSecrets: true });
          const rows = Array.isArray(view) ? view : view?.entries ?? [];
          return rows.find((candidate: { ns?: unknown }) => candidate?.ns === name) ?? null;
        } catch {
          return null;
        }
      };
      let publishing = false;
      let lastPublishedIds = settings.imageModelIds.slice();
      visionPublish.current = async (visionEntries, ids) => {
        if (settings.writeImageModelIds !== true) return;
        if (publishing) return;
        if (JSON.stringify(lastPublishedIds) === JSON.stringify(ids)) return;
        const descriptor = descriptorOf();
        if (descriptor === null) return;
        publishing = true;
        try {
          await settingsService.update(name, {
            imageModelIds: ids,
            visionModels: visionEntries
          }, descriptor.revision);
          lastPublishedIds = ids.slice();
        } catch (error) {
          // Redacted like every other log exit: a settings-service refusal can
          // carry the payload it was handed, and this line is written to the
          // Host's stdout (PITFALLS §42) where nobody filters it afterwards.
          wiring.logger?.warn?.(`${name}: vision publish refused: ${redactError(error)}`);
        } finally {
          publishing = false;
        }
      };
    }
  }
}

/**
 * Unmount, in the order PITFALLS §18 pins:
 *
 *   0. `stopTick` — the catalogue's background refresh (ADR-015) stops FIRST,
 *      so no new publish can be started while the rest is being withdrawn;
 *   1. `dispose` — a publish still in flight (the mount seed's, or a poll's)
 *      must not register into a Host that is letting this plugin go;
 *   2. `release` — stop offering the provider first, so a request cannot be
 *      routed to an adapter whose Host services are already half gone;
 *   3. the live agent tools (draw / video) are unmounted, so an in-flight
 *      switch handler cannot re-sync a tool into a Host that is going away;
 *   4. the route `off()` callbacks, each guarded (the web server may already
 *      be gone during shutdown).
 *
 * This order is a concurrency fix and must NOT be simplified.
 * @param {object} wiring - assembled by `apply()`.
 * @param {Function} wiring.releaseProvider - `publisher.release()`.
 * @param {object} wiring.publisher - the `createProviderPublisher` instance.
 * @param {Function[]} offs - the unregister callbacks from {@link registerRoutes}.
 * @param {Function} [stopTick] - the `catalogEffects.start()` stopper.
 * @returns {void}
 */
export function teardown(wiring: HostWiring, offs: Array<() => void>, stopTick?: () => void) {
  const { publisher, releaseProvider, agnescodePublisher } = wiring;
  // The background clock goes first: it is the one thing that can still START
  // work, and every step below is about not letting work land in a Host that is
  // letting this plugin go.
  try {
    stopTick?.();
  } catch {
    // A stopper that throws is already stopped as far as this teardown cares.
  }
  // Before anything else: a publish still in flight (the mount seed's, or a
  // poll's) must not register into a Host that is letting this plugin go.
  publisher.dispose();
  // The AgnesCode provider is a THIRD, independent registration (ROADMAP
  // §6.3): same order, same reason.
  agnescodePublisher?.dispose();
  agnescodePublisher?.release?.();
  // Stop offering the provider first, so a request cannot be routed to an
  // adapter whose Host services are already half gone.
  releaseProvider();
  // Withdraw the live agent tools BEFORE the routes go: a switch POST still in
  // flight would otherwise re-sync a tool into a Host that is letting this
  // plugin go. `dispose()` also closes the handle, so any queued `sync()`
  // becomes a no-op rather than a late registration.
  wiring.drawToolMount?.dispose();
  wiring.videoToolMount?.dispose();
  for (const off of offs) {
    try {
      off();
    } catch {
      // The web server may already be gone during shutdown.
    }
  }
}