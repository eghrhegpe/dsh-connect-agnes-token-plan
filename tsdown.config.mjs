// @ts-check
/**
 * The real client build: `src/client/*.ts` → the root `client.js` artifact.
 *
 * The artifact path and filename are load-bearing and stay exactly what they
 * were in the no-build era: `package.json#exports` maps `./client` here, the
 * browser loader evaluates this file's text, and the Node suites import it as
 * a module. Only the provenance changed — it is now generated, and
 * `test/build-gate.mjs` fails the suite when it goes stale.
 *
 * `format: "iife"` is load-bearing, not a style choice: rolldown's syntax
 * detector keys on the tail's `module.exports` branch and an esm build would
 * wrap the bundle in a `__commonJS` shim plus a top-level `export default`,
 * rewriting the loader ABI. An IIFE keeps every statement inside one function
 * scope — the top level is a single expression with no import/export, legal
 * whether the loader evaluates the text as a script or as a module, and the
 * tail's three-world registration branches still run inside it.
 */
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/client/index.ts"],
  outDir: ".",
  format: "iife",
  platform: "browser",
  // react must keep resolving through the loader's module table, never be
  // bundled: the browser world materializes `clientFactory` with its own
  // `require`, and the Node suites hand the factory a stand-in. In the
  // sources the call is `loaderRequire("react")` — a plain parameter call,
  // invisible to the bundler — so this pin is belt and braces for the day a
  // real module-system import shows up.
  deps: { neverBundle: ["react"] },
  // Keep the artifact filename identical to the historical one, and name the
  // IIFE's implied global so rolldown does not warn about unnamed exports.
  outputOptions: { entryFileNames: "client.js", name: "dsh_connect_sensenova_token_plan_client" },
  // outDir is the repo root (the artifact lives at the package root by
  // contract), so tsdown's clean must never run here.
  clean: false,
  minify: false,
  sourcemap: false,
  dts: false,
});
