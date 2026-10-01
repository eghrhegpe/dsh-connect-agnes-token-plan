/**
 * Shared structural types for the Host half.
 *
 * The Host wires its modules together with an injected dependency object
 * (`HostDeps`). That object is built once in `index.ts` from the Cordis
 * context and passed down; the runtime fields are many and come from peers
 * that ship no `.d.ts`, so the single source of truth for "what a dep may
 * carry" lives here rather than in per-file `{}` placeholders (which TS
 * reads as an empty object and then rejects every field access on).
 * @module dsh-connect-agnes-token-plan/types
 */

/** A failure code this plugin can produce or carry (a `CODE` wire value). */
export type CodeValue = string;

/**
 * The dependency bag injected into the Host modules. Every field is optional:
 * each consumer falls back to a local default when a field is absent, so a
 * module keeps working even if `index.ts` does not wire a given capability.
 * Peer-typed members (`logger`, `emit`, …) use loose types because the
 * matching `@deepseek-ai/*` packages ship no declarations in this repo.
 */
export interface HostDeps {
  /** Resolved plugin settings object. */
  settings?: any;
  /** Toggle that flips the sidebar panel on/off from the Host. */
  panelSwitch?: any;
  /** Lazy-load the LLM adapter module (peer `dsh-llm-pi-ai`). */
  loadAdapterModule?: any;
  /** Lazy-load the AgnesCode LLM adapter module (ROADMAP §6.3 third provider). */
  loadAgnescodeAdapterModule?: any;
  /** Resolve the registered LLM instance. */
  getLlm?: any;
  /** Resolve the API key from the credentials service. */
  resolveApiKey?: any;
  /** Cordis event emitter. */
  emit?: (...args: any[]) => void;
  /** Cordis logger (loose: peer has no declarations here). */
  logger?: any;
  /** Lazy-load the tools module. */
  loadToolsModule?: any;
  /** Host webserver fetch used by the draw route. */
  drawFetch?: (...args: any[]) => Promise<any>;
  /** Host webserver fetch used by the video route (mirrors `drawFetch`). */
  videoFetch?: (...args: any[]) => Promise<any>;
  /** Login-trace sink used by the auth half. */
  onTrace?: (...args: any[]) => void;
  /** The resolved credential record. */
  credential?: any;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** JWKS endpoint override. */
  jwksEndpoint?: string;
  /** Encryption key id used by the JWE sealer. */
  encKeyId?: string;
  /** Base URL override for the LLM adapter / provider config. */
  baseUrl?: string;
  /** Shared JWKS cache. */
  cache?: any;
  /** Max redirect hops for the login trace. */
  maxHops?: number;
  /** Login request timeout in milliseconds (config alias). */
  requestTimeoutMs?: number;
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
}

/** Options for the JWKS cache / JWE sealer. */
export interface JwksOptions {
  /** A caller-owned key-set cache; typed loosely (see createJwksCache). */
  cache?: any;
  jwksEndpoint?: string;
  encKeyId?: string;
  timeoutMs?: number;
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
}

/** Options for the AgnesCode adapter factory (`agnescode-llm-adapter.ts`). */
export interface AgnescodeAdapterOptions {
  /** The roster rows to offer (`agnescodeRoster` result). */
  rows?: any[];
  /** The credential's pinned per-account BFF base (`bffPublicBaseUrl`). */
  bffBase?: string;
  /** Resolve the live AgnesCode JWT per request (re-harvested when expired). */
  resolveToken?: () => Promise<string>;
  /** Service resolver (reserved for the image hooks). */
  get?: (service: string) => any;
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
