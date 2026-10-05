// @ts-check
/**
 * Duplication gate (jscpd).
 *
 * A POSITIVE regression fence, not a style nagger: it does not demand zero
 * duplication. src/ already carries a measured floor — the `draw`/`video`
 * isomorphism the docs name as a design fact (video.ts mirrors draw.ts by
 * intent) — so the gate pins that floor and fails only when a NEW large copy
 * pushes src above it. Threshold is in DUPLICATED-TOKEN percent; the 2026-10-02
 * baseline is ~1.0% over 81 files at `--min-tokens 70`, so 3% leaves headroom
 * for legitimate shared helpers while still catching a wholesale paste.
 *
 * Same skip rule as test/build-gate.mjs and test/e2e-gate.mjs: if jscpd is not
 * installed, print a loud SKIP and exit 0 — a bare checkout with no dev deps is
 * not a regression. CI's offline job installs devDeps and runs this for real,
 * so a new copy that crosses the fence is red there.
 *
 * It lives in _roster.mjs's GATES (like tsc-gate / build-gate), so package.test.mjs
 * does NOT sweep it into the three-way `*.test.mjs` roster — this gate reads the
 * whole of src/, so its own clone report could otherwise feed the fence it owns.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(root, "node_modules", "jscpd", "package.json"))) {
  process.stderr.write(
    `\n[dup-gate] SKIPPED — jscpd is not installed.\n` +
    `[dup-gate]   Bootstrap dev deps with: npm i -D jscpd --legacy-peer-deps\n` +
    `[dup-gate]   (the repo's peerDependencies are Host-runtime packages and do not\n` +
    `[dup-gate]   resolve from a registry, so a plain npm install cannot run here).\n\n`
  );
  process.exit(0);
}

const MIN_TOKENS = 70;
const THRESHOLD = 3; // duplicated-token percent; see header for the 2026-10-02 baseline

const run = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["--no-install", "jscpd", "src", "--min-tokens", String(MIN_TOKENS), "--threshold", String(THRESHOLD), "--reporters", "console"],
  { cwd: root, shell: true, encoding: "utf8", timeout: 180_000 }
);

const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
process.stdout.write(out);

if (run.error) {
  console.error(`\n[dup-gate] FAILED to run jscpd: ${run.error.message}`);
  process.exit(1);
}
if (run.status !== 0) {
  console.error(
    `\n[dup-gate] FAILED — src/ exceeded ${THRESHOLD}% duplicated tokens.\n` +
    `[dup-gate]   The clone report above names the copies. If the new duplication is\n` +
    `[dup-gate]   legitimate shared code, factor it into one place (the pattern the\n` +
    `[dup-gate]   draw/video pair follows); do not raise the threshold to pass a paste.\n`
  );
  process.exit(1);
}
console.log(`\nall dup-gate checks passed (src under ${THRESHOLD}% duplicated tokens)`);
