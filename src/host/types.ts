/**
 * Shared structural types for the Host half.
 *
 * The Host's modules talk to each other through named types declared here
 * rather than through an untyped bag: `HostCtx` for the Cordis service bag the
 * routes read, and one `*Deps` per injectable seam (`ProviderPublisherDeps`,
 * `AgnescodePublisherDeps`). Peer-typed members stay loose because the matching
 * `@deepseek-ai/*` packages ship no `.d.ts` in this repo — the single source of
 * truth for "what a seam may carry" lives here rather than in per-file `{}`
 * placeholders (which TS reads as an empty object and then rejects every field
 * access on).
 * @module dsh-connect-agnes-token-plan/types
 */

import type { createTokenStore } from "./token-store.ts";
import type { createApiKeyStore } from "./api-key-store.ts";
import type { createFileCatalogStore } from "./catalog-store.ts";
import type { createFileProviderStore } from "./provider-store.ts";
import type { createFileDrawStore } from "./draw-store.ts";
import type { createFileVideoStore } from "./video-store.ts";
import type { createProviderPublisher } from "./provider-publish.ts";
import type { PublisherLogger } from "./publish-core.ts";
import type { CatalogEffects } from "./catalog-refresh.ts";
import type { fetchModelCatalog } from "./console-client.ts";
import type { createAgnescodeStore } from "./agnescode-store.ts";
import type { createFileAgnescodeStore, createFileAgnescodeDesktopSourceStore } from "./agnescode-switch-store.ts";
import type { createFileAgnescodeModelsStore } from "./agnescode-models-store.ts";
import type { createFileAgnescodeRosterSeenStore } from "./agnescode-roster-seen-store.ts";
import type { wireAgnescodePublisher } from "./agnescode-lifecycle.ts";

/** A failure code this plugin can produce or carry (a `CODE` wire value). */
export type CodeValue = string;

/**
 * The third argument of `apply()` — TEST-ONLY seams, not the plugin's
 * dependency list. The real Loader passes nothing here; the offline suites use
 * it to substitute the peer adapter / tools modules and the draw/video
 * fetches. Every field is optional, and a missing seam falls back to the real
 * module (or the Host's own fetch) at its point of use.
 *
 * Narrow on purpose. It used to also carry the provider publisher's inputs
 * (`settings`, `panelSwitch`, `getLlm`, `resolveApiKey`, `emit`, `logger`) plus
 * a row of auth/transport leftovers (`onTrace`, `credential`, `timeoutMs`,
 * `headers`, `baseUrl`, `requestTimeoutMs`). None of them had a reader: the
 * publisher took them through this type only because there was no type of its
 * own, and it now has one (`ProviderPublisherDeps`); the auth half resolves its
 * settings from the row, and the console client owns its transport. A field
 * listed here promises an injection point, so the unread ones are gone rather
 * than left to promise something that does not exist.
 */
