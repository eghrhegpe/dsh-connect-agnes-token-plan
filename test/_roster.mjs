// Single source of truth for which suites `npm test` runs.
//
// `run.mjs` (the runner) and `package.test.mjs` (the three-way gate) both read
// this module, so the roster can never drift between disk / npm test / CI.
// A previous design duplicated the list as a 24-segment `&&` chain in
// package.json — editing one copy and forgetting the others let a suite run
// for nobody (retry/draw sat orphaned for a release). One module ends that.
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

/**
 * Every default-run offline suite: all `*.test.mjs` in test/.
 * Sorted for deterministic order. `live-*.mjs` and `*-gate.mjs` are NOT
 * `.test.mjs`, so they never enter this set (the gate pins that boundary).
 * @returns {string[]} filenames, e.g. "routes.test.mjs"
 */
export function listSuites() {
  return readdirSync(testDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort();
}

/**
 * Non-suite gates that run after the suite set on a full `npm test`.
 * These are `.mjs` (not `.test.mjs`) and are intentionally excluded from the
 * default roster — a clean checkout without a build emits loud SKIP, not fail.
 *
 * `tsc-gate` is the type layer: `i18n.ts`'s `const en: typeof zh`, the
 * `wire.ts` mirror, and the strict flags in tsconfig.json are all compile-time
 * fences, and a compile-time fence nothing runs is not a fence. It sat red at
 * HEAD on 2026-10-02 with no gate, no CI job, and 24 green suites.
 * @type {string[]}
 */
export const GATES = ["tsc-gate.mjs", "build-gate.mjs", "e2e-gate.mjs"];
