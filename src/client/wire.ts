/**
 * The snapshot wire contract, as the Host actually builds it.
 *
 * Every type here mirrors a field the Host's `buildSnapshotBody` returns
 * (see `src/host/snapshot-aggregate.ts`); keeping them in the client half
 * is a deliberate duplication CONSTRAINT: the client bundles unbuilt, so it
 * cannot import the Host's types. `test/contract.test.mjs` §10 holds the two
 * ends together — it parses this file's `SnapshotData` keys and the Host's
 * return literal, and fails when the Host serves a key that is declared
 * nowhere here.
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
 * windows. `used` comes from the console's own `subscription.usage` report
 * (the platform's per-window figure, quoted verbatim). The card draws a bar
 * only when `used` is present.
 */
export interface QuotaWindowData {
  /** `requests5h` | `requestsWeekly` | `imagesDaily` | `videoDaily`. */
  key?: string;
  /** `requests` | `images` | `video` — what the number counts. */
  unit?: string;
  limit?: number;
  /** The window length the limit applies over. */
  windowHours?: number;
  /** The platform's per-window consumption figure. */
  used?: number | null;
  /** The platform's own percentage, when it sent one. */
  usagePct?: number | null;
  /** The window's bounds, epoch seconds (Asia/Shanghai). */
  rangeStart?: number | null;
  rangeEnd?: number | null;
  /** When this window resets, epoch seconds. */
  resetAt?: number | null;
  /** Seconds until the window resets, as the platform counts them down. */
  resetInSeconds?: number | null;
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
  source?: "field" | "name" | "docs" | null;
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
 * One AgnesCode model row, as the `/agnescode` route reports it.
 *
 * Declared HERE rather than in the tab that renders it: the tab owns no wire
 * contract of its own, and `test/contract.test.mjs` §11 holds this
 * declaration and the Host's route body together the way §10 holds
 * `SnapshotData`.
 */
export interface AgnescodeModelData {
  id?: string;
  name?: string;
  vision?: boolean;
  memberOnly?: boolean;
  contextWindow?: number;
  maxOutputLength?: number;
}

/** One harvest-diagnosis row: a tier code and shape facts, never a value. */
export interface AgnescodeHarvestAttemptData {
  file?: string | null;
  tier?: string;
  detail?: string;
}

/**
 * The publish gate's "switch ON, no token yet" answer.
 *
 * It is the EXPECTED state between ticking the switch and running the
 * harvest, so the tab renders it as a quiet instruction rather than an alert
 * — a distinction that is a wire fact, not a UI opinion, hence a constant
 * here.
 */
export const AGNESCODE_ERROR_NOT_CONFIGURED = "not_configured";

/** The harvest tier for a session that decrypted and carried a token. */
export const AGNESCODE_TIER_OK = "ok";

/**
 * The secret-free state the `/agnescode` route answers, as the tab reads it.
 *
 * `ok`, `enabled`, `switchSource` and the harvest diagnosis are the route's
 * own answers; the credential half (`loggedIn` / `nickname` / `bffBase` /
 * `expiresAtMs`) is what the harvested session file contained, and
 * `balance` / `models` / `enabledModelIds` are the credit pool and roster.
 * Nothing here is a value worth protecting — the route never sends the token.
 */
export interface AgnescodeStateData {
  ok?: boolean;
  enabled?: boolean;
  switchSource?: string;
  loggedIn?: boolean;
  nickname?: string;
  bffBase?: string;
  expiresAtMs?: number | null;
  balance?: {
    totalBalance?: number;
    timeSensitiveBalance?: number;
    permanentBalance?: number;
  } | null;
  models?: AgnescodeModelData[];
  enabledModelIds?: string[];
  providerRegistered?: boolean;
  providerError?: string;
  harvest?: { ok?: boolean; attempts?: AgnescodeHarvestAttemptData[] };
  error?: string;
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
