// Single test runner. Replaces the 24-segment `&& node test/*.test.mjs`
// chain that used to live in package.json's `test` script.
//
//   node test/run.mjs            # all *.test.mjs, then build-gate + e2e-gate
//   node test/run.mjs --only X   # only suites whose filename contains X
//   node test/run.mjs --list     # print the roster
//
// The roster comes from `_roster.mjs` — the same module `package.test.mjs`
// reads, so the three-way gate (disk / npm test / CI) stays exact. `--only`
// runs a subset and skips the gates (it is a focused re-run, not the full
// gate); the full `npm test` still runs every suite plus both gates.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listSuites, GATES } from "./_roster.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const only = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--list") {
    console.log(listSuites().join("\n"));
    process.exit(0);
  } else if (a === "--only") {
    only.push(args[++i]);
  } else if (a.startsWith("--only=")) {
    only.push(a.slice("--only=".length));
  }
}

const all = listSuites();
const suites = only.length
  ? all.filter((name) => only.some((p) => name.includes(p)))
  : all;

if (only.length && suites.length === 0) {
  console.error(`run.mjs: no suite matches ${JSON.stringify(only)}`);
  process.exit(2);
}

let failed = 0;
const failures = [];
for (const name of suites) {
  const res = spawnSync(process.execPath, [join(testDir, name)], { stdio: "inherit" });
  if (res.status !== 0) {
    failed += 1;
    failures.push(name);
  }
}

// Gates run only on a full run — a `--only` subset is a focused re-run.
if (!only.length) {
  for (const gate of GATES) {
    const res = spawnSync(process.execPath, [join(testDir, gate)], { stdio: "inherit" });
    if (res.status !== 0) {
      failed += 1;
      failures.push(gate);
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} suite(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(
  `\nall ${suites.length} suite(s) passed${only.length ? " (subset)" : " (incl. gates)"}`
);
