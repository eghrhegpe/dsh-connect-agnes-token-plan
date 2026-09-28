/**
 * SenseNova console token store — the seam between the credentials service and
 * the panel's console calls.
 *
 * The console JWT lives 180 minutes. Previously the only way past that was to
 * copy a new one out of devtools into `$DSH_HOME/.env` and restart, which is
 * exactly the monthly interruption this store removes.
 *
 * How it works:
 *
 * - The grant lives in `ctx.credentials` as a `grant` record, never on disk in
 *   this plugin and never in the environment. Writing goes through
 *   `modifyRecord`, the service's serialized read-modify-write path, so two
 *   Host processes rotating the same refresh token cannot lose one another's
 *   write.
 * - `getToken()` returns a token that is valid for at least
 *   `skewMs`, renewing through `refresh_token` when the stored one is close to
 *   expiry. Hydra rotates refresh tokens, so every renewal also replaces the
 *   stored refresh token.
 * - `invalidate()` drops the in-memory token after a 401 so the next call
 *   renews once rather than looping on a token the console already rejected.
 *
 * Sign-in is throttled, never retried on a poll timer. The platform locks an
 * account after a few bad attempts, so an automatic retry turns one mistake
 * into a lockout. Two kinds of refusal are treated differently:
 *
 * - A time-shaped one (locked, rate-limited, a platform fault) waits out a
 *   backoff — the platform's own window when it states one, otherwise a local
 *   one that doubles per attempt up to half an hour. The throttle is persisted,
 *   so a second Host process does not keep knocking during the wait.
 * - A credential-shaped one (wrong password, a captcha the user must clear) is
 *   parked outright: waiting cannot fix it, so the panel asks for the account
 *   again and only an explicit resubmit retries. This is what stops a panel
 *   left open overnight from spending an attempt every minute on a password
 *   nobody has corrected.
 *
 * Account login is a one-time bootstrap: put the account in the environment
 * (`SENSENOVA_USERNAME` / `SENSENOVA_PASSWORD`) and the store logs in on the
 * first use, then keeps itself alive from the refresh token alone. The
 * password is never persisted by this module.
 *
 * @module dsh-connect-sensenova-token-plan/token-store
 */

import { createAuth, readJwtExpiry } from "./sensenova-auth.js";
import { CODE, isCredentialRefusal } from "./codes.js";
import { createMemoryThrottleStore } from "./throttle-store.js";
import { str, obj, verbatim, num, numOrNull, pluginError } from "./util.js";
import { name } from "./host-config.js";

/** Record address: this plugin's own namespace, so a stranger cannot collide. */
const RECORD_SCOPE = name;
const RECORD_ID = "sensenova-console";
/**
 * The namespace this plugin used before the rename.
 *
 * Read for MIGRATION ONLY: an account and grant saved under the old name must
 * survive the rename, or the panel would demand a fresh login and abandon a
 * refresh token that is still good. Nothing is ever written here again; each
 * legacy record is adopted once and deleted.
 */
const LEGACY_SCOPE = "dsh-llm-rate-panel";
/** Bumped if the stored payload shape ever changes incompatibly. */
const GRANT_VERSION = 1;

/**
 * The reference form of a credential name.
 *
 * `@deepseek-ai/dsh-credentials` exports `credentialRef` for this, and the
 * values below are already in the form it produces — a bare variable name.
 * Spelled out here so the store's own test does not have to resolve a peer
 * package to exercise anything; the service treats a string and its branded
 * reference identically, which check 14 pins down.
 * @param {string} name - the variable name.
 * @returns {string} the reference.
 */
const credentialRef = (name) => name;

/**
 * Where the account lives.
 *
 * These are credential REFERENCES — environment-variable names, not values.
 * Storing the account this way (rather than as another record) is what lets
 * the panel accept a username and password typed into the panel, hand them to
 * `ctx.credentials`, and have the very next login find them: the service
 * re-resolves per operation, writes them owner-only into
 * `~/.dsh/.credentials.yaml`, and needs no restart.
 *
 * The variables are still honoured from the environment as a fallback, so an
 * existing `$DSH_HOME/.env` setup keeps working untouched.
 */