export interface HostDeps {
  /** Lazy-load the LLM adapter module (peer `dsh-llm-pi-ai`). */
  loadAdapterModule?: any;
  /** Lazy-load the AgnesCode LLM adapter module (ROADMAP §6.3 third provider). */
  loadAgnescodeAdapterModule?: any;
  /** Lazy-load the tools module. */
  loadToolsModule?: any;
  /** Host webserver fetch used by the draw route. */
  drawFetch?: (...args: any[]) => Promise<any>;
  /** Host webserver fetch used by the video route (mirrors `drawFetch`). */
  videoFetch?: (...args: any[]) => Promise<any>;
  /**
   * Host webserver fetch used by the `/agnescode` route's two BFF reads
   * (mirrors `drawFetch`). Injected so the route's account-keyed cache and
   * single-flight can be driven by a COUNTING stub — the de-duplication is a
   * claim about how many calls reach the BFF, and only a stub can count them.
   */
  agnescodeFetch?: (...args: any[]) => Promise<any>;
  /**
   * The catalog store, injected by the tests so a `replace`/`setEnabledIds`
   * whose write fails can be driven end to end (PITFALLS §40: the publish
   * signature must not advance past a swallowed write failure).
   */
  catalogStore?: any;
  /**
   * The `/v1/models` fetch, injected by the tests (ADR-015).
   *
   * The catalogue's refresh moved out of the snapshot route and into a Host
   * tick, so the branch "cache expired → fetch → persist → republish" is no
   * longer reachable by calling a route with a stubbed `fetch`. This seam is
   * what lets the offline suite drive that branch — including "the fetch
   * failed", which must leave the persisted catalogue and the registration
   * exactly as they were.
   */
  fetchCatalog?: any;
  /**
   * The INTL row's catalog store (ADR-021), injected the same way the CN one
   * is: so the INTL row's swallowed-write path can be driven end to end by
   * the offline suites. Absent (the ordinary case) the row builds its own
   * file-backed store under `catalog.intl.json`. Typed against the real
   * store (not the CN seam's `any`) so the INTL row's surface is the same
   * shape the wiring bag carries, and the `any` budget stays untouched.
   */
  intlCatalogStore?: ReturnType<typeof createFileCatalogStore> | undefined;
  /**
   * The INTL row's `/v1/models` fetch (ADR-021), the INTL twin of
   * {@link fetchCatalog}: the offline suites point it at a stub so the INTL
   * row's refresh branches run without a network.
   */
  intlFetchCatalog?: typeof fetchModelCatalog | undefined;
}

/**
 * The host root context the Host modules read: the Cordis service bag.
 *
 * Loose on `get` because the matching `@deepseek-ai/*` packages ship no
 * declarations in this repo; the members the Host actually touches are named.
 * Declared here rather than per-module so `lifecycle.ts` and the routes family
 * share one shape — an untyped `ctx` is how a renamed service escapes the
 * compiler.
 */
export interface HostCtx {
  get(service: string): any;
  /**
   * The host tools service. `register` returns a DISPOSER (`() => void`) that
   * unregisters the tool — the same contract the sibling workbuddy plugin types
   * as `register(definition): () => void`. A host that returns `undefined`
   * (no unregister path) degrades to the old mount-once behavior: we keep the
   * disposer we got and simply cannot unmount, but the tool still mounts.
   */
  tools?: { register(definition: unknown): (() => void) | undefined } | null;
  effect(callback: () => () => void, label?: string): void;
  /**
   * The Cordis event emitter `apply` and the publisher seams call
   * (`llm/adapters-updated` after a registration). Loose on the event shape
   * because the peer ships no declarations here; a `Host` that lacks it is a
   * no-op, never a crash.
   */
  emit?(event: string): void;
  /**
   * The Host logger. REQUIRED, not a probe: `apply` reads it unconditionally to
   * hand the publisher seams and the routes their `ctx.logger`, so a Host
   * without one cannot mount this plugin. The degrade paths that survive a
   * missing service read OPTIONAL services through `getService`, never the
   * logger. Loose on the shape (the peer ships no declarations), shared with
   * the publisher seams via `PublisherLogger`.
   */
  logger: PublisherLogger;
  /**
   * The Host web server every route registers on. REQUIRED (not optional like
   * the probes above): a route module cannot do anything without it, and a
   * `webServer?` would force a null-check that duplicates the fact that the
   * Host always provides it. Loose on the route shape — the peer ships no
   * declarations — but the member the routes actually touch is named, and
   * `register` is declared to return the `off()` callback it really returns.
   */
  webServer: {
    register(route: {
      kind: string;
      path: string;
      handler: (request: any, response: any) => unknown;
    }): () => void;
  };
}

/** Options every file-backed store accepts. */
export interface StoreOptions {
  /** Profile key; stores are segmented per profile. */
  profile?: string | null;
  /** Clock override for tests. */
  now?: () => number;
  /** Idle entry TTL in milliseconds. */
  ttlMs?: number;
  /** Directory the store persists into. */
  dir?: string;
  /**
   * The file name inside the state directory (ADR-021): the catalog store
   * takes `catalog.intl.json` for the INTL row, the throttle store
   * `throttle.intl.json`. Every store without a `file` option keeps its own
   * name, so the option is read only where it is declared.
   */
  file?: string;
}

