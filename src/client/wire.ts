/**
 * The snapshot wire contract, as the Host actually builds it.
 *
 * Every type here mirrors a field the Host's `buildSnapshotBody` returns
 * (see `src/host/snapshot-aggregate.ts`); keeping them in the client half
 * is a deliberate duplication CONSTRAINT: the client bundles unbuilt, so it
 * cannot import the Host's types, and `test/contract.test.mjs` asserts the
 * snapshot's key shape against the same names.
 *
 * The shapes stay forgiving on purpose: a missing field must render as
 * "no data yet", never throw — so every property is optional, and reading
 * code falls back with `??` / `Array.isArray` exactly as the pre-split
 * closure did. Types are loaded, never enforced at runtime.
 */

/**
 * One quota window as the PLAN caps it — "N per W hours", not a balance.
 *
 * Agnes allocates no credits: it rate-limits four dimensions over sliding
 * windows. `used` and `remaining` are therefore OPTIONAL and usually absent —
 * the console reports cumulative usage, not a per-window balance, and a
 * computed `limit - total` would compare two different periods. The card shows
 * them only when the platform itself stated them.
 */
export interface QuotaWindowData {
  /** `requests5h` | `requestsWeekly` | `imagesDaily` | `videoDaily`. */
  key?: string;
  /** `requests` | `images` | `video` — what the number counts. */
  unit?: string;
  limit?: number;
  /** The window length the limit applies over. */
  windowHours?: number;
  used?: number | null;
  remaining?: number | null;
}

/** One plan, as the quota screen reads it. */
export interface PlanData {
  uuid?: string;
  planId?: number;
  name?: string;
  displayName?: string;
  billingCycle?: string;
  displayCycle?: string;
  priceMinor?: number;
  currency?: string;
  /** The platform's own one-line summary, e.g. "1500 次模型请求 / 5 小时". */
  usageLimitText?: string;
  limits?: {
    requests5h?: number;
    requestsWindowH?: number;
    requestsWeekly?: number;
    imagesDaily?: number;
    videoDaily?: number;
  };
}

/**
 * Consumption figures, from either the account total or the charted window.
 *
 * Both sources use the SAME key names on purpose, so one component renders
 * either without a translation step — the label says which period it covers.
 */
export interface UsageTotalsData {
  totalRequests?: number;
  totalTokens?: number;
  totalImages?: number;
  totalVideoSeconds?: number;
  activeDays?: number;
}

/** One time bucket of the usage series. */
export interface UsageBucketData {
  /** The platform's own bucket label (a date, at the granularity it chose). */
  bucket?: string;
  requestCount?: number;
  textTokens?: number;
  imageCount?: number;
  videoSeconds?: number;
}

/** The `quota` block: the current plan, its windows, and the account totals. */
export interface QuotaData {
  plan?: PlanData | null;
  windows?: QuotaWindowData[];
  /**
   * Cumulative account usage. NOT a per-window balance — see `QuotaWindowData`.
   *
   * `null` (or absent) means the Host could not read it, which the panel
   * renders as "not read yet". It must never be a zeroed block: a `0` there
   * would present an unread figure as a measurement.
   */
  totals?: UsageTotalsData | null;
  /** The public plan catalogue (needs no login) — what upgrading would buy. */
  plans?: PlanData[];
  expiresAt?: number | null;
  /**
   * Whether the authenticated console half answered at all.
   *
   * `false` means every authenticated source is missing and `plans` — the
   * PUBLIC catalogue, which needs no login — is the only quota content there
   * is. The panel says so rather than letting the absence read as "you have
   * used nothing". Distinct from `auth.configured`: an account that is
   * configured while the platform is down is `consoleConnected:false` with
   * `configured:true`, and the two want different advice.
   */
  consoleConnected?: boolean;
  /** Why the authenticated half is missing, when it is. */
  error?: { source?: string; code?: string | null; message?: string } | null;
}