const USERNAME_REF = "SENSENOVA_USERNAME";
const PASSWORD_REF = "SENSENOVA_PASSWORD";

/**
 * Where the throttle used to live, as a record in the credentials service.
 *
 * It is read for MIGRATION ONLY and never written again. The reason it was
 * there at all was that a throttle is not a `grant` and not an `api-key`, and
 * those are the only two kinds the service admits — naming a third makes the
 * credentials document unparseable for every plugin on the machine, so the
 * Host refuses to start. Smuggling state in as a `grant` avoided that, at the
 * cost of every payload write being one typo away from the same outage.
 *
 * The state now lives in this plugin's own file (see `throttle-store.js`).
 * This address is still read once, because a deployment that was parked on a
 * wrong password when it last shut down must not wake up and retry that
 * password automatically — a parked refusal is exactly the one that must
 * survive.
 */
const THROTTLE_ID = "sensenova-console-throttle";

/**
 * Marker inside the legacy payload, so a `grant` record holding throttle state
 * was never mistaken for a console grant (and vice versa).
 *
 * Still needed to recognise the old record during migration; it is what tells
 * an adopted throttle apart from another plugin's data at the same address.
 */
const THROTTLE_MARKER = "signin-throttle";

/** Renew this long before the access token actually expires. */
const DEFAULT_SKEW_MS = 120_000;

/**
 * The first wait imposed on a refusal the platform gave no window for.
 *
 * Doubles from here; `MAX_LOGIN_BACKOFF_MS` caps it.
 */
const DEFAULT_LOGIN_BACKOFF_MS = 60_000;

/**
 * Cap on a self-imposed wait.
 *
 * Applies ONLY to a wait this store invented. A window the platform stated
 * itself ("try again in 2 hours") is never truncated by it: capping that is
 * exactly what walks back into a lock that is still in force.
 */
const MAX_LOGIN_BACKOFF_MS = 30 * 60_000;

/**
 * Store version, bumped when the throttle's persisted shape changes.
 */
const THROTTLE_VERSION = 1;



/**
 * The stored grant, or `undefined` when nothing usable is stored.
 *
 * A payload that does not match the expected shape reads as absent rather
 * than throwing: a hand-edited or downgraded record should degrade the panel
 * into "not configured", not crash the route on every poll.
 * @param {unknown} record - a credential record.
 * @returns {{accessToken: string, refreshToken: string, expiresAt: number|null}|undefined}
 */
function parseGrant(record) {
  if (record === undefined || record === null || obj(record).kind !== "grant") return undefined;
  const payload = obj(obj(record).payload);
  if (num(payload.version) !== GRANT_VERSION) return undefined;
  const accessToken = str(payload.accessToken, "");
  if (accessToken === "") return undefined;
  return {
    accessToken,
    refreshToken: str(payload.refreshToken, ""),
    // Prefer the claim we can read off the token itself; fall back to what the
    // token endpoint reported when the claim is unreadable.
    expiresAt: numOrNull(payload.expiresAt) ?? readJwtExpiry(accessToken)
  };
}

/**
 * The refusal an in-force throttle stands for.
 *
 * Rethrows the platform's own failure while it is still the live one, so the
 * message the user reads is the platform's words, not this store's. Once the
 * wait has been served and re-reading finds a fresh refusal, that failure is
 * gone — so the throttle's own description takes over.
 *
 * The classification code is preserved on the synthesized error, so the panel
 * can still tell a wrong password from a lockout and say which it is.
 * @param {{code: string, parked: boolean, until: number|null, attempt: number}} held
 *   the throttle in force.
 * @param {Error} [cause] - the original refusal, when it is still current.
 * @returns {Error} the error to throw.
 */
function throttleError(held, cause) {
  if (cause !== undefined) return cause;
  const error = new Error(
    held.parked
      ? "sign-in is not being retried automatically: the account needs to be entered again"
      : `sign-in is not being retried automatically: waiting out a ${held.code} refusal`
  );
  error.code = held.code;
  return error;
}

