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
 * Structure: `createTokenStore` builds one shared context — the wiring
 * (backend, keys, clock, env, auth, throttle store) plus the seven mutable
 * fields the four blocks (grant / account / renewal / throttle) operate on —
 * via `createStoreContext` (`./token-store/state.js`), and keeps its public
 * behavior exactly as before. The split doc is `docs/TOKEN-STORE-SPLIT.md`.
 *
 * @module dsh-connect-sensenova-token-plan/token-store
 */

import { CODE } from "./codes.js";
import { str, obj, verbatim, num, numOrNull, pluginError } from "./util.js";
import { name as RECORD_SCOPE } from "./host-config.js";
import { createStoreContext } from "./token-store/state.js";
import {
  readStored as readStoredImpl,
  adoptLegacyGrant as adoptLegacyGrantImpl,
  storeGrant,
  purgeGrant as purgeGrantImpl,
  isFresh as isFreshImpl
} from "./token-store/grant.js";
import {
  throttleError as throttleErrorImpl,
  localBackoffMs as localBackoffMsImpl,
  readThrottle as readThrottleImpl,
  adoptLegacyThrottle as adoptLegacyThrottleImpl,
  writeThrottle as writeThrottleImpl,
  clearThrottle as clearThrottleImpl,
  inForceWaitMs as inForceWaitMsImpl,
  DEFAULT_LOGIN_BACKOFF_MS,
  MAX_LOGIN_BACKOFF_MS,
  THROTTLE_MARKER
} from "./token-store/throttle.js";

