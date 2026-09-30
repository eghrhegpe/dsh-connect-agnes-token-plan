/**
 * The directly-registered SenseNova provider's request-retry policy — the
 * peer-FREE half of the 429 self-healing work.
 *
 * Why a separate, peer-free module: the policy is handed to the Host's
 * `resolveRetryPolicy` (a peer import) inside `llm-adapter.ts`, but the
 * *decision* — which failure classes this shared-pool provider should retry,
 * and how gently — is pure and must stay unit-testable on a clean checkout
 * where the peer is not resolvable. Keeping the config here means
 * `test/retry.test.mjs` can pin its shape without importing `@deepseek-ai/dsh-llm`.
 *
 * The peer already classifies a SenseNova 429 into two codes (verified in the
 * 429 spike, `dsh-llm-pi-ai/lib/indexts` `classifyPiAiError`):
 *
 *   - `QUOTA` / `ACCOUNT_QUOTA` — the Token Plan pool is depleted. Retrying
 *     cannot refill it, and because the pool is SHARED across every model on
 *     this key, hammering it only extends the cool-down window (the same
 *     lesson `st-rotator` bakes into its AIMD limiter). So we deliberately do
 *     NOT retry quota exhaustion — fast-fail and let the panel say why.
 *   - `RATE_LIMIT` — a transient throttle that clears on its own. The peer
 *     retries this by default, and we keep doing so, with a backoff biased
 *     longer than default so an immediate re-hit against the one shared pool
 *     is less likely. SenseNova's daytime rate ceiling (rpm/tpm) is aggressive
 *     (see `llm-error-fix.ts`: its `quota_exceeded_error` code 8 is actually a
 *     per-minute rate cap), so we ride it out with more attempts and a gentler
 *     initial step than the peer default.
 *
 * @module dsh-connect-sensenova-token-plan/llm-retry
 */

/**
 * The failure-class codes this provider reasons about, in peer-canonical
 * spelling.
 *
 * The strings mirror the `@deepseek-ai/dsh-llm` peer's error-code constants
 * (`QUOTA_EXCEEDED_CODE = "QUOTA"`, `ACCOUNT_QUOTA_EXCEEDED_CODE =
 * "ACCOUNT_QUOTA"`, `EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE"`). They are stable
 * protocol codes, not implementation details, so pinning them here is what the
 * qoder route does too; `llm-adapter.ts` still imports the live constants from
 * the peer and passes them through `resolveRetryPolicy`, so a peer rename would
 * surface at the adapter, not silently drift here.
 */
export const QUOTA_CODES = Object.freeze({
  /** Depleted Token Plan pool (per-pool quota). Not retried. */
  quota: "QUOTA",
  /** Depleted account-level quota. Not retried. */
  accountQuota: "ACCOUNT_QUOTA",
  /** Empty/truncated response. Retried. */
  emptyResponse: "EMPTY_RESPONSE",
  /** Transient throttle (429 rate). Retried with backoff. */
  rateLimit: "RATE_LIMIT",
  /** Upstream 5xx. Retried. */
  server: "SERVER",
  /** Request deadline exceeded. Retried. */
  timeout: "TIMEOUT",
  /** Connection-level failure. Retried. */
  transport: "TRANSPORT"
});

/**
 * The failure classes this provider retries, in peer-canonical order.
 *
 * Excludes both quota codes on purpose: a depleted pool cannot be retried into
 * health, and retrying it against a shared credit pool only prolongs the
 * cool-down. `RATE_LIMIT` stays — transient throttles self-clear.
 * @returns {string[]} the retryable code list (no duplicates, non-empty).
 */
export function retryableCodes() {
  return [
    QUOTA_CODES.emptyResponse,
    QUOTA_CODES.rateLimit,
    QUOTA_CODES.server,
    QUOTA_CODES.timeout,
    QUOTA_CODES.transport
  ];
}

/**
 * Build the provider's retry-policy config.
 *
 * The shape is exactly what `@deepseek-ai/dsh-llm`'s `resolveRetryPolicy`
 * accepts (`mode: "normal"` → `{ mode, maxRetries, retryableCodes, backoff }`).
 * We pin it explicitly rather than passing `undefined` so a future change to
 * the peer's default policy cannot silently alter this provider's behaviour.
 *
 * Tuned for SenseNova's daytime rate ceiling (rpm/tpm), which the peer mislabels
 * as `QUOTA` — `llm-error-fix.ts` pulls those back to `RATE_LIMIT` so they
 * reach this policy. The numbers: more attempts (8) and a gentler, longer
 * backoff than the peer default (initial 1.5s → cap 20s, jitter 0.25) so a
 * single shared credit pool is not stampeded while the rate window refills.
 * Still bounded: a genuine outage fails after ~90s of backed-off retries rather
 * than spinning forever. QUOTA stays excluded (a depleted pool cannot be retried
 * into health; retrying it only prolongs the cool-down — ROADMAP §1).
 * @returns {{mode: "normal", maxRetries: number, retryableCodes: string[], backoff: {initialDelayMs: number, maxDelayMs: number, jitterRatio: number}}}
 */
export function buildRetryPolicyConfig() {
  return {
    mode: "normal",
    maxRetries: 8,
    retryableCodes: retryableCodes(),
    backoff: {
      initialDelayMs: 1_500,
      maxDelayMs: 20_000,
      jitterRatio: 0.25
    }
  };
}