/**
 * Build the token store.
 *
 * @param {object} options - wiring.
 * @param {object|null} options.credentials - the `ctx.credentials` service, or
 *   `null` when the Host has none. A missing service must not disable the
 *   panel: everything falls back to this process's memory, so the account form
 *   still works and the token renews for as long as the Host lives. Only a
 *   restart then asks again.
 * @param {object} [options.auth] - a `createAuth()` instance; defaults to one
 *   built on the platform defaults. The Host passes its configured instance so
 *   the login flow and token refresh target the operator's endpoints, not the
 *   shipped ones.
 * @param {Function} options.credentialKey - the service's key factory, so the
 *   branded key is built by the service that owns the type.
 * @param {object} [options.env] - environment source (defaults to
 *   `process.env`); injected by the tests.
 * @param {number} [options.skewMs] - renew this long before expiry.
 * @param {object} [options.throttleStore] - where sign-in refusals are
 *   remembered; defaults to this plugin's own file, which is what lets one
 *   Host process see a lock another is waiting out. Injected by the tests.
 * @param {() => number} [options.now] - clock source; injected by the tests so
 *   a backoff window can be crossed deliberately instead of by waiting.
 * @param {function(object[], Error|null): void} [options.onTrace] - called with
 *   the sanitized hop list when a sign-in attempt ENDS, success or failure.
 * @returns the store: `getToken`, `invalidate`, `saveAccount`,
 *   `forgetAccount`, and `state`.
 */