/** A draw (image generation) request body. */
export interface DrawRequest {
  model: string;
  prompt: string;
  n: number;
  size: string;
  responseFormat: string;
  /** Aspect ratio (e.g. "16:9"); forwarded under `extra_body.ratio` (Agnes dialect). */
  ratio?: string;
  /** Reference image URLs / Data URIs for img2img; forwarded as `extra_body.image`. */
  image?: string[];
  /** Request Base64 output instead of a URL (text2img only); forwarded as `extra_body.return_base64`. */
  returnBase64?: boolean;
}

/** A provider/adapter configuration object. */
export interface AdapterConfig {
  providerId?: string;
  enabledIds?: string[];
  unavailableModelIds?: string[];
  baseUrl?: string;
  /**
   * Exact model id → output ceiling (AgnesCode route only; already sanitized by
   * `host-config.resolveMaxTokensOverrides`, so every value here is a positive
   * integer). Absent or empty = the roster's own figures are authoritative.
   */
  maxTokensOverrides?: Record<string, number>;
}

/**
 * Dependency bag for the Token Plan provider publisher (`provider-publish.ts`).
 *
 * Deliberately NOT `HostDeps`: that one is the wide bag `apply()` receives, and
 * handing it to a consumer that reads six fields means every field it reads is
 * `any` — the compiler cannot catch a settings key that was renamed or never
 * existed. `AgnescodePublisherDeps` next door already draws this line for the
 * sibling publisher; this is the same line drawn for the main one.
 */
export interface ProviderPublisherDeps {
  /**
   * The resolved settings row. Read for `registerProvider` (the switch's config
   * default) and `apiBase` (what the adapter is built against) only — `Partial`
   * because `apply()` may pass none at all, and every reader here falls back.
   */
  settings?: Partial<Settings>;
  /** Panel-saved switch value; `null` = state file untouched (falls back to the config default). */
  panelSwitch?: () => Promise<boolean | null>;
  /** Lazy-load the adapter factory module (peer `dsh-llm-pi-ai`). */
  loadAdapterModule?: () => Promise<{ createAgnesAdapter: (...args: any[]) => any }>;
  /** Optional-service resolver for the `llm` registration service. */
  getLlm?: (service: string) => any;
  /**
   * Resolve the live `sk-` key per request (the `api-key-store.ts` seam). The
   * adapter factory reads it, so it must be a real resolver, never a snapshot.
   */
  resolveApiKey?: () => Promise<string>;
  /** Cordis event emitter for `llm/adapters-updated`. */
  emit?: (event: string) => void;
  /** Cordis logger for the build-failure warning (shared shape with the sibling publisher). */
  logger?: PublisherLogger;
  /**
   * Which provider row this publisher registers (ADR-021). Absent = the CN
   * row (the exact pre-ADR-021 publisher); the INTL row passes
   * `{ id: LLM_PROVIDER_ID_INTL, name: LLM_DISPLAY_NAME_INTL }` and the
   * factory builds that row's descriptors, directory entry and release path.
   */
  provider?: { id: string; name: string };
}

/** Dependency bag for the AgnesCode provider publisher (`agnescode-publish.ts`). */
export interface AgnescodePublisherDeps {
  /** Panel-saved switch value; `null` = state file untouched (provider stays OFF). */
  panelSwitch?: () => Promise<boolean | null>;
  /** Resolve the live AgnesCode JWT per request (empty when not harvested). */
  resolveToken?: () => Promise<string>;
  /** Optional-service resolver for the `llm` registration service. */
  getLlm?: (service: string) => any;
  /** Lazy-load the AgnesCode adapter factory module (peer `dsh-llm-pi-ai`). */
  loadAdapterModule?: () => Promise<{ createAgnescodeAdapter: (...args: any[]) => any }>;
  /** Cordis event emitter for `llm/adapters-updated`. */
  emit?: (event: string) => void;
  /** Cordis logger (loose: the peer ships no declarations here). */
  logger?: { warn: (message: string) => void };
  /**
   * The resolved settings row, read for `maxTokensOverrides` only. `Partial`
   * for the same reason {@link ProviderPublisherDeps.settings} is: `apply()` may
   * pass none, and the reader falls back to "no overrides".
   */
  settings?: Partial<Settings>;
}

