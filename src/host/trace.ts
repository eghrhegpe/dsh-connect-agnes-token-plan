/**
 * Login-trace persistence.
 *
 * Every sign-in attempt (success included) leaves one sanitized trace file in
 * `$DSH_HOME/logs/`: a "browser works but the panel does not" report is only
 * debuggable by diffing a working trace against a failing one. The sanitizing
 * itself happens in `agnes-auth.ts` — no password, token, cookie, or
 * authorization code ever reaches this module — so the only concern here is
 * I/O failures, which must never break the login response.
 * @module dsh-connect-agnes-token-plan/trace
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { str, redactSecrets } from "./util.ts";

/**
 * Where login traces are written. `$DSH_HOME/logs/` keeps them next to the
 * other Host logs; `DSH_HOME` defaults to `~/.dsh`.
 */
export function traceDir() {
  const home = str(process.env.DSH_HOME, join(homedir(), ".dsh"));
  return join(home, "logs");
}

/**
 * Persist one login trace to disk, or fail silently.
 *
 * Written on EVERY attempt (success included): a "browser works but the panel
 * does not" report is only debuggable by diffing a working trace against a
 * failing one. The trace itself is already sanitized in Agnes-auth — no
 * password, token, cookie, or authorization code ever reaches this file — so
 * the only concerns here are I/O failures, which must never break the login
 * response.
 * @param {object[]|undefined} trace - the sanitized hop list from the auth module.
 * @param {string} outcome - "ok" or the error code, for the filename.
 * @param {{logger?: {warn?: (message: string, ...rest: unknown[]) => void}|undefined}} [options]
 *   a logger to receive the reason when NOTHING was written. Optional in
 *   signature, but the caller should pass one: see the catch below for why a
 *   silent `null` is not an acceptable outcome here.
 * @returns {Promise<string|null>} the file path, or null when not written.
 */
export async function writeLoginTrace(
  trace: object[] | undefined,
  outcome: string,
  options: { logger?: { warn?: (message: string, ...rest: unknown[]) => void } | undefined } = {}
) {
  if (!Array.isArray(trace) || trace.length === 0) return null;
  const dir = traceDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `agnes-login-${stamp}-${str(outcome, "unknown").replace(/[^a-z_]/gi, "")}.json`);
    await fs.writeFile(file, `${JSON.stringify(trace, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // Keep the directory from growing forever: the last 20 traces are plenty.
    const files = (await fs.readdir(dir)).filter((name) => name.startsWith("agnes-login-")).sort();
    for (const stale of files.slice(0, Math.max(0, files.length - 20))) {
      await fs.rm(join(dir, stale), { force: true }).catch(() => {});
    }
    return file;
  } catch (error) {
    // Nothing was written and all the caller can see is `null`, so the reason
    // has to be reported HERE or it is lost. This matters more than a usual
    // swallowed I/O error: red line ⑤ makes this file the ONLY record of a
    // sign-in attempt, so a write that silently failed leaves the red line
    // true in the source and false on disk — and the one artifact a "browser
    // works, the panel does not" question depends on is simply absent, with
    // nothing anywhere saying so.
    try {
      const detail = redactSecrets(error instanceof Error ? error.message : String(error));
      options.logger?.warn?.(`agnes login trace was NOT written to ${dir}: ${detail}`);
    } catch {
      /* a logger that throws must not break the sign-in it was reporting */
    }
    return null;
  }
}
