/**
 * dsh-connect-sensenova-token-plan — where the sign-in throttle lives.
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
 * @module dsh-connect-sensenova-token-plan/throttle-store
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { str, num } from "./util.js";
import { name } from "./host-config.js";

/** Shape version, bumped when the persisted form changes. */
const THROTTLE_VERSION = 1;

/**
 * Where this plugin keeps state.
 *
 * `$DSH_HOME/state/<plugin>` — beside the Host's own directories rather than
 * in `logs/`, because a throttle is not a log line and must not be swept up by
 * the trace rotation.
 * @returns {string} the directory.
 */
export function throttleDir() {
  const home = str(process.env.DSH_HOME, join(homedir(), ".dsh"));
  return join(home, "state", name);
}

/**
 * The throttle file this plugin wrote before its rename.
 *
 * Read for MIGRATION ONLY: a parked refusal — a wrong password the user has
 * not yet corrected — must survive the rename, or the next Host start would
 * retry that password automatically and walk into a lock. The old file is
 * moved into place on first contact and never written again.
 * @returns {string} the legacy file path.
 */
function legacyThrottleFile() {
  const home = str(process.env.DSH_HOME, join(homedir(), ".dsh"));
  return join(home, "state", "dsh-llm-rate-panel", "throttle.json");
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
function parse(raw, now) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw;
  if (num(body.version, 0) !== THROTTLE_VERSION) return null;
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
  const temporary = join(dir, "throttle.json.tmp");

  /**
   * Move a throttle written before the rename into the current location.
   *
   * Runs once: a state already at the new address wins over one at the old. The
   * old directory then holds nothing and is left to be swept with the Home.
   * @returns {Promise<void>} resolves once any legacy state is in place.
   */
  let legacyAdopted = false;
  async function adoptLegacyFile() {
    if (legacyAdopted) return;
    legacyAdopted = true;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch {
      // A read-only Home: nothing can be moved, the current store stands.
    }
    try {
      await readFile(file, "utf8");
    } catch {
      // The current file is absent — adopt the legacy one, if there is any.
      try {
        await rename(legacyThrottleFile(), file);
      } catch {
        // No legacy file, or the move failed: the current store stands.
      }
    }
  }

  return {
    async read() {
      await adoptLegacyFile();
      try {
        return parse(JSON.parse(await readFile(file, "utf8")), now);
      } catch {
        // Absent, unreadable, or not JSON: no throttle is in force.
        return null;
      }
    },
    async write(state) {
      await adoptLegacyFile();
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const body = JSON.stringify({
          version: THROTTLE_VERSION,
          code: state.code,
          parked: state.parked === true,
          until: state.parked === true ? null : state.until,
          attempt: state.attempt
        });
        await writeFile(temporary, `${body}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, file);
      } catch {
        // A read-only Home must not break the panel: the caller still honours
        // the wait for this process, it just will not outlive it.
      }
    },
    async clear() {
      try {
        await rm(file, { force: true });
      } catch {
        // Nothing to do: an absent file is already a cleared throttle.
      }
      // A legacy file that never got adopted must not resurrect the refusal it
      // holds: a cleared throttle is cleared under both names.
      try {
        await rm(legacyThrottleFile(), { force: true });
      } catch {
        // Nothing to do.
      }
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
  let held = null;
  return {
    async read() {
      return parse(held, now);
    },
    async write(state) {
      held = { version: THROTTLE_VERSION, ...state };
    },
    async clear() {
      held = null;
    }
  };
}