/** Options for the AgnesCode adapter factory (`agnescode-llm-adapter.ts`). */
export interface AgnescodeAdapterOptions {
  /** The roster rows to offer (`agnescodeRoster` result). */
  rows?: any[];
  /** The credential's pinned per-account BFF base (`bffPublicBaseUrl`). */
  bffBase?: string;
  /** Resolve the live AgnesCode JWT per request (re-harvested when expired). */
  resolveToken?: () => Promise<string>;
  /** Service resolver for the image hooks (`attachments`, `fs`). */
  get?: (service: string) => any;
  /**
   * Exact model id → output ceiling (the operator's `maxTokensOverrides`, already
   * sanitized). Absent or empty = the roster rows' own `maxOutputLength` stands.
   */
  maxTokensOverrides?: Record<string, number> | null;
}

/**
 * An `Error` with the stable `code` the panel branches on, plus optional
 * structured fields. The fields are attached at runtime (not inherited), so
 * this is a structural annotation: a `catch (e)` downstream may read `e.code`.
 */
export interface PluginError extends Error {
  code?: CodeValue;
  retryAfterMs?: number;
  detail?: unknown;
  trace?: unknown[];
}

// ---------------------------------------------------------------------------
// Wiring / options shapes. Annotating a parameter with one of these clears the
// "injected dependency bag" family of implicit-any errors in one place rather
// than one binding at a time; each field mirrors a real runtime shape (the
// wiring object `apply()` builds, the tool mount bag, the settings row), so the
// type is derived rather than guessed.
// ---------------------------------------------------------------------------

/** Operator login-flow overrides, exactly the keys `host-config.ts` writes. */
export interface AuthOverrides {
  consoleOrigin: string;
  loginPath?: string;
  requestTimeoutMs?: number;
  fallbackExpiresInSeconds?: number;
}

/**
 * The plugin's resolved settings row (`resolveSettings`).
 *
 * Structural on purpose: consumers read only the fields they need, and the row
 * is built from the operator's patch config, so this is the contract the Host
 * half consumes rather than a description of how the row is produced.
 */
export interface Settings {
  consoleBase: string;
  apiBase: string;
  /** The INTL site's console origin (ADR-021); inert unless `registerProviderIntl`. */
  consoleBaseIntl: string;
  /** The INTL site's gateway base (ADR-021); inert unless `registerProviderIntl`. */
  apiBaseIntl: string;
  usageDays: number;
  cacheSeconds: number;
  pollSeconds: number;
  consoleTimeoutMs: number;
  tokenSkewSeconds: number;
  allowedHosts: Set<string>;
  trendMultipliers: Record<string, number>;
  registerProvider: boolean;
  /** The INTL site's registration opt-in (ADR-021); off = the whole INTL half is inert. */
  registerProviderIntl: boolean;
  /** Exact model id → AgnesCode output ceiling; empty = the roster is authoritative. */
  maxTokensOverrides: Record<string, number>;
  drawEnabled: boolean;
  drawModelId: string;
  drawTimeoutMs: number;
  videoEnabled: boolean;
  videoModelId: string;
  videoTimeoutMs: number;
  videoWidth: number;
  videoHeight: number;
  videoNumFrames: number;
  videoFrameRate: number;
  writeImageModelIds: boolean;
  imageModelIds: string[];
  visionModels: unknown[];
  auth: AuthOverrides;
}

/** One console-response cache entry (`{body, at}`). */
export interface CacheEntry {
  body: unknown;
  at: number;
}

/** The console-response cache shared across polls. */
export type CacheMap = Map<string, CacheEntry>;

/** The single-flight map: one in-flight console call per URL. */
export type InflightMap = Map<string, Promise<unknown>>;

/**
 * A panel-saved switch store's FULL surface, as `createSwitchStore` returns it
 * (`draw-store` / `video-store`): the panel's live value always beats the
 * config default, and an untouched state file reports `null` so the caller
 * falls back to it.
 *
 * The write half (`save` / `saveModel`) is part of the interface because the
 * switch routes call it; leaving it out only pushed that fact into an implicit
 * `any`. `createFileProviderStore` deliberately exposes a SUBSET (on/off only,
 * no model preference) and is typed by its own factory — do not widen either
 * one to fit the other.
 */
