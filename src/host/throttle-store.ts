/**
 * dsh-connect-agnes-token-plan — where the sign-in throttle lives.
 *
 * It used to live in the credentials service, disguised as a `kind: "grant"`
 * record carrying a marker field. That disguise was not a stylistic choice:
 * the service admits exactly two record kinds, and an unknown one makes the
 * whole credentials document unparseable — which takes the Host down, not
 * just this panel. So a throttle could only ever be smuggled in as a grant,
 * and a single mistyped payload was enough to break every credential on the
 * machine.
 *
 * A throttle is not a credential. It is state: a deadline and a reason, plus
 * a parked flag for refusals that have no deadline. It belongs in this
 * plugin's own file, where a malformed value costs the plugin its throttle
 * and nothing else.
 *
 * @module dsh-connect-agnes-token-plan/throttle-store
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { str, num } from "./util.ts";
import { CODE } from "./codes.ts";
import { name } from "./host-config.ts";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, stateDir as pluginStateDir } from "./state-store.ts";

/** Shape version, bumped when the persisted form changes. */
const THROTTLE_VERSION = 1;

/**
 * Upgrades from an older persisted shape to {@link THROTTLE_VERSION}.
 *
 * The seam that makes bumping the version SAFE, and the reason the constant
 * above must never be bumped without adding an entry here. `parse` reads any
 * version it does not recognise as "no throttle", and for a PARKED refusal
 * that is not a neutral outcome — it is an automatic retry of a password the
 * user has not changed, into an account the platform may have locked. So a
 * bare version bump silently disables the anti-lock protection on every
 * machine at the exact moment nobody is looking at it: the old file is still
 * there, it just stopped being understood.
 *
 * Keyed by the version being upgraded FROM and applied in order. Empty today
 * because there is only one version; adding a second is a two-line change
 * (bump the constant, add the entry) and forgetting the second half is what
 * this table exists to make visible.
 * @type {ReadonlyMap<number, (body: Record<string, unknown>) => Record<string, unknown>>}
 */
const MIGRATIONS: ReadonlyMap<number, (body: Record<string, unknown>) => Record<string, unknown>> = new Map([
  // Example, once version 2 exists:
  //   1: (body) => ({ ...body, version: 2, attempt: num(body.attempt, 1) })
]);

/**
 * How long to wait when the persisted throttle was written by a NEWER shape
 * than this code understands.
 *
 * Deliberately a wait and not a shrug. Two processes can hold different
 * versions of this plugin (a Host started before an upgrade keeps running),
 * and a file we cannot parse still represents someone being told to stop
 * knocking. Reading it as "no throttle" would restart the knocking for the
 * reason the throttle exists to prevent; waiting a short while and retrying
 * the read costs one poll and gets it right on its own, because the window
 * expires and the next attempt re-reads the file.
 */
const FOREIGN_VERSION_WAIT_MS = 60_000;

/**
 * Bring a persisted payload to {@link THROTTLE_VERSION}, or `null` when there
 * is no path from where it is to here.
 * @param {Record<string, unknown>} body - the parsed file contents.
 * @returns {Record<string, unknown>|null} the payload at the current version.
 */
function migrateToCurrent(body: Record<string, unknown>): Record<string, unknown> | null {
  let version = Number(body.version);
  let current = body;
  // Bounded: a migration that fails to advance the version would otherwise
  // spin here forever.
  for (let step = 0; step < 8 && version !== THROTTLE_VERSION; step += 1) {
    const upgrade = MIGRATIONS.get(version);
    if (upgrade === undefined) return null;
    current = upgrade(current);
    version = Number(current.version);
    if (!Number.isFinite(version)) return null;
  }
  return version === THROTTLE_VERSION ? current : null;
}

/**
 * Where the throttle lives: the SHARED directory, `$DSH_HOME/state/<plugin>`.
 *
 * Deliberately NOT per-profile, even though the catalog / provider / draw
 * states are (PITFALLS §23). A throttle is not a per-profile preference, it is
 * "how long the upstream told this machine to stop knocking" — if only the
 * profile that got the 429 honoured it, the other profile's Host would resume
 * hammering the same endpoint from the same machine during the very window the
 * platform asked for. Splitting it would silently undo the whole point of the
 * throttle, and the failure only surfaces under load. Do not "make it
 * consistent" with the other three.
 * @returns {string} the directory.
 */
export function throttleDir() {
  return pluginStateDir(name);
}

/**
 * Parse a persisted throttle, or `null` when it is absent, stale, or foreign.
 *
 * Anything unrecognised reads as "no throttle". That is the safe direction for
 * a *time* window — the worst case is one extra attempt — and the reason the
 * caller keeps parked refusals somewhere it can still see them.
 * @param {unknown} raw - the parsed file contents.
 * @param {() => number} now - clock source.
 * @returns {{code: string, parked: boolean, until: number|null, attempt: number}|null}
 */