/** The `usage` block: the charted window and its buckets. */
export interface UsageData {
  days?: number;
  windowTotals?: UsageTotalsData;
  buckets?: UsageBucketData[];
}

/** One catalogue entry the roster/picker offers. */
export interface ModelData {
  id?: string;
  name?: string;
  vision?: boolean;
  available?: boolean;
  quotaExhausted?: boolean;
  /** Positive window from `contextWindowOf`: declared value or the 128k fallback. */
  contextWindow?: number;
  /** Platform-declared output ceiling from `max_output_length`; 0/absent = unknown. */
  maxOutputLength?: number;
  /** Operator pseudo multiplier (×N); absent when no config key matched. */
  multiplier?: number;
  /** Thinking levels the DSH selector offers for this model, escalation order. */
  thinkingLevels?: string[];
}

/** One vision model line: the id, its capability, and the evidence source. */
export interface VisionModelData {
  id: string;
  vision: boolean;
  source?: "field" | "name" | null;
}

/** The `auth` block: token-state booleans the panel turns into guidance. */
export interface AuthData {
  configured?: boolean;
  hasAccount?: boolean;
  autoRecoverArmed?: boolean;
  hasRefreshToken?: boolean;
  expiresAt?: number | null;
  needsAccount?: boolean;
  ephemeral?: boolean;
  retryAfterMs?: number | null;
  needsUserAction?: boolean;
  error?: string | null;
}

/** The `llm` block: key presence, registration state, and the roster. */
export interface LlmData {
  hasApiKey?: boolean;
  keySource?: string | null;
  ephemeral?: boolean;
  registerProvider?: boolean;
  registerSource?: string;
  llmAvailable?: boolean;
  providerRegistered?: boolean;
  providerId?: string;
  modelCount?: number;
  visionCount?: number;
  /** Thinking effort the profile pins as DSH's "Default" (same constant the adapter dispatches). */
  thinkingDefault?: string;
  models?: ModelData[];
  enabledModelIds?: string[];
  quotaBlockedModelIds?: string[];
  providerError?: string;
  drawEnabled?: boolean;
  drawSource?: string;
  drawModel?: string;
  drawCandidateCount?: number;
  drawCandidateIds?: string[];
  drawPreferredModel?: string;
  /**
   * The video tool. `videoCandidateIds` lists EVERY video model in the
   * catalogue — both the V2.0 family (`width`/`height`/`num_frames`/
   * `frame_rate` body) and the 2.5 family (`mode`/`seconds`/`size`/
   * `aspect_ratio` body) — because the tool drives both and builds the
   * matching body per model. `video25ModelIds` carries the 2.5 subset so
   * the card can name it as the seconds/size/aspect family the tool adapts
   * to automatically.
   */
  videoEnabled?: boolean;
  videoSource?: string;
  videoModel?: string;
  videoCandidateCount?: number;
  videoCandidateIds?: string[];
  video25ModelIds?: string[];
  videoPreferredModel?: string;
}

/** One shape-drift report line, keyed by upstream contract. */
export interface ShapeWarningData {
  api?: string;
  missing?: string;
}

/**
 * The whole snapshot body `buildSnapshotBody` returns, as the panel reads it.
 *
 * `pollSeconds`/`cacheSeconds` are quoted into the header and footnote;
 * `auth` drives the self-renew chip; `quota`/`usage` are the two content
 * sections; `llm` is the setup tab; the rest are banner lines.
 */
export interface SnapshotData {
  ok?: boolean;
  now?: number;
  consoleBase?: string;
  cacheSeconds?: number;
  pollSeconds?: number;
  auth?: AuthData | null;
  catalogAvailable?: boolean;
  catalogModels?: string[];
  visionModels?: VisionModelData[];
  llm?: LlmData | null;
  quota?: QuotaData | null;
  usage?: UsageData | null;
  shapeWarnings?: ShapeWarningData[];
}