export interface SwitchStore {
  enabled(): Promise<boolean | null>;
  modelId(): Promise<string | null>;
  isSet(): Promise<boolean>;
  save(value: unknown): Promise<void>;
  forget(): Promise<void>;
  saveModel(value: string | null): Promise<void>;
  forgetModel(): Promise<void>;
}

/**
 * The fetch these modules perform. `RequestInit` matches every call site (the
 * JSON header / bearer / body objects they build); the return is loose because
 * tests stub a minimal `{ok, json, text}` response.
 */
export type FetchFn = (url: string, options?: RequestInit) => Promise<any>;

/**
 * The bag `createToolMount` hands `defineDrawTool` / `defineVideoTool`.
 *
 * Pure wiring: every side effect (key resolution, the live catalog, the fetch,
 * disposal) is injected rather than read from module state. Loose on the peer
 * edges (`defineTool`, `fetchImpl`) because the matching `@deepseek-ai/*`
 * packages ship no declarations here.
 */
export interface ToolWiring {
  /** The peer's tool factory (`dsh-tools`). */
  defineTool: (...args: any[]) => any;
  /** Resolve the live `sk-` key (empty when not configured). */
  resolveApiKey: () => Promise<string | undefined>;
  /** Read the discovery set at call time (the catalog, not the picker). */
  getEntries: () => Promise<unknown[]>;
  settings: Settings;
  fetchImpl: FetchFn;
  /** `true` after unmount, so a late call fails instead of leaking. */
  isDisposed?: () => boolean;
}

/** The mount-time test seams `apply`'s `deps` inject (`startSideEffects`). */
export interface ToolSide {
  loadToolsModule?: () => any;
  drawFetch: FetchFn;
  videoFetch: FetchFn;
}

/**
 * The live mount handle for ONE agent tool (the draw or video tool).
 *
 * A tool now mounts and unmounts WITHOUT a Host restart: the panel switch route
 * re-runs {@link ToolMount.sync} after it writes the state file, and the host
 * `tools.register` returns a disposer that the mount keeps so a later
 * `sync()` can unmount. `sync` is idempotent and serialized — calling it in any
 * order (mount-time seed, a switch POST, a model POST, a forget) converges to
 * the same live state, and a host without a tools service simply leaves the
 * tool unmounted rather than crashing.
 */
export interface ToolMount {
  /** Reconcile the live tool with the current effective switch value. Safe to call repeatedly. */
  sync(): Promise<void>;
  /** Unmount a live tool and close the handle for good (teardown); later `sync()` is a no-op. */
  dispose(): void;
  /** Whether the tool is currently registered with the host. */
  isMounted(): boolean;
}

/**
 * The wiring bag `apply()` assembles once at mount and hands to the routes and
 * the side effects. Store / publisher members are derived from their factory
 * return types so a renamed method cannot silently drift from the type.
 */
