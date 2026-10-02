// @ts-check
/**
 * Gate for the TYPE LAYER (tsc -p tsconfig.json).
 *
 * Why this exists at all: the project's single-source-of-truth discipline leans
 * on TypeScript in three places where a runtime suite CANNOT stand in —
 *
 *   1. `src/client/i18n.ts` declares `const en: typeof zh`, so a key added to
 *      one dictionary and not the other is supposed to be a COMPILE error. The
 *      runtime parity check in `panel.test.mjs` F3 covers the same ground, but
 *      it can only compare the dictionaries the bundle actually shipped.
 *   2. `src/client/wire.ts` is a deliberate, documented duplicate of the Host's
 *      snapshot shape; the contract suites pin the KEYS, and tsc pins the types.
 *   3. `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` are on in
 *      tsconfig.json, which is what turns "indexed a possibly-undefined code"
 *      into a build failure.
 *
 * On 2026-10-02 this gate did not exist, `npm test` never ran tsc, tsdown does
 * not type-check, and CI had no typecheck job — so `npm run typecheck` sat RED
 * at HEAD (`account-form.ts(118,39)` TS2538) for an unknown number of commits,
 * with every promise above resting on a command nobody ran. The offline suites
 * were green the whole time. That is the failure mode this gate closes: a
 * compile-time fence is only a fence if something fails when it is crossed.
 *
 * Same convention as test/build-gate.mjs: resolve `tsc` from the repo first,
 * fall back to a globally installed one (this repo's peers do not resolve from
 * a registry, so a bare clone may have no local devDeps at all), and print a
 * loud SKIP with exit 0 when neither exists — an environment that cannot run
 * tsc is not a regression. CI's offline job installs devDeps, so the SKIP path
 * only covers a bare clone.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  if (!pass) console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

// Two ways to reach tsc, in preference order:
//   * `node <repo>/node_modules/typescript/bin/tsc` — what CI installs, and
//     what a contributor gets from `npm install`. Spawning the JS entry point
//     through the current node (rather than the `.bin` shim) avoids the
//     "shell exit code 1 on Windows" class of noise.
//   * the GLOBAL install, located through `npm root -g`. This is deliberately
//     not `npx --no-install tsc`: npx resolves the LOCAL `node_modules/.bin`
//     first, so when the local copy is the broken one, the fallback would be
//     blocked by that same file and the gate would wrongly conclude that no
//     compiler exists anywhere. Resolving the global root explicitly keeps the
//     two candidates independent.
//
// The local one is probed first, and the global one only if the local cannot
// run (probing is a real subprocess, so the healthy path pays for one). A local
// install that exists but does not RUN is not the same situation as no local
// install: the first is a broken environment, the second is a bare clone.
const localTsc = join(root, "node_modules", "typescript", "bin", "tsc");
const hasLocal = existsSync(localTsc);

const spawnLocal = (args) => spawnSync(process.execPath, [localTsc, ...args], { cwd: root, shell: false, encoding: "utf8", timeout: 300_000 });

/** The globally installed tsc, or null when npm/global-typescript is absent. */
const globalTsc = (() => {
  const found = spawnSync("npm", ["root", "-g"], { cwd: root, shell: true, encoding: "utf8", timeout: 60_000 });
  if (found.error || found.status !== 0) return null;
  const globalRoot = String(found.stdout ?? "").trim();
  if (globalRoot === "") return null;
  const candidate = join(globalRoot, "typescript", "bin", "tsc");
  return existsSync(candidate) ? candidate : null;
})();

const spawnGlobal = (args) => spawnSync(process.execPath, [globalTsc, ...args], { cwd: root, shell: false, encoding: "utf8", timeout: 300_000 });

/** Probe a spawner; returns its version string, or null when it cannot run. */
const versionOf = (spawner) => {
  const probe = spawner(["--version"]);
  if (probe.error || probe.status !== 0) return null;
  const text = String(probe.stdout ?? "").trim();
  return text === "" ? null : text;
};

const localVersion = hasLocal ? versionOf(spawnLocal) : null;
const globalVersion = localVersion === null && globalTsc !== null ? versionOf(spawnGlobal) : null;

