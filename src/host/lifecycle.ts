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
 *     doubly degraded through the shared {@link mountAgentTool} ladder);
 *   - vision step two: the settings-row writer filled for the snapshot route.
 *
 * and {@link teardown} for the unmount order that PITFALLS §18 pins
 * (`dispose → release → off×5` — it must NOT be simplified).
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

/**
 * Mount one opt-in agent tool, through the shared degradation ladder.
 *
 * `registerDrawTool` and `registerVideoTool` differ only in which switch, which
 * model preference, which fetch and which factory they name — everything else
 * (the config-error gate, the panel-beats-config precedence, the tools-service
 * probe, the lazy peer load, the refusing-registry catch, the catalog read at
 * call time) is the same ladder. It is written ONCE so the two tools cannot
 * degrade differently: a tool that vanished on a Host where the other survived
 * would be a bug with no visible cause.
 *
 * Every rung returns silently rather than throwing. A Host without a tools
 * service, or a peer that fails to load, must leave the panel and the provider
 * untouched — the tool is simply absent.
 * @param {object} options - wiring.
 * @param {object} options.ctx - the host root context.
 * @param {object} options.wiring - see {@link startSideEffects}.
 * @param {object} options.side - the test seams from `apply`'s `deps`.
 * @param {object} [options.store] - the panel switch store (`draw-store` / `video-store`).
 * @param {string} options.enabledKey - the settings key holding the config default.
 * @param {string} options.modelKey - the settings key holding the configured model id.
 * @param {Function} options.fetchImpl - the request fetch (stubbed in tests).
 * @param {Function} options.factory - `defineDrawTool` / `defineVideoTool`.
 * @returns {Promise<void>}
 */
async function mountAgentTool({ ctx, wiring, side, store, enabledKey, modelKey, fetchImpl, factory }) {
  const { settings, configError, providerState, catalogStore, resolveApiKey, publisher } = wiring;
  if (configError !== null) return;
  const panelEnabled = store ? await store.enabled().catch(() => null) : null;
  if ((panelEnabled ?? settings[enabledKey]) !== true) return;
  // Same precedence as the switch: a panel-saved model preference beats the
  // patch's value (empty string = auto-pick from the catalog).
  const panelModelId = store ? await store.modelId().catch(() => null) : null;
  const effectiveSettings = panelModelId !== null ? { ...settings, [modelKey]: panelModelId } : settings;
  const tools = ctx.get("tools") ?? ctx.tools ?? null;
  if (tools === null || typeof tools.register !== "function") return;
  let defineTool;
  try {
    const mod = await Promise.resolve(side.loadToolsModule());
    defineTool = mod?.defineTool ?? mod?.default?.defineTool ?? null;
  } catch {
    // No tools peer on this Host: the tool stays absent, nothing logs.
    return;
  }
  if (typeof defineTool !== "function") return;
  try {
    tools.register(
      factory({
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
      })
    );
  } catch {
    // A refusing registry degrades identically: tool absent, panel fine.
  }
}

/**
 * Register the `agnes_draw_image` agent tool (ARCHITECTURE.md §5.4, route B).
 * Opt-in (`drawEnabled`, default off) and doubly degraded. Named as a separate
 * export so a test can inject its own `ctx`/`wiring`; `startSideEffects` calls
 * it when enabled.
 * @param ctx - the host root context (reads `ctx.get("tools")` / `ctx.tools`).
 * @param {object} wiring - see {@link startSideEffects}.
 * @param {object} side - test seams from `apply`'s `deps`.
 * @returns {Promise<void>}
 */
export async function registerDrawTool(ctx, wiring, side) {
  await mountAgentTool({
    ctx,
    wiring,
    side,
    store: wiring.drawStore,
    enabledKey: "drawEnabled",
    modelKey: "drawModelId",
    fetchImpl: side.drawFetch,
    factory: defineDrawTool
  });
}

/**
 * Register the `agnes_video_generate` agent tool (`video.ts`).
 *
 * A SEPARATE opt-in from the draw tool (`videoEnabled`), sharing only the
 * mounting ladder — see {@link mountAgentTool}. The protocol is the reason the
 * two are not one module: video is an asynchronous task, so this tool creates a
 * task and then polls it for minutes rather than issuing one request.
 * @param ctx - the host root context.
 * @param {object} wiring - see {@link startSideEffects}.
 * @param {object} side - test seams from `apply`'s `deps`.
 * @returns {Promise<void>}
 */
export async function registerVideoTool(ctx, wiring, side) {
  await mountAgentTool({
    ctx,
    wiring,
    side,
    store: wiring.videoStore,
    enabledKey: "videoEnabled",
    modelKey: "videoModelId",
    fetchImpl: side.videoFetch,
    factory: defineVideoTool
  });
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
export function startSideEffects(ctx, wiring, side) {
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
  // The effective value is panel-saved > config default (draw-store), read at
  // mount time — the actual tool mount/unmount only happens on the next Host
  // start, since the tools registry has no unregister call.
  void registerDrawTool(ctx, wiring, side);

  // Video absorption: a SEPARATE opt-in through the same ladder. Independent
  // of the draw switch on purpose — one switch would force both modalities on
  // together.
  void registerVideoTool(ctx, wiring, side);

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
    const settingsService = ctx.get("settings") ?? null;
    if (settingsService !== null && typeof settingsService.update === "function") {
      const descriptorOf = () => {
        try {
          const view = settingsService.describe?.({ redactSecrets: true });
          const rows = Array.isArray(view) ? view : view?.entries ?? [];
          return rows.find((candidate) => candidate?.ns === name) ?? null;
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
          wiring.logger?.warn?.(`${name}: vision publish refused: ${error instanceof Error ? error.message : String(error)}`);
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
 *   1. `dispose` — a publish still in flight (the mount seed's, or a poll's)
 *      must not register into a Host that is letting this plugin go;
 *   2. `release` — stop offering the provider first, so a request cannot be
 *      routed to an adapter whose Host services are already half gone;
 *   3. the route `off()` callbacks, each guarded (the web server may already
 *      be gone during shutdown).
 *
 * This order is a concurrency fix and must NOT be simplified.
 * @param {object} wiring - assembled by `apply()`.
 * @param {Function} wiring.releaseProvider - `publisher.release()`.
 * @param {object} wiring.publisher - the `createProviderPublisher` instance.
 * @param {Function[]} offs - the unregister callbacks from {@link registerRoutes}.
 * @returns {void}
 */
export function teardown(wiring, offs) {
  const { publisher, releaseProvider, raccoonPublisher, agnescodePublisher } = wiring;
  // Before anything else: a publish still in flight (the mount seed's, or a
  // poll's) must not register into a Host that is letting this plugin go.
  publisher.dispose();
  // The Raccoon provider is a SECOND, independent registration (ROADMAP
  // §6.1): dispose it in the same order it registered, so a late raccoon
  // publish cannot register into the withdrawing Host either.
  raccoonPublisher?.dispose();
  raccoonPublisher?.release?.();
  // The AgnesCode provider is a THIRD, independent registration (ROADMAP
  // §6.3): same order, same reason.
  agnescodePublisher?.dispose();
  agnescodePublisher?.release?.();
  // Stop offering the provider first, so a request cannot be routed to an
  // adapter whose Host services are already half gone.
  releaseProvider();
  for (const off of offs) {
    try {
      off();
    } catch {
      // The web server may already be gone during shutdown.
    }
  }
}