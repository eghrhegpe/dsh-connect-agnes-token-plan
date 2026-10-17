/**
 * Resolve the dsh CLI's own `node_modules` — the ONE tree an isolated e2e
 * profile can safely share. Used by BOTH `e2e.mjs` (which links it) and
 * `e2e-gate.mjs` (which must decide whether the suite can run at all).
 *
 * ## Why the CLI's install tree
 *
 * The Loader resolves every bundle — `@deepseek-ai/dsh-base` included, and the
 * Host's own internals with it — relative to `<DSH_HOME>/profiles`, NOT relative
 * to wherever the CLI was installed. A hand-built temp home therefore has no
 * packages to find, and the boot dies with 154 × `Cannot find package
 * '<runtime dep>'`: a failure that reads exactly like a plugin regression and is
 * nothing but a missing shared directory. (It is not even about this plugin —
 * an isolated profile with no plugin at all fails the same way, and so does one
 * built from a commit predating the change under test.)
 *
 * The CLI's install tree is the right source, and the only one that is both
 * complete and isolated: it is exactly the package set this CLI version was
 * built against, and it carries no user plugins (`dsh-connect-*` count: zero),
 * so sharing it cannot pull the developer's real profile in. The unpacked
 * desktop runtime under `~/.dsh` looks like a candidate and is not one: it is a
 * different version, which shows up as a third of its entries failing to
 * activate.
 *
 * ## Why this is its own module (2026-10-17)
 *
 * The resolver used to live inside `e2e.mjs`, and the gate could not see it: the
 * gate's only precondition was "does `dsh --version` exit 0", so a machine whose
 * `npm` and whose `dsh` shim come from DIFFERENT prefixes (a managed Node
 * runtime next to an `%APPDATA%\npm` global install — the ordinary shape on this
 * project's own dev boxes) satisfied the gate, resolved no tree, and turned an
 * environment gap into `VERDICT=FAILED`. That is the gate's own contract broken:
 * "an environment that cannot run the suite must SKIP, never fail". One resolver,
 * two callers, so the precondition cannot drift from what the suite actually
 * needs.
 *
 * ## Two probes, one anchor
 *
 * `npm root -g` is the canonical answer and stays FIRST, because CI installs the
 * CLI with `npm install -g` and that is exactly the tree it reports. It is not
 * sufficient: it reports the prefix of whichever `npm` is on PATH, while `dsh`
 * may resolve from a different directory on the same PATH. So the second probe
 * walks PATH for the shim itself and derives the prefix from it, covering both
 * the Windows layout (`<prefix>\npm\node_modules`) and the POSIX one
 * (`<prefix>/lib/node_modules`).
 *
 * `undefined` means neither probe found a runtime tree. The gate SKIPs on it;
 * a bare `node test/e2e.mjs` leaves the temp home as it was and lets the boot
 * failure say what it could not find.
 *
 * @module test/cli-runtime
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The marker package: a directory is a Host runtime only if it carries this.
 * Without it, linking the directory would only trade one ERR_MODULE_NOT_FOUND
 * for another.
 */
const ANCHOR = ["@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-base"];

/**
 * The tree to link, given a directory that may HOLD the CLI package.
 *
 * The return is the CLI package's OWN `node_modules`, not the directory that
 * contains it: `@deepseek-ai/dsh-base` and the rest of the runtime sit under
 * `<dir>/@deepseek-ai/dsh/node_modules`, and a profile resolves bundles from the
 * top level of the linked directory. Returning `<dir>` instead links a tree whose
 * top level holds only `@deepseek-ai/dsh` — the boot then reports every one of
 * its 154 plugins as "failed to import" (measured 2026-10-17, first draft of
 * this module). The anchor below is the same path, so "found" and "returned"
 * cannot disagree.
 * @param {string|undefined} dir - a candidate `node_modules`.
 * @returns {string|undefined} the CLI's own `node_modules`, or undefined.
 */
function runtimeIn(dir) {
  if (typeof dir !== "string" || dir === "") return undefined;
  const tree = join(dir, ...ANCHOR.slice(0, 3));
  return existsSync(join(dir, ...ANCHOR)) ? tree : undefined;
}

/**
 * What `npm root -g` reports — the global `node_modules` of the `npm` on PATH.
 * @returns {string|undefined} the directory, or undefined when npm cannot answer.
 */
function npmGlobalRoot() {
  const root = spawnSync("npm", ["root", "-g"], { shell: true, encoding: "utf8", timeout: 30_000 });
  if (root.error !== undefined || root.status !== 0) return undefined;
  const prefix = root.stdout.trim();
  return prefix === "" ? undefined : prefix;
}

/**
 * The directory the `dsh` shim itself lives in, found by walking PATH.
 *
 * Walking PATH is deliberate: shelling out to `which`/`where` is one more
 * platform to get wrong, and the file test is the same question those commands
 * answer. Windows checks the executable extensions first, because `dsh` alone
 * is the POSIX shim npm writes beside the `.cmd` one.
 * @returns {string|undefined} the shim's directory, or undefined when not found.
 */
function shimDir() {
  const names = process.platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh"] : ["dsh"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      if (existsSync(join(dir, name))) return dir;
    }
  }
  return undefined;
}

/**
 * The `node_modules` an isolated e2e profile should share with the CLI.
 * @returns {string|undefined} a `node_modules` directory, or undefined when the
 *   CLI is not an npm install the two probes can locate (a packaged desktop app
 *   has no global tree).
 */
export function cliRuntimeModules() {
  const candidates = [];
  const npmRoot = npmGlobalRoot();
  if (npmRoot !== undefined) candidates.push(npmRoot);
  const shim = shimDir();
  if (shim !== undefined) {
    // Windows: the global prefix IS the bin directory.
    candidates.push(join(shim, "node_modules"));
    // POSIX and anything npm-shaped: <prefix>/bin + <prefix>/lib/node_modules,
    // or a bin directory that is one level inside the prefix.
    candidates.push(join(shim, "..", "node_modules"));
    candidates.push(join(shim, "..", "lib", "node_modules"));
  }
  for (const dir of candidates) {
    const tree = runtimeIn(dir);
    if (tree !== undefined) return tree;
  }
  return undefined;
}
