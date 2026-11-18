/**
 * The shared context a token store instance runs on — the seam the split
 * around `token-store.ts` stands on.
 *
 * `token-store.ts` is one closure holding four intertwined blocks (grant,
 * account, renewal, throttle) that share seven mutable variables. The split
 * (docs/TOKEN-STORE-SPLIT.md) moves each block into its own module; what they
 * all keep in common is exactly what this file owns:
 *
 *   - `wiring` — the read side: the credentials backend (real service or the
 *     in-memory vault), the keys, the injected clock, env, auth, and the
 *     throttle store. Built once per instance.
 *   - `state` — the seven mutable fields, now named instead of closure-scoped:
 *     `cached`, `rejected`, `inflight`, `lastError`, `throttle`,
 *     `consecutiveRefusals`, `passwordSwept`. Each block writes only its own
 *     fields (the ownership table lives in the split doc §1); every block may
 *     read any field through `state.`.
 *
 * Step 1 of the split: `createStoreContext()` is the one new piece of code in
 * this move. `token-store.ts`'s `createTokenStore` now builds this context and
 * keeps its bodies verbatim against it, so the behavior baseline
 * (`test/store-baseline.test.mjs`) stays green — no semantics moved, only the
 * names did.
 *
 * @module dsh-connect-agnes-token-plan/token-store/state
 */

import { createAuth } from "../agnes-auth.ts";
import { createMemoryThrottleStore } from "../throttle-store.ts";
import { name as RECORD_SCOPE } from "../host-config.ts";

/**
 * Record address: this plugin's own namespace, so a stranger cannot collide.
 *
 * These are the CN ROW's addresses (ADR-021): the INTL row passes its own ids
 * (`agnes-console-intl` / `agnes-console-intl-throttle`) and its own account
 * reference names, so a machine holding both sites carries two grants that
 * can never be read or renewed by the wrong site's store.
 */
const RECORD_ID = "agnes-console";
const THROTTLE_ID = "agnes-console-throttle";
/** The CN row's account reference names (the INTL row's are the `*_INTL` pair). */
const USERNAME_REF = "AGNES_USERNAME";
const PASSWORD_REF = "AGNES_PASSWORD";
const DEFAULT_SKEW_MS = 120_000;

/**
 * Build one store instance's wiring + state.
 *
 * The body of what `createTokenStore` used to do before its first `let`:
 * resolve the throttle store, build the in-memory vault, the service
 * resolver, the backend and the ephemeral check, and the key pair. The
 * defaults and their comments move here unchanged; `token-store.ts` still
 * documents the OPTIONS (they are the public face of the factory).
 *
 * @param {object} options - the same options object `createTokenStore` takes.
 * @returns {{wiring: object, state: object}}
 */
