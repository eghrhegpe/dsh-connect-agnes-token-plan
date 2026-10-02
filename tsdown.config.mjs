// @ts-check
/**
 * Build configuration. `src/` holds ALL sources (host + client); `lib/` and
 * the root `client.js` are pure build artifacts, fully rebuildable from
 * `src/`, and are TRACKED in git (committed so a git/marketplace install
 * clones them ready to load — pnpm's `packageShouldBeBuilt` skips the build
 * pipeline when the main file is present). Nothing hand-edited in `lib/`:
 * rebuild after every src change and commit the artifacts with it.
 *
 * Two entries:
 *
 * 1. HOST — `src/host/index.ts` bundled to a single `lib/index.js`. A single
 *    bundle (not preserve-modules) is deliberate: the published surface is one
 *    entry point (`package.json#main` + `exports["."]`), and the offline suites
 *    import the SOURCES directly (`../src/host/*.ts`, Node strips types
 *    natively on 22.19+/24), so no per-module `lib/` output is needed for
 *    either the runtime or the tests. Every peer package stays external.
 *
 * 2. CLIENT — `src/client/index.ts` bundled to the root `client.js` artifact
 *    (IIFE, see below). Its path/filename/loader-ABI are contracts:
 *    `package.json#exports`, the browser loader, and `client-surface.js` all
 *    consume the same file. It is GENERATED and `test/build-gate.mjs` fails the
 *    suite when it goes stale.
 *
 * `format: "iife"` (client) is load-bearing, not a style choice: rolldown's
 * syntax detector keys on the tail's `module.exports` branch and an esm build
 * would wrap the bundle in a `__commonJS` shim plus a top-level `export
 * default`, rewriting the loader ABI. An IIFE keeps every statement inside one
 * function scope — the top level is a single expression with no import/export,
 * legal whether the loader evaluates the text as a script or as a module, and
 * the tail's three-world registration branches still run inside it.
 */
import { defineConfig } from "tsdown";

/** Peer packages that must resolve from the Host runtime, never be bundled. */
const NEVER_BUNDLE = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-llm-pi-ai",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-host-webserver",
  "@deepseek-ai/schemastery",
  "@earendil-works/pi-ai",
];

export default defineConfig([
  {
    name: "host",
    entry: ["src/host/index.ts"],
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2023",
    // One entry, one `lib/index.js`, with the peer-dependent modules arriving
    // as dynamic chunks: the published surface is one entry point
    // (`package.json#main` + `exports["."]`), and the offline suites import the
    // SOURCES directly, so a per-module `lib/` output is needed by neither the
    // runtime nor the tests. Code splitting stays on (the rolldown default for
    // the sources' dynamic `import()`s); a single-bundle build would need
    // `outputOptions.inlineDynamicImports` instead — don't add a top-level
    // `splitting` key, tsdown has no such option and it is silently ignored.
    clean: true,
    minify: false,
    sourcemap: false,
    dts: false,
    outExtensions: () => ({ js: ".js" }),
    deps: { neverBundle: [...NEVER_BUNDLE] },
  },
  {
    name: "client",
    entry: ["src/client/index.ts"],
    outDir: ".",
    format: "iife",
    platform: "browser",
    target: "es2020",
    // react must keep resolving through the loader's module table, never be
    // bundled: the browser world materializes `clientFactory` with its own
    // `require`, and the Node suites hand the factory a stand-in. In the
    // sources the call is `loaderRequire("react")` — a plain parameter call,
    // invisible to the bundler — so this pin is belt and braces.
    deps: { neverBundle: ["react"] },
    outputOptions: {
      entryFileNames: "client.js",
      // The IIFE's global variable name. Nothing reads it back — the artifact
      // registers through `window.__ModuleLoader__` and `module.exports`, and
      // the ESM branch touches no global — so it is inert; named after the
      // plugin for greppability (it was a stale SenseNova-era identifier).
      name: "dsh_connect_agnes_token_plan_client",
    },
    // outDir is the repo root (the artifact lives at the package root by
    // contract), so tsdown's clean must never run here.
    clean: false,
    minify: false,
    sourcemap: false,
    dts: false,
  },
]);
