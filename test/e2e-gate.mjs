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
  process.exit(0);
}

const run = spawnSync(process.execPath, ["test/e2e.mjs"], { stdio: "inherit" });
process.exit(run.status === null ? 1 : run.status);
