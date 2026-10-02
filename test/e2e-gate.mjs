/**
 * Gate for the end-to-end run inside `npm test`.
 *
 * The e2e suite boots a REAL `dsh web` process, so it is slower than the offline
 * suites and needs the dsh CLI on PATH (or `DSH_CLI` pointing at it). That makes
 * it the one check that cannot be assumed to run everywhere — a clean CI box has
 * no dsh installed. But "sometimes can't run" must not mean "never runs": this
 * plugin's most dangerous historical bug (a nested `auth:` block silently
 * ignored, so the panel POSTED A REAL LOGIN to the platform) was caught ONLY by
 * e2e, and keeping e2e out of the default gate left that whole class unguarded
 * between manual runs.
 *
 * So the rule is: if the CLI is present, RUN the e2e and propagate its exit
 * code — a genuine failure fails the build. If it is absent, print a loud SKIP
 * and exit 0, because refusing to install dsh is not a regression. The skip is
 * surfaced on stderr precisely so it cannot pass unnoticed in a green run.
 */
import { spawnSync } from "node:child_process";

const DSH = process.env.DSH_CLI ?? "dsh";

function cliPresent() {
  // An unset OR EMPTY override both mean "use whatever PATH says", so treat an
  // empty string as absent rather than feeding it to spawnSync. Passing "" as
  // the file makes Node throw ERR_INVALID_ARG_VALUE synchronously — so a bare
  // `export DSH_CLI=` (or a workflow `env: DSH_CLI: ${{ }}` that expands empty)
  // crashed this gate with a stack trace and exit 1, the exact opposite of the
  // contract below: an environment that cannot run the suite must SKIP, never
  // fail. A non-empty value that does not exist is the ordinary case and still
  // resolves through probe.error.
  if (DSH === "") return false;
  // Ask the CLI itself rather than trusting PATH bookkeeping; `--version` is the
  // cheapest thing that proves the shim resolves AND runs. shell:true mirrors how
  // e2e.mjs spawns it, so a Windows .cmd shim behaves the same here as there.
  const probe = spawnSync(DSH, ["--version"], { shell: true, encoding: "utf8", timeout: 30_000 });
  return !probe.error && probe.status === 0;
}

if (!cliPresent()) {
  process.stderr.write(
    `\n[e2e] SKIPPED — the "${DSH}" CLI is not available on this machine.\n` +
    `[e2e]   Install DSH or set DSH_CLI to run the end-to-end suite (npm run test:e2e).\n` +
    `[e2e]   This is the only suite that boots a real Host; do not treat the green run\n` +
    `[e2e]   above as having exercised the loader, routes, or trust fence.\n\n`
  );
  // Machine-readable verdict. The SKIP exits 0 by design, so a green badge alone
  // says nothing about whether the loader was exercised — a CI log that only
  // carries the prose above needs a human to read it. Emitting one stable token
  // lets `.github/workflows/ci.yml` promote the outcome into the job summary
  // instead of trusting a green icon.
  process.stderr.write(`[e2e] VERDICT=SKIPPED (dsh CLI absent)\n\n`);
  process.exit(0);
}

const run = spawnSync(process.execPath, ["test/e2e.mjs"], { stdio: "inherit" });
// The count is already in e2e.mjs's output; this line only names the outcome so
// the same verdict is greppable whether the suite ran, skipped, or crashed.
const code = run.status === null ? 1 : run.status;
process.stderr.write(`\n[e2e] VERDICT=${code === 0 ? "PASSED" : "FAILED"} (exit ${code})\n\n`);
process.exit(code);
