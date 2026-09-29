// @ts-check
/**
 * Dry-run build config: the pipeline rehearsal for the client.js split
 * (docs/ROADMAP.md §6.2), runnable BEFORE any source is moved.
 *
 * Today `client.js` at the package root is both the only source and the
 * shipped artifact, so this config is a passthrough with one job: prove the
 * bundler can reproduce the loader ABI — the `clientFactory(require)` shape,
 * the `window.__ModuleLoader__.load(REGISTRATION)` tail, and the no-top-level
 * import/export rule that makes the file legal ESM in all three module worlds.
 * `test/build-gate.mjs` asserts exactly that, artifact vs source.
 *
 * When the split lands, this file is deleted and a `tsdown.config.mjs` takes
 * over (entry `src/client/index.js`, output `./client.js`); the gate's
 * comparison flips to a rebuild-freshness check. Kept as a separate file
 * rather than a flag on the real config so the real config cannot run while
 * `src/client/` does not exist yet.
 *
 * Run: `npm run build:client:dry` (output goes to `tmp/build-dry/`, gitignored).
 */
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["client.js"],
  outDir: "tmp/build-dry",
  // IIFE, not ESM: rolldown's syntax detector keys on the tail's
  // `module.exports` branch and an esm build would wrap the file in a
  // `__commonJS` shim plus a top-level `export default` — rewriting the loader
  // ABI. An IIFE keeps every statement of the source inside one function
  // scope: the top level is a single expression with no import/export, legal
  // whether the loader evaluates the text as a script or as a module, and the
  // tail's three-world branches still run inside it, byte-for-byte in meaning.
  format: "iife",
  platform: "browser",
  // react must keep resolving through the loader's module table, never be
  // bundled: the browser world materializes `clientFactory` with its own
  // `require`, and the Node suites hand the factory a stand-in.
  deps: { neverBundle: ["react"] },
  // keep the artifact filename identical to the source's, and name the IIFE's
  // implied global (rolldown detects the source as CJS — see above — so it
  // thinks the bundle has exports and warns without a name).
  outputOptions: { entryFileNames: "client.js", name: "dsh_connect_sensenova_token_plan_client" },
  minify: false,
  sourcemap: false,
  dts: false,
});