export function createTokenStore({
  credentials,
  credentialKey,
  auth = createAuth(),
  env = process.env,
  skewMs = DEFAULT_SKEW_MS,
  throttleStore: injectedThrottleStore,
  now = Date.now,
  onTrace
}) {
  const key = credentialKey(RECORD_SCOPE, RECORD_ID);
  const THROTTLE_KEY = credentialKey(RECORD_SCOPE, THROTTLE_ID);
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
  // test. The Host passes the file store explicitly; see index.js.
  const throttleStore = injectedThrottleStore ?? createMemoryThrottleStore(now);
  // No deadline of its own. The login flow's timeout is part of the auth
  // configuration (`loginTimeoutMs`), and a second knob on this store would
  // only add the question of which of the two is lying.
  /**
   * The in-memory fallback used while no credentials service is reachable. A
   * Host without the service still gets a working panel: the account and grant
   * live here, which is exactly as private as the real store and simply does
   * not outlive the process.
   */
  const memory = {
    records: new Map(),
    account: new Map(),
    async readRecord(k) { return this.records.get(k); },
    async modifyRecord(k, mutate) {
      const next = await mutate(this.records.get(k));
      if (next === undefined) return this.records.get(k);
      this.records.set(k, next);
      return next;
    },
    // Keyed, because the throttle is a second record: clearing one throttle
    // must not take a stored grant with it.
    async deleteRecord(k) { this.records.delete(k); },
    async resolve(ref) {
      const value = this.account.get(ref);
      return typeof value === "string" && value !== "" ? { value, source: "memory" } : undefined;
    },
    async set(ref, value) { this.account.set(ref, value); },
    async unset(ref) { this.account.delete(ref); }
  };
  /**
   * Resolve the credentials service on EVERY use, not once at mount: the
   * service may register after this plugin loads, and a flag frozen at mount
   * would then claim "no credentials service" forever while the store quietly
   * exists on disk. Accepts the service itself (tests) or a resolver function
   * (index.js) and normalises anything absent to `null`.
   */
  const resolveService = () => {
    const value = typeof credentials === "function" ? credentials() : credentials;
    return value ?? null;
  };
  /** The live backend: the real service when attached, else the in-memory vault. */
  const backend = () => resolveService() ?? memory;
  /** True while nothing written through the store would survive a restart. */
  const ephemeral = () => resolveService() === null;

  /** In-memory token for this process; the record is the durable truth. */
  let cached = null;
  /**
   * Tokens the console has already rejected.
   *
   * A 401 does not prove the token expired — it proves the console refused it —
   * so a rejected token must never be handed out again even while its `exp`
   * still looks valid. Without this the store would re-read the same record
   * and replay the token the console just refused.
   */
  const rejected = new Set();
  /** One in-flight acquisition, so N concurrent polls share one login. */
  let inflight = null;
  /** Last failure, surfaced to the panel instead of a bare "not configured". */
  let lastError = null;
  /**
   * A refusal that must not be repeated on a timer.
   *
   * The platform locks an account after a few bad attempts, so retrying a
   * failed sign-in automatically turns one mistake into a lockout. This records
   * why sign-in is pointless right now and until when.
   *
   * `until` is the absolute deadline when the platform names one ("try again
   * in 8 minutes"); otherwise a local backoff applies, doubling per attempt up
   * to {@link MAX_LOGIN_BACKOFF_MS}.
   *
   * `parked` matters as much as the clock. A refusal that says the
   * *credentials* are wrong is not fixed by waiting — time does not make a
   * wrong password right — so it is parked until the user acts, with no
   * deadline at all. Anything else (locked, rate-limited, a transient platform
   * fault) is time-shaped and does come back on its own.
   */
  let throttle = null;

  /**
   * How many refusals in a row this store has seen.
   *
   * Kept separately from `throttle` because the throttle record is deleted as
   * soon as its window closes, while this count must survive that deletion —
   * otherwise the doubling has nothing to double from and every wait restarts
   * at the shortest one.
   */
  let consecutiveRefusals = 0;

  /** Read the durable grant through the credentials service. */
  async function readStored() {
    try {
      const current = parseGrant(await backend().readRecord(key));
      if (current !== undefined) return current;
      return await adoptLegacyGrant();
    } catch {
      return undefined;
    }
  }

  /**
   * Take over a grant a previous version saved under the old namespace.
   *
   * Runs once, when the record under the current name is absent. The legacy
   * record is re-written at the current address and deleted, so the next read
   * is a plain lookup; a grant that is still good must not be abandoned to the
   * "please log in again" path just because this plugin was renamed.
   * @returns {Promise<object|undefined>} the adopted grant, or undefined.
   */
  async function adoptLegacyGrant() {
    try {
      const legacyKey = credentialKey(LEGACY_SCOPE, RECORD_ID);
      const grant = parseGrant(await backend().readRecord(legacyKey));
      if (grant === undefined) return undefined;
      await backend().modifyRecord(key, () => Promise.resolve({
        kind: "grant",
        payload: {
          version: GRANT_VERSION,
          accessToken: grant.accessToken,
          refreshToken: grant.refreshToken,
          expiresAt: grant.expiresAt ?? null
        }
      }));
      await backend().deleteRecord(legacyKey).catch(() => {});
      return grant;
    } catch {
      return undefined;
    }
  }

  /**
   * Persist a token pair.
   *
   * Goes through `modifyRecord` so the read-decide-replace is exclusive: a
   * refresh token is single-use, and two processes racing on it would
   * otherwise invalidate each other's grant.
   * @param {string} accessToken - the new console JWT.
   * @param {string} refreshToken - the refresh token the platform just issued.
   * @param {number} expiresIn - the access token lifetime in seconds.
   * @param {string} [replacing] - the access token this renewal supersedes. A
   *   record still holding exactly that token is the one we read, so replacing
   *   it is right; a record holding anything else was rotated by someone else
   *   in the meantime and is kept.
   * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
   *   the grant now in effect — ours, or the newer one we deferred to.
   */
  async function store(accessToken, refreshToken, expiresIn, replacing) {
    // The injected clock, not `Date.now()`: every other deadline in this store
    // is measured with it, and a grant whose expiry came from a different clock
    // is the one thing a test crossing a window deliberately cannot control.
    const issuedAt = now();
    const payload = {
      version: GRANT_VERSION,
      accessToken,
      refreshToken,
      expiresAt: issuedAt + num(expiresIn, 10800) * 1000
    };
    try {
      const record = await backend().modifyRecord(key, (current) => {
        const existing = parseGrant(current);
        // Someone else already rotated while this renewal was in flight, and
        // their token is still good: keep theirs rather than writing a grant
        // that would invalidate the refresh token they now hold.
        if (existing !== undefined && replacing === undefined
          && existing.expiresAt !== null && existing.expiresAt > issuedAt + 60_000) {
          return undefined;
        }
        if (existing !== undefined && replacing !== undefined && existing.accessToken !== replacing) {
          return undefined;
        }
        return Promise.resolve({ kind: "grant", payload });
      });
      const stored = parseGrant(record) ?? payload;
      cached = stored;
      return stored;
    } catch (error) {
      // A read-only store must not break the panel: keep the token in memory
      // for this process and let the next start re-login.
      cached = { accessToken, refreshToken, expiresAt: payload.expiresAt };
      throw new Error(
        `could not persist the console token (${error instanceof Error ? error.message : String(error)}); ` +
          "it stays valid until dsh restarts"
      );
    }
  }

  /**
   * Renew with the stored refresh token.
   * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
   */
  async function renewWithRefresh(stored) {
    if (stored?.refreshToken === undefined || stored.refreshToken === "") {
      throw pluginError(CODE.NO_REFRESH_TOKEN, "stored grant has no refresh token");
    }
    const result = await auth.refresh(stored.refreshToken);
    // Name the token this renewal supersedes, so a concurrent rotation is
    // detected instead of silently overwritten.
    return store(result.accessToken, result.refreshToken, result.expiresIn, stored.accessToken);
  }

  /**
   * The account to log in with, preferring the credentials store over the
   * environment so a value typed into the panel is found without a restart.
   * @returns {Promise<{username: string, password: string, source: string}|undefined>}
   */
  async function readAccount() {
    const fromStore = async (ref) => {
      // `resolve` is per-call by contract: a value written a moment ago is
      // visible to the next read, with no restart in between.
      const resolved = await backend().resolve(credentialRef(ref)).catch(() => undefined);
      return verbatim(resolved?.value, "");
    };
    const username = str(await fromStore(USERNAME_REF), "") || str(env[USERNAME_REF], "");
    const password = verbatim(await fromStore(PASSWORD_REF), "") || verbatim(env[PASSWORD_REF], "");
    if (username === "" || password.trim() === "") return undefined;
    return { username, password, source: "credentials" };
  }

  /**
   * Log in with the stored account. The bootstrap that turns a typed-in
   * username and password into a self-renewing grant.
   * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
   */
  async function loginFromAccount() {
    const account = await readAccount();
    if (account === undefined) {
      throw pluginError(CODE.NOT_CONFIGURED, "no console account is configured");
    }
    const result = await auth.login({ username: account.username, password: account.password }, { onTrace });
    return store(result.accessToken, result.refreshToken, result.expiresIn);
  }

  /** Whether a token is still good for at least `skewMs`. */
  function isFresh(token, at = now()) {
    if (token === undefined || token === null) return false;
    // A token the console refused is never fresh, however long its `exp` says.
    if (rejected.has(token.accessToken)) return false;
    if (token.expiresAt === null) return true; // unknown expiry: let the console decide
    return token.expiresAt - at > skewMs;
  }

  /**
   * Refusals that describe the CREDENTIAL rather than the moment.
   *
   * A wrong password does not become right by waiting, so a timer is the
   * wrong instrument for it: the panel must keep asking for an account instead
   * of quietly burning another attempt every minute. The platform's own
   * verification prompts are the same shape — the user has to do something, so
   * nothing is retried behind their back.
   *
   * `not_configured` is deliberately NOT here. It is not a refusal at all: it
   * means no account has ever been entered, so there was never an attempt to
   * avoid repeating. Recording it as a park would write a throttle record on
   * every fresh install and then report `needsUserAction` for a user who has
   * done nothing wrong yet.
   *
   * The set itself lives in `codes.js` beside the taxonomy it belongs to, so
   * that a new platform reason is classified in one place instead of three.
   */

  /**
   * How long a refusal without a stated window should wait.
   *
   * Doubles per consecutive refusal so a persistently wrong password settles
   * at the cap instead of producing a steady one-minute trickle of attempts
   * for as long as the panel stays open.
   * @param {number} attempt - how many self-imposed waits have been served.
   * @returns {number} milliseconds to wait.
   */
  function localBackoffMs(attempt) {
    const doubled = DEFAULT_LOGIN_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
    return Math.min(doubled, MAX_LOGIN_BACKOFF_MS);
  }

  /**
   * Read the persisted throttle, or `null` when absent, stale, or unreadable.
   *
   * A parked refusal has no deadline, so it is keyed on its `parked` flag
   * rather than on a time: reading it back must not depend on a field that is
   * legitimately absent.
   * @returns {Promise<{code: string, parked: boolean, until: number|null, attempt: number}|null>}
   */
  async function readThrottle() {
    const held = await throttleStore.read().catch(() => null);
    if (held !== null) return held;
    return adoptLegacyThrottle();
  }

  /**
   * Take over a throttle a previous version parked in the credentials service.
   *
   * Only ever reads. It matters because a parked refusal has no deadline: lose
   * it across a restart and the next poll retries a password the user has not
   * changed, which is how one wrong password becomes a locked account. So the
   * old record is adopted rather than dropped, then deleted so this runs once.
   * Both the current address and the pre-rename one are consulted, so a parked
   * state left under either name survives.
   * @returns {Promise<object|null>} the adopted throttle, or null.
   */
  async function adoptLegacyThrottle() {
    const candidates = [THROTTLE_KEY, credentialKey(LEGACY_SCOPE, THROTTLE_ID)];
    for (const legacyKey of candidates) {
      try {
        // The record must be OURS: a grant, carrying the throttle marker. A
        // record that is anything else — a console grant at this address, a
        // hand-edited file, another plugin's data — reads as absent rather than
        // being interpreted.
        const record = obj(await backend().readRecord(legacyKey));
        if (record.kind !== "grant") continue;
        const payload = obj(record.payload);
        if (payload.marker !== THROTTLE_MARKER) continue;
        if (num(payload.version) !== THROTTLE_VERSION) continue;
        const code = str(payload.code, "");
        if (code === "") continue;
        const attempt = num(payload.attempt, 1);
        const until = numOrNull(payload.until);
        const adopted = payload.parked === true
          ? { code, parked: true, until: null, attempt }
          : { code, parked: false, until, attempt };
        // A window that has closed is no longer a reason to refuse.
        if (adopted.parked !== true && (until === null || until <= now())) continue;
        await throttleStore.write(adopted).catch(() => {});
        await backend().deleteRecord(legacyKey).catch(() => {});
        return adopted;
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Remember a refusal so neither this process nor another one retries it.
   *
   * Persisted because a second Host process polling the same account would
   * otherwise walk straight into a lock this one is politely waiting out.
   * @param {object} error - the refusal thrown by `login`.
   * @param {number} [previousAttempt] - the attempt count being superseded.
   * @returns {Promise<{code: string, parked: boolean, until: number|null, attempt: number}>}
   *   the throttle now in force.
   */
  async function writeThrottle(error, previousAttempt) {
    const code = str(error?.code, CODE.LOGIN_FAILED);
    const parked = isCredentialRefusal(code);
    // A window the platform stated is taken at its word; only a window we
    // invented is capped.
    const stated = numOrNull(error?.retryAfterMs);
    consecutiveRefusals = num(previousAttempt, consecutiveRefusals) + 1;
    const attempt = consecutiveRefusals;
    const until = parked
      ? null
      : now() + (stated === null ? localBackoffMs(attempt) : Math.max(stated, 0));
    throttle = { code, parked, until, attempt };
    // This plugin's own file, not the credentials service: a throttle is not a
    // credential, and the only two record kinds that service admits are. See
    // THROTTLE_ID for what writing one here used to cost.
    await throttleStore.write(throttle).catch(() => {
      // A store that cannot be written must not break the panel: this process
      // still honours the wait in memory.
    });
    return throttle;
  }

  /** Drop the throttle, so the next sign-in is allowed to try. */
  async function clearThrottle() {
    throttle = null;
    await throttleStore.clear().catch(() => {
      // Nothing to do: the in-memory clear above already took effect.
    });
    // Discarded records from a previous version, if any are still around. They
    // are never written again, so this is housekeeping rather than a state
    // change. Both the current address and the pre-rename one are swept.
    await Promise.all([
      backend().deleteRecord(THROTTLE_KEY).catch(() => {}),
      backend().deleteRecord(credentialKey(LEGACY_SCOPE, THROTTLE_ID)).catch(() => {})
    ]);
  }

  /**
   * How much longer a throttle is in force, or `null` when it is not.
   *
   * A parked refusal has no deadline and so no countdown.
   * @param {{parked: boolean, until: number|null}|null} held - the throttle.
   * @returns {number|null} milliseconds remaining.
   */
  function inForceWaitMs(held) {
    if (held === null || held.parked) return null;
    return Math.max(0, held.until - now());
  }

  /** Acquire a usable token, logging in or refreshing as needed. */
  async function acquire() {
    // A refused sign-in is not repeated on a timer: the platform locks an
    // account after a few bad attempts, so a poll loop that keeps trying
    // turns one mistake into a lockout. Fail fast and say why instead.
    const held = throttle ?? await readThrottle();
    throttle = held;
    if (held !== null && (held.parked || held.until > now())) {
      throw throttleError(held);
    }
    if (held !== null) {
      // Its window closed, so the refusal may be probed again — but the attempt
      // count is kept, so the next wait is longer than this one. Clearing the
      // throttle here and forgetting the count is what made every backoff
      // silently restart at one minute.
      consecutiveRefusals = held.attempt;
      await clearThrottle();
    }

    const stored = (await readStored()) ?? cached ?? undefined;
    if (isFresh(stored)) {
      cached = stored;
      return stored.accessToken;
    }
    // Prefer renewal: it needs no password, and the password may have been
    // removed from the environment long after the first login.
    if (stored?.refreshToken !== undefined && stored.refreshToken !== "") {
      try {
        const renewed = await renewWithRefresh(stored);
        return renewed.accessToken;
      } catch (error) {
        // A rejected refresh token is unrecoverable without a password; fall
        // through to a login when one is configured.
        if (obj(error).code !== CODE.REFRESH_REJECTED && obj(error).code !== CODE.NO_REFRESH_TOKEN) throw error;
        if ((await readAccount()) === undefined) throw error;
      }
    }
    try {
      const fresh = await loginFromAccount();
      // A sign-in that worked clears any earlier refusal: the wait is over by
      // the only evidence that matters, and the backoff starts over.
      consecutiveRefusals = 0;
      if (throttle !== null) await clearThrottle();
      return fresh.accessToken;
    } catch (error) {
      // No account is not a refusal and no request was made, so there is
      // nothing to throttle: recording one would claim the user did something
      // wrong and would keep a fresh install looking "needs user action".
      if (obj(error).code === CODE.NOT_CONFIGURED) throw error;
      // Otherwise record the refusal so the next poll does not walk into the
      // lock again. The platform's own error is what the panel shows, since it
      // carries the reason and any stated window; the throttle only governs
      // when the next attempt may happen.
      const held = await writeThrottle(error, throttle?.attempt);
      throw held.parked ? error : throttleError(held, error);
    }
  }

  return {
    /**
     * A console access token that should not be rejected for expiry.
     * @returns {Promise<string>}
     */
    async getToken() {
      if (isFresh(cached)) return cached.accessToken;
      // One acquisition in flight: a panel poll storm must not trigger a
      // login stampede or a burst of refresh-token rotations.
      inflight ??= acquire()
        .then((token) => {
          lastError = null;
          return token;
        })
        .catch((error) => {
          lastError = error;
          throw error;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },

    /**
     * Forget the token the console just rejected, so the next call renews
     * exactly once instead of replaying a token the server already refused.
     * @param {string} [token] - the token that was refused; defaults to the
     *   cached one.
     */
    invalidate(token) {
      const refused = str(token, cached?.accessToken ?? "");
      if (refused !== "") {
        rejected.add(refused);
        // Bounded: only the most recent refusals can still be in play, since a
        // token that was superseded is never handed out again.
        while (rejected.size > 8) rejected.delete(rejected.values().next().value);
      }
      cached = null;
    },

    /**
     * Store a console account, then log in with it.
     *
     * This is what the panel's setup form calls. The account goes to
     * `ctx.credentials` as a reference value — owner-only on disk, never in
     * this plugin's own files — and the resulting grant is what keeps the
     * panel alive afterwards.
     * @param {{username: string, password: string}} account - the credentials.
     * @returns {Promise<void>}
     */
    async saveAccount(account) {
      const username = str(account?.username, "");
      const password = verbatim(account?.password, "");
      if (username === "" || password.trim() === "") {
        throw pluginError(CODE.MISSING_CREDENTIALS, "a username and a password are both required");
      }
      // Persist first, then log in: if the write is rejected (a read-only
      // environment shadows the reference) the user is told before any login
      // attempt, instead of being left with a token that dies at restart.
      await backend().set(credentialRef(USERNAME_REF), username);
      await backend().set(credentialRef(PASSWORD_REF), password);
      // The password may differ from the one that produced the current grant.
      cached = null;
      rejected.clear();
      // A deliberate resubmit is the user acting on what the panel told them,
      // so it clears the throttle — otherwise a corrected password would be
      // refused by this store's own timer. It is the ONE path that does:
      // every automatic route into `acquire` is still blocked.
      await clearThrottle();
      try {
        await loginFromAccount();
      } catch (error) {
        // A deliberate submit is the one path allowed to spend an attempt, but
        // a REFUSED one must still be recorded. This call's caller reads
        // `state()` the moment it rejects, and with no throttle on record the
        // panel reports "no wait, nothing for the user to do" — so the next
        // poll walks straight into another attempt with the same bad password,
        // which is exactly what the park exists to prevent.
        if (obj(error).code !== CODE.NOT_CONFIGURED) await writeThrottle(error);
        throw error;
      }
    },

    /**
     * Forget the stored account.
     *
     * The grant is left alone: the panel keeps working on the refresh token
     * until that runs out, and only then asks for the account again.
     * @returns {Promise<void>}
     */
    async forgetAccount() {
      await backend().unset(credentialRef(USERNAME_REF));
      await backend().unset(credentialRef(PASSWORD_REF));
      cached = null;
    },

    /**
     * A description of the store for the panel: whether a token is held, when
     * it expires, and the last failure. No secret is included.
     */
    async state() {
      const stored = await readStored();
      const account = await readAccount();
      // Read the throttle here too, so a second Host process shows the same
      // countdown rather than inviting an attempt that would be refused.
      const held = throttle ?? await readThrottle();
      return {
        // "configured" means the panel can get a token: either it already has
        // one, or an account is stored to obtain the next one.
        configured: stored !== undefined || account !== undefined,
        hasAccount: account !== undefined,
        hasRefreshToken: str(stored?.refreshToken, "") !== "",
        expiresAt: stored?.expiresAt ?? null,
        // Why the panel should ask for an account: nothing works yet.
        needsAccount: stored === undefined && account === undefined,
        // True when the Host has no credentials service, so the account lives
        // in this process only and must be re-entered after a restart.
        ephemeral: ephemeral(),
        // While a refused sign-in is still inside its wait, the panel shows a
        // countdown rather than inviting an immediate retry. `null` when
        // nothing is being waited out.
        retryAfterMs: inForceWaitMs(held),
        // A refusal the clock cannot fix — a wrong password, or a captcha the
        // user must clear. The panel says so instead of showing a countdown
        // that would tick down to another attempt that never happens.
        needsUserAction: held !== null && held.parked,
        error: lastError === null ? null : lastError instanceof Error ? lastError.message : String(lastError)
      };
    }
  };
}

export {
  RECORD_SCOPE,
  LEGACY_SCOPE,
  RECORD_ID,
  USERNAME_REF,
  PASSWORD_REF,
  THROTTLE_ID,
  DEFAULT_LOGIN_BACKOFF_MS,
  MAX_LOGIN_BACKOFF_MS
};