export function createStoreContext({
  credentials,
  auth = createAuth(),
  env = process.env,
  skewMs = DEFAULT_SKEW_MS,
  throttleStore: injectedThrottleStore,
  now = Date.now,
  onTrace,
  credentialKey,
  // The row's record addresses (ADR-021). All four default to the CN row's
  // literals, so a pre-ADR-021 caller (and the whole offline baseline suite)
  // is byte-for-byte unchanged; the INTL row passes the `*-intl` grant and
  // throttle ids and the `*_INTL` account references.
  recordId = RECORD_ID,
  throttleId = THROTTLE_ID,
  usernameRef = USERNAME_REF,
  passwordRef = PASSWORD_REF
}: {
  credentials: any;
  auth?: any;
  env?: Record<string, unknown>;
  skewMs?: number;
  throttleStore?: { read: () => Promise<any>; write: (t: any) => Promise<unknown>; clear: () => Promise<unknown> };
  now?: () => number;
  onTrace?: (hops: any, error: any) => void;
  credentialKey: (scope: string, id: string) => string;
  recordId?: string;
  throttleId?: string;
  usernameRef?: string;
  passwordRef?: string;
}) {
  const key = credentialKey(RECORD_SCOPE, recordId);
  const THROTTLE_KEY = credentialKey(RECORD_SCOPE, throttleId);
  // Resolved here rather than as a parameter default, for two reasons.
  //
  // It has to judge its window with the clock the rest of the store uses: a
  // store given an injected clock and a throttle reading the real one would
  // disagree about whether a wait is over, which is invisible in production
  // and fatal in a test that crosses the window deliberately.
  //
  // And it defaults to MEMORY, not to the file. The file is shared and
  // durable, so a default that writes it makes every store in the process
  // share one throttle — in a test suite that means one case's lockout
  // refuses the next case's login, which reads as a bug in the code under
  // test. The Host passes the file store explicitly; see indexts.
  const throttleStore = injectedThrottleStore ?? createMemoryThrottleStore(now);
  /**
   * The in-memory fallback used while no credentials service is reachable. A
   * Host without the service still gets a working panel: the account and grant
   * live here, which is exactly as private as the real store and simply does
   * not outlive the process.
   */
  const memory = {
    records: new Map(),
    account: new Map(),
    async readRecord(k: string) { return this.records.get(k); },
    async modifyRecord(k: string, mutate: (value: any) => any) {
      const next = await mutate(this.records.get(k));
      if (next === undefined) return this.records.get(k);
      this.records.set(k, next);
      return next;
    },
    // Keyed, because the throttle is a second record: clearing one throttle
    // must not take a stored grant with it.
    async deleteRecord(k: string) { this.records.delete(k); },
    async resolve(ref: string) {
      const value = this.account.get(ref);
      return typeof value === "string" && value !== "" ? { value, source: "memory" } : undefined;
    },
    async set(ref: string, value: string) { this.account.set(ref, value); },
    async unset(ref: string) { this.account.delete(ref); }
  };
  /**
   * Resolve the credentials service on EVERY use, not once at mount: the
   * service may register after this plugin loads, and a flag frozen at mount
   * would then claim "no credentials service" forever while the store quietly
   * exists on disk. Accepts the service itself (tests) or a resolver function
   * (indexts) and normalises anything absent to `null`.
   */
  const resolveService = () => {
    const value = typeof credentials === "function" ? credentials() : credentials;
    return value ?? null;
  };
  /** The live backend: the real service when attached, else the in-memory vault. */
  const backend = () => resolveService() ?? memory;
  /** True while nothing written through the store would survive a restart. */
  const ephemeral = () => resolveService() === null;

  const wiring = {
    credentials,
    auth,
    env,
    skewMs,
    throttleStore,
    now,
    onTrace,
    credentialKey,
    key,
    THROTTLE_KEY,
    // The row's account reference names: `account.ts` reads these off the
    // wiring so one store body serves the CN row (the `AGNES_USERNAME` /
    // `AGNES_PASSWORD` pair) and the INTL row (the `*_INTL` pair) without a
    // second copy of the block (ADR-021).
    usernameRef,
    passwordRef,
    backend,
    ephemeral
  };

  const state = {
    /** In-memory token for this process; the record is the durable truth. */
    cached: null as { accessToken: string; refreshToken: string; expiresAt: number | null } | null,
    /**
     * Tokens the console has already rejected.
     *
     * A 401 does not prove the token expired — it proves the console refused it —
     * so a rejected token must never be handed out again even while its `exp`
     * still looks valid. Without this the store would re-read the same record
     * and replay the token the console just refused.
     */
    rejected: new Set<string>(),
    /** One in-flight acquisition, so N concurrent polls share one login. */
    inflight: null as Promise<string> | null,
    /** Last failure, surfaced to the panel instead of a bare "not configured". */
    lastError: null as unknown,
    /**
     * A refusal that must not be repeated on a timer.
     *
     * The platform locks an account after a few bad attempts, so retrying a
     * failed sign-in automatically turns one mistake into a lockout. This records
     * why sign-in is pointless right now and until when.
     *
     * `until` is the absolute deadline when the platform names one ("try again
     * in 8 minutes"); otherwise a local backoff applies, doubling per attempt up
     * to a cap. `parked` marks a credential-shaped refusal, which has no
     * deadline at all: waiting cannot make a wrong password right.
     */
    throttle: null as { code: string; parked: boolean; until: number | null; attempt: number } | null,
    /**
     * How many refusals in a row this store has seen.
     *
     * Kept separately from `throttle` because the throttle record is deleted as
     * soon as its window closes, while this count must survive that deletion —
     * otherwise the doubling has nothing to double from and every wait restarts
     * at the shortest one.
     */
    consecutiveRefusals: 0,
    /** True once a legacy stored password has been swept from the credentials service. */
    passwordSwept: false
  };

  return { wiring, state };
}