function parse(raw: unknown, now: () => number) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as { version?: unknown; code?: unknown; parked?: unknown; until?: unknown; attempt?: unknown };
  const version = num(body.version, 0);
  if (version !== THROTTLE_VERSION) {
    // A NEWER shape than this code knows (another process, or a Host started
    // before an upgrade): wait it out rather than reading it as "no throttle"
    // — see `FOREIGN_VERSION_WAIT_MS`. An OLDER shape goes through the
    // migration table first, and only reads as "nothing stored" when that
    // table has no path for it.
    if (version > THROTTLE_VERSION) {
      return { code: CODE.RATE_LIMITED, parked: false, until: now() + FOREIGN_VERSION_WAIT_MS, attempt: 1 };
    }
    const migrated = migrateToCurrent(body as Record<string, unknown>);
    if (migrated === null) return null;
    return parse({ ...migrated, version: THROTTLE_VERSION }, now);
  }
  const code = str(body.code, "");
  if (code === "") return null;
  const attempt = Math.max(1, Math.floor(num(body.attempt, 1)));
  if (body.parked === true) return { code, parked: true, until: null, attempt };
  const until = num(body.until, NaN);
  // A window that has closed is no longer a reason to refuse.
  if (!Number.isFinite(until) || until <= now()) return null;
  return { code, parked: false, until, attempt };
}

/**
 * A throttle store backed by one file.
 *
 * Writes are atomic — a temporary file, then a rename — because two Host
 * processes share this path: a half-written file read by the other process
 * would read as "no throttle", which for a parked refusal means an automatic
 * retry of a password the user has not changed.
 * @param {object} [options] - wiring.
 * @param {string} [options.dir] - directory; defaults to {@link throttleDir}.
 * @param {() => number} [options.now] - clock source; injected by the tests.
 * @returns {{read: Function, write: Function, clear: Function}} the store.
 */
export function createFileThrottleStore({ dir = throttleDir(), now = Date.now } = {}) {
  const file = join(dir, "throttle.json");

  // There is deliberately no adoption of the pre-rename state directory. That
  // directory (`state/dsh-llm-rate-panel/`) belongs to the SenseNova plugin,
  // and adopting it would be a `rename` — a MOVE. It would strip the other
  // plugin of a parked refusal it is still waiting out, which is precisely the
  // state that stops a wrong password from being retried into an account lock.
  // A brand-new plugin has no predecessor; it starts with no throttle.

  return {
    async read() {
      // Absent, unreadable, or not JSON reads as "no throttle" (`readStateJson`
      // returns null): the safe direction for a time window.
      return parse(await readStateJson(file), now);
    },
    // `write` / `clear` REPORT whether they reached the disk instead of
    // rejecting. The swallow stays — a read-only Home must not break the panel,
    // and the caller still honours the wait in this process — but it used to be
    // invisible: `writeThrottle`'s `.catch()` was attached to a promise that
    // could never reject, so the cross-process "don't knock during the lock"
    // protection could fail with nothing logged anywhere (PITFALLS §42).
    // Returning a boolean is the same contract `catalog-store.replace()`
    // already uses, so the caller can warn on `false` without a try/catch.
    async write(state: Record<string, unknown>) {
      const temporary = temporaryOf(dir, "throttle.json");
      try {
        await ensureStateDir(dir);
        const body = JSON.stringify({
          version: THROTTLE_VERSION,
          code: state.code,
          parked: state.parked === true,
          until: state.parked === true ? null : state.until,
          attempt: state.attempt
        });
        await writeStateFile(file, body, { temporary });
        return true;
      } catch {
        // A read-only Home must not break the panel: the caller still honours
        // the wait for this process, it just will not outlive it.
        return false;
      }
    },
    async clear() {
      try {
        await rm(file, { force: true });
        return true;
      } catch {
        // Nothing to do: an absent file is already a cleared throttle.
        return false;
      }
      // The pre-rename file is deliberately left alone: it belongs to the
      // SenseNova plugin, and deleting it would clear an account lock that
      // plugin is still waiting out. See the note at the top of this factory.
    }
  };
}

/**
 * A throttle store that forgets everything when the process ends.
 *
 * Used by the tests, and by a Host that can be given nothing writable. It is
 * deliberately NOT the default: the throttle exists so that a second Host
 * process does not walk into a lock the first is waiting out, which is a
 * claim about other processes and cannot be kept in memory.
 * @param {() => number} [now] - clock source.
 * @returns {{read: Function, write: Function, clear: Function}} the store.
 */
export function createMemoryThrottleStore(now = Date.now) {
  let held: { version: number; [key: string]: unknown } | null = null;
  // Same contract as the file store: report, never reject. An in-memory write
  // cannot fail, so these say so truthfully rather than returning a value the
  // caller would have to special-case.
  return {
    async read() {
      return parse(held, now);
    },
    async write(state: Record<string, unknown>) {
      held = { version: THROTTLE_VERSION, ...state };
      return true;
    },
    async clear() {
      held = null;
      return true;
    }
  };
}