// Version alignment. `npm test` must not answer differently depending on which
// tsc a machine happens to have: a newer compiler can report errors an older
// one accepts (and vice versa), so a global fallback that is a different MAJOR
// from the version this repo declares would make the gate's verdict a property
// of the environment rather than of the code. The declared range is read from
// package.json rather than hardcoded, so bumping the devDependency keeps the
// two in step; only the major is compared, which is the granularity at which
// TypeScript's diagnostics actually move.
const declaredMajor = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const range = String(pkg?.devDependencies?.typescript ?? pkg?.dependencies?.typescript ?? "");
    const match = range.match(/\d+/);
    return match === null ? null : Number(match[0]);
  } catch {
    return null;
  }
})();
const majorOf = (version) => {
  const match = String(version).match(/(\d+)\./);
  return match === null ? null : Number(match[1]);
};

if (globalVersion !== null && declaredMajor !== null && majorOf(globalVersion) !== declaredMajor) {
  process.stderr.write(
    `\n[tsc-gate] SKIPPED — the only usable tsc is a different major than declared.\n` +
    `[tsc-gate]   Global tsc: ${globalVersion} (${globalTsc})\n` +
    `[tsc-gate]   package.json declares typescript ${declaredMajor}.x\n` +
    `[tsc-gate]   Install the declared one: npm install --legacy-peer-deps --no-audit --no-fund\n\n`
  );
  process.exit(0);
}

if (localVersion === null && globalVersion === null) {
  process.stderr.write(
    `\n[tsc-gate] SKIPPED — no usable TypeScript compiler.\n` +
    `[tsc-gate]   Local lookup: ${localTsc} (${hasLocal ? "present but did not run" : "absent"})\n` +
    `[tsc-gate]   Global lookup: ${globalTsc ?? "(not installed)"}${globalTsc === null ? "" : " (did not run)"}\n` +
    `[tsc-gate]   Bootstrap dev deps with: npm install --legacy-peer-deps --no-audit --no-fund\n` +
    `[tsc-gate]   (the repo's peerDependencies are Host-runtime packages and do not\n` +
    `[tsc-gate]   resolve from a registry, so a plain npm install cannot run here).\n\n`
  );
  // A local typescript that is PRESENT yet cannot run is a broken install, not
  // a bare clone — failing loudly here is what keeps a half-installed CI job
  // from silently turning this gate back into the no-op it replaced.
  if (hasLocal) {
    process.stderr.write(
      `[tsc-gate] FAIL — node_modules/typescript exists but could not run; this is a broken\n` +
      `[tsc-gate]   install, not a missing one. Re-run: npm install --legacy-peer-deps\n\n`
    );
    process.exit(1);
  }
  process.exit(0);
}

const version = localVersion ?? globalVersion;
const run = localVersion !== null ? spawnLocal : spawnGlobal;

// The real run. `-p tsconfig.json` is exactly what `npm run typecheck` does, so
// a green here and a green there cannot disagree.
const result = run(["-p", "tsconfig.json"]);
const output = `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`.trim();

check(`${version} accepts tsconfig.json with no diagnostics`,
  result.error === undefined && result.status === 0,
  output.slice(-4000) || String(result.error ?? ""));

// A guard on the guard: tsconfig's `include` is what decides whether a file is
// even looked at, and a client/host file silently dropping out of it would keep
// this gate green while nothing checks that file any more. `checkJs: false` is
// deliberate (plain .js is checked only through a top-level `// @ts-check`), so
// this asserts the SRC halves are in scope, not that everything is.
{
  const tsconfigPath = join(root, "tsconfig.json");
  /** @type {unknown} */
  let include = null;
  try {
    // tsconfig.json here is JSON with comments tolerated by tsc; strip the
    // //-comments rather than pulling in a JSONC dependency for one read.
    const text = readFileSync(tsconfigPath, "utf8").replace(/^\s*\/\/.*$/gm, "");
    include = JSON.parse(text)?.include ?? null;
  } catch (error) {
    check("tsconfig.json is readable", false, String(error));
  }
  if (Array.isArray(include)) {
    const globs = include.map((glob) => String(glob));
    check("tsconfig's include still covers both source halves",
      globs.some((glob) => glob.includes("src/host")) && globs.some((glob) => glob.includes("src/client")),
      JSON.stringify(globs));
  } else {
    check("tsconfig.json declares an include list", false, JSON.stringify(include));
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