export interface HostWiring {
  settings: Settings;
  configError: string | null;
  cache: CacheMap;
  inflight: InflightMap;
  tokenStore: ReturnType<typeof createTokenStore>;
  apiKeyStore: ReturnType<typeof createApiKeyStore>;
  catalogStore: ReturnType<typeof createFileCatalogStore>;
  /**
   * The catalogue's ONE writer: persist + provider rebuild, serialized. The
   * snapshot route and the Host's own refresh tick both go through it, which is
   * what keeps "the browser is the clock" from coming back (ADR-015).
   */
  catalogEffects: CatalogEffects;
  providerStore: ReturnType<typeof createFileProviderStore>;
  drawStore: ReturnType<typeof createFileDrawStore>;
  videoStore: ReturnType<typeof createFileVideoStore>;
  publisher: ReturnType<typeof createProviderPublisher>;
  providerState: ReturnType<typeof createProviderPublisher>["state"];
  publishProvider: (entries: any[], enabledIds: string[], unavailableModelIds?: any[]) => unknown;
  releaseProvider: () => unknown;
  resolveApiKey: () => Promise<string | undefined>;
  /**
   * The INTERNATIONAL site's row (ADR-021): the second, co-existing provider
   * registration — its own catalog record (`catalog.intl.json`), its own key
   * reference (`AGNES_TOKEN_PLAN_INTL_API_KEY`), its own console grant
   * (`agnes-console-intl`) and publisher (`LLM_PROVIDER_ID_INTL`). Every
   * slot is optional: a test wiring that predates ADR-021 leaves them unset
   * and the snapshot's `intl` block simply stays absent, exactly like the
   * agnescode slots below. The two rows share nothing mutable — a site's
   * state never feeds the other site's publisher, catalog, grant or key.
   */
  // `| undefined` is spelled out (not just `?`) because the tsconfig's
  // `exactOptionalPropertyTypes` refuses a plain `| undefined` value written
  // into a bare optional property, and the wiring bag is built with values
  // that genuinely may be undefined (an inactive row).
  intlApiKeyStore?: ReturnType<typeof createApiKeyStore> | undefined;
  intlCatalogStore?: ReturnType<typeof createFileCatalogStore> | undefined;
  intlTokenStore?: ReturnType<typeof createTokenStore> | undefined;
  intlPublisher?: ReturnType<typeof createProviderPublisher> | undefined;
  releaseIntlProvider?: (() => unknown) | undefined;
  /** The INTL catalogue's one writer, when the row is active (ADR-021). */
  intlCatalogEffects?: CatalogEffects | undefined;
  visionPublish: { current: ((visionEntries: unknown[], ids: string[]) => Promise<void>) | null };
  logger?: {
    warn?: (message: string, ...rest: unknown[]) => void;
    error?: (message: string, ...rest: unknown[]) => void;
    info?: (message: string, ...rest: unknown[]) => void;
  };
  agnescodeStore: ReturnType<typeof createAgnescodeStore>;
  agnescodeSwitch: ReturnType<typeof createFileAgnescodeStore>;
  /**
   * The AgnesCode desktop-SOURCE switch (ADR-020): the read-only view of the
   * desktop App's session file that `createAgnescodeStore` consults per read
   * when this switch resolves ON. The `/agnescode` route's `desktop-source`
   * action writes it. Absent (a test wiring that predates it) the store never
   * consults a view — the slot answers `resolve()` alone, exactly as before.
   */
  agnescodeDesktopSource?: ReturnType<typeof createFileAgnescodeDesktopSourceStore>;
  agnescodeModels?: ReturnType<typeof createFileAgnescodeModelsStore>;
  /**
   * The AgnesCode roster's first-sighting history (`agnescode-roster-seen-store.ts`) —
   * the `/agnescode` status route's source for `newModelIds`. Absent (a test or a
   * Host that gave nothing) the field simply stays off: the marker is a suggestion
   * the pill renders, not a fact the tab needs.
   */
  agnescodeRosterSeen?: ReturnType<typeof createFileAgnescodeRosterSeenStore>;
  agnescodePublisher: ReturnType<typeof wireAgnescodePublisher>["publisher"];
  /** The fetch the `/agnescode` route's two BFF reads use (see `HostDeps`). */
  agnescodeFetch?: (...args: any[]) => Promise<any>;
  /**
   * The live mount handle for the `agnes_draw_image` tool, filled by
   * `startSideEffects` (`lifecycle.ts`) after the wiring is built. The switch
   * route reads it to re-sync the tool after a write; teardown disposes it.
   * Consumers MUST read it LATE (a getter on this bag, resolved at commit
   * time), never snapshot it at route-registration time: `apply()` registers
   * the routes BEFORE `startSideEffects` fills this field, so a snapshot
   * taken there is `null` forever and the panel switch silently stops
   * converging the tool (PITFALLS §62, dead-toggle hot reload).
   */
  drawToolMount?: ToolMount | null;
  /** The live mount handle for the `agnes_video_generate` tool (same as `drawToolMount`). */
  videoToolMount?: ToolMount | null;
}