/** Record address: this plugin's own namespace, so a stranger cannot collide. */
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
 * The USERNAME is a credential REFERENCE — an environment-variable name, not
 * a value. Storing it this way (rather than as another record) is what lets
 * the panel accept a username typed into the panel and have the very next
 * state read find it: the service re-resolves per operation, writes it
 * owner-only into `~/.dsh/.credentials.yaml`, and needs no restart.
 *
 * The PASSWORD is NEVER persisted by this store. It rides each sign-in call
 * in memory and is gone when the attempt ends; `SENSENOVA_PASSWORD` in the
 * environment is its only durable source, and that is an explicit opt-in for
 * auto-recovery (a dead refresh token re-logs-in by itself only when it is
 * set). A previous version did store the password in the credentials service;
 * `readAccount` sweeps any such legacy value on first contact.
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
  return throttleErrorImpl(held, cause);
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
export function createTokenStore(options) {
  const { wiring, state } = createStoreContext(options);
  const {
    auth,
    env,
    skewMs,
    throttleStore,
    now,
    onTrace,
    credentialKey,
    key,
    THROTTLE_KEY,
    backend,
    ephemeral
  } = wiring;
  const {
    rejected
  } = state;

  /** Read the durable grant through the credentials service. */
  async function readStored() {
    return readStoredImpl(wiring, state);
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
    return adoptLegacyGrantImpl(wiring, state);
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
   * @param {string} [replacing] - the access token this write supersedes:
   *   passed by every refresh, and by a password login that read an existing
   *   grant. A record still holding exactly that token is the one we read, so
   *   replacing it is right; a record holding anything else was rotated by
   *   someone else in the meantime and is kept. Absent only for a first-ever
   *   login that read no grant.
   * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
   *   the grant now in effect — ours, or the newer one we deferred to.
   */
  async function store(accessToken, refreshToken, expiresIn, replacing) {
    return storeGrant(wiring, state, accessToken, refreshToken, expiresIn, replacing);
  }

  /**
   * Remove a grant that can no longer be of any use.
   *
   * A refresh token the platform has rejected (`refresh_rejected`) is dead for
   * good, and when no account is stored to re-login with there is no path that
   * ever revives it. Leaving it on disk did two things: it kept an ownerless
   * token pair in the credentials file after "forget account", and it made
   * every poll hit the dead refresh token before giving up. This reaps it.
   * Best-effort: a read-only store keeps serving from memory until restart.
   * @param {string} [accessToken] - the dead token, also dropped from the
   *   in-memory cache and rejection set.
   */
  async function purgeGrant(accessToken) {
    return purgeGrantImpl(wiring, state, accessToken);
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
   * The account's identity: the stored username, with the environment as a
   * fallback. Kept apart from the password because only the username is ever
   * persisted — `state()` asks "is there an account to clear?" without
   * requiring a password to be available.
   * @returns {Promise<string>} the username, or `""` when none is known.
   */
  const readUsername = async () => {
    const fromStore = async (ref) => {
      // `resolve` is per-call by contract: a value written a moment ago is
      // visible to the next read, with no restart in between.
      const resolved = await backend().resolve(credentialRef(ref)).catch(() => undefined);
      return verbatim(resolved?.value, "");
    };
    return str(await fromStore(USERNAME_REF), "") || str(env[USERNAME_REF], "");
  };

  /**
   * The account to log in with: a stored (or environment) username and an
   * ENVIRONMENT password.
   *
   * The password is never persisted. `SENSENOVA_PASSWORD` in the environment
   * is its only durable source, and that is an explicit opt-in: without an env
   * password the panel simply asks again when the refresh token dies.
   * @returns {Promise<{username: string, password: string, source: string}|undefined>}
   */
  async function readAccount() {
    const username = await readUsername();
    // One-time sweep: a previous version stored the password in the
    // credentials service. The new policy keeps no password at rest, so a
    // legacy value is removed on first contact (the environment remains the
    // opt-in path). Best-effort: a read-only service keeps the old value
    // until the user re-saves, which still cannot leak it anywhere new.
    if (!state.passwordSwept) {
      state.passwordSwept = true;
      await backend().unset(credentialRef(PASSWORD_REF)).catch(() => {});
    }
    const password = verbatim(env[PASSWORD_REF], "");
    if (username === "" || password.trim() === "") return undefined;
    return { username, password, source: "env" };
  }

  /**
   * Log in with an account and return a self-renewing grant.
   *
   * The account is taken EXPLICITLY when the caller just typed it (the panel
   * save path: the password lives in that call's closure and is never
   * written anywhere), and read back from the environment otherwise (the
   * auto-recovery path after a dead refresh token, opt-in via
   * `SENSENOVA_PASSWORD`).
   *
   * The grant read BEFORE the sign-in is named as the one this login
   * supersedes. It has to be read first: the token pair only arrives after the
   * network walk, and naming nothing is what let a still-fresh grant from a
   * DIFFERENT account silently survive a deliberate switch — the panel said
   * "signed in" while keeping serving the previous account. Naming the read
   * grant turns the write into the same compare-and-set a refresh uses: an
   * intentional switch wins, a login racing another process's rotation defers.
   * @param {{username: string, password: string}} [explicit] - an account
   *   supplied by the caller (never persisted); falls back to `readAccount`.
   * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
   */
  async function loginFromAccount(explicit) {
    const account = explicit ?? await readAccount();
    if (account === undefined) {
      throw pluginError(CODE.NOT_CONFIGURED, "no console account is configured");
    }
    const previous = await readStored();
    const result = await auth.login({ username: account.username, password: account.password }, { onTrace });
    return store(result.accessToken, result.refreshToken, result.expiresIn, previous?.accessToken);
  }

  /** Whether a token is still good for at least `skewMs`. */
  function isFresh(token, at) {
    return isFreshImpl(wiring, state, token, at);
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
    return localBackoffMsImpl(attempt);
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
    return readThrottleImpl(wiring, state);
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
    return adoptLegacyThrottleImpl(wiring, state);
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
    return writeThrottleImpl(wiring, state, error, previousAttempt);
  }

  /** Drop the throttle, so the next sign-in is allowed to try. */
  async function clearThrottle() {
    return clearThrottleImpl(wiring, state);
  }

  /**
   * How much longer a throttle is in force, or `null` when it is not.
   *
   * A parked refusal has no deadline and so no countdown.
   * @param {{parked: boolean, until: number|null}|null} held - the throttle.
   * @returns {number|null} milliseconds remaining.
   */
  function inForceWaitMs(held) {
    return inForceWaitMsImpl(wiring, held);
  }

  /** Acquire a usable token, logging in or refreshing as needed. */
  async function acquire() {
    // A refused sign-in is not repeated on a timer: the platform locks an
    // account after a few bad attempts, so a poll loop that keeps trying
    // turns one mistake into a lockout. Fail fast and say why instead.
    const held = state.throttle ?? await readThrottle();
    state.throttle = held;
    if (held !== null && (held.parked || held.until > now())) {
      throw throttleError(held);
    }
    if (held !== null) {
      // Its window closed, so the refusal may be probed again — but the attempt
      // count is kept, so the next wait is longer than this one. Clearing the
      // throttle here and forgetting the count is what made every backoff
      // silently restart at one minute.
      state.consecutiveRefusals = held.attempt;
      await clearThrottle();
    }

    const stored = (await readStored()) ?? state.cached ?? undefined;
    if (isFresh(stored)) {
      state.cached = stored;
      return stored.accessToken;
    }
    // Prefer renewal: it needs no password, and the password may have been
    // removed from the environment long after the first login.
    if (stored?.refreshToken !== undefined && stored.refreshToken !== "") {
      try {
        const renewed = await renewWithRefresh(stored);
        return renewed.accessToken;
      } catch (error) {
        // A rejected refresh token (or a grant that never had one) is
        // unrecoverable without a password. When an account is still stored we
        // fall through and re-login; when there is none — typically right after
        // "forget account", once the live token expires — the grant is dead for
        // good, so reap it instead of leaving an ownerless pair on disk and
        // re-hitting the dead refresh on every poll.
        if (obj(error).code !== CODE.REFRESH_REJECTED && obj(error).code !== CODE.NO_REFRESH_TOKEN) throw error;
        if ((await readAccount()) === undefined) {
          await purgeGrant(stored?.accessToken);
          throw error;
        }
      }
    }
    try {
      const fresh = await loginFromAccount();
      // A sign-in that worked clears any earlier refusal: the wait is over by
      // the only evidence that matters, and the backoff starts over.
      state.consecutiveRefusals = 0;
      if (state.throttle !== null) await clearThrottle();
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
      const held = await writeThrottle(error, state.throttle?.attempt);
      throw held.parked ? error : throttleError(held, error);
    }
  }

  return {
    /**
     * A console access token that should not be rejected for expiry.
     * @returns {Promise<string>}
     */
    async getToken() {
      if (isFresh(state.cached)) return state.cached.accessToken;
      // One acquisition in flight: a panel poll storm must not trigger a
      // login stampede or a burst of refresh-token rotations.
      state.inflight ??= acquire()
        .then((token) => {
          state.lastError = null;
          return token;
        })
        .catch((error) => {
          state.lastError = error;
          throw error;
        })
        .finally(() => {
          state.inflight = null;
        });
      return state.inflight;
    },

    /**
     * Forget the token the console just rejected, so the next call renews
     * exactly once instead of replaying a token the server already refused.
     * @param {string} [token] - the token that was refused; defaults to the
     *   cached one.
     */
    invalidate(token) {
      const refused = str(token, state.cached?.accessToken ?? "");
      if (refused !== "") {
        rejected.add(refused);
        // Bounded: only the most recent refusals can still be in play, since a
        // token that was superseded is never handed out again.
        while (rejected.size > 8) rejected.delete(rejected.values().next().value);
      }
      state.cached = null;
    },

    /**
     * Store a console account, then log in with it.
     *
     * This is what the panel's setup form calls. Only the USERNAME goes to
     * `ctx.credentials` (owner-only on disk, never in this plugin's own
     * files); the password stays in this call's closure and is gone when the
     * attempt ends. The resulting grant is what keeps the panel alive
     * afterwards, so a rejected password leaves nothing secret at rest.
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
      // The password is deliberately NOT part of the write: `SENSENOVA_PASSWORD`
      // in the environment is the only durable source (an explicit opt-in for
      // auto-recovery after a dead refresh token), so no plaintext password
      // ever sits in the credentials document.
      await backend().set(credentialRef(USERNAME_REF), username);
      // The password may differ from the one that produced the current grant.
      state.cached = null;
      rejected.clear();
      // A deliberate resubmit is the user acting on what the panel told them,
      // so it clears the throttle — otherwise a corrected password would be
      // refused by this store's own timer. It is the ONE path that does:
      // every automatic route into `acquire` is still blocked.
      await clearThrottle();
      try {
        // The typed account is handed over directly: the password lives only
        // in this closure, so the env-based `readAccount` must not be asked
        // for it here.
        await loginFromAccount({ username, password });
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
     * The grant is left alone at first: the panel keeps working on the refresh
     * token until that runs out, and only then asks for the account again. With
     * no account left to recover a dead refresh token, `acquire` also reaps the
     * expired grant then, so nothing ownerless is left behind.
     * @returns {Promise<void>}
     */
    async forgetAccount() {
      await backend().unset(credentialRef(USERNAME_REF));
      await backend().unset(credentialRef(PASSWORD_REF));
      state.cached = null;
    },

    /**
     * A description of the store for the panel: whether a token is held, when
     * it expires, and the last failure. No secret is included.
     */
    async state() {
      const stored = await readStored();
      const account = await readAccount();
      // The stored USERNAME is the account's identity. The password is not
      // persisted (the environment is its only durable source), so whether an
      // account is present must not depend on a password being available —
      // otherwise the panel's "clear the saved account" affordance would
      // vanish the moment no env password exists.
      const username = await readUsername();
      // Read the throttle here too, so a second Host process shows the same
      // countdown rather than inviting an attempt that would be refused.
      const held = state.throttle ?? await readThrottle();
      return {
        // "configured" means the panel can get a token: either it already has
        // one, or an account is stored to obtain the next one.
        configured: stored !== undefined || account !== undefined,
        hasAccount: username !== "",
        // Whether the environment carries the auto-recovery password
        // (`SENSENOVA_PASSWORD`). A boolean ONLY — the value never leaves the
        // store: the panel uses this to say "a dead refresh token re-signs in
        // automatically (or needs a manual re-login)". Absent or blank means
        // not armed, and the next dead refresh will surface the account form.
        autoRecoverArmed: str(env[PASSWORD_REF], "") !== "",
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
        error: state.lastError === null ? null : state.lastError instanceof Error ? state.lastError.message : String(state.lastError)
      };
    }
  };
}

export {
  RECORD_SCOPE,
  RECORD_ID,
  LEGACY_SCOPE,
  USERNAME_REF,
  PASSWORD_REF,
  THROTTLE_ID,
  DEFAULT_LOGIN_BACKOFF_MS,
  MAX_LOGIN_BACKOFF_MS
};
