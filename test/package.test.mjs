/**
 * Packaging single-source pin: `files` must cover the import graph.
 *
 * `package.json#files` is what a tarball (`npm pack`, any registry or bundle
 * path that respects it) actually ships, and it is a hand-authored list — so
 * it drifts the same way a hand-authored mirror does. It already did once:
 * five modules `index.js` imports statically (`host-config`, `console-client`,
 * `parsers`, `trace`, `util`) were missing from it, which means every packed
 * copy of this plugin failed at load. Nothing caught it because the suite
 * exercises the checkout, never the tarball.
 *
 * This walks the static relative import graph from the published entry points
 * (`main` + `exports`) and fails when a reachable file is not listed in
 * `files`. No peer package, no pack step — plain text reads, so it runs on a
 * clean checkout like `config.test.mjs`.
 *
 * It also pins the TEST-GATE roster three ways — the suites on disk, the
 * `npm test` chain, and the CI offline job. The trigger was real:
 * `retry.test.mjs` and `draw.test.mjs` (89 peer-free checks over the 429
 * self-heal and the draw absorption) passed standalone for a whole release
 * while no gate ran them. A suite that exists but runs nowhere is the same
 * drift class as a module that ships but is missing from `files` — so it
 * earns the same nail.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

/** The published whitelist, as bare paths. */
const shipped = new Set((manifest.files ?? []).map((entry) => entry.replace(/^\.\//, "")));

// --- 1. every entry point is itself shipped -------------------------------
// `package.json` is excluded: npm ships it into every tarball unconditionally,
// so requiring it in `files` would pin a rule the packer does not have.
const entries = [...new Set([
  manifest.main,
  ...Object.values(manifest.exports ?? {}).filter((value) => typeof value === "string")
].map((entry) => entry.replace(/^\.\//, "")))].filter((entry) => entry !== "package.json");
for (const entry of entries) {
  check(`entry ${entry} is in files`, shipped.has(entry), shipped.has(entry) ? "" : "entry missing from files");
}

/**
 * Static relative imports of one module: `from "./x.js"`, `import "./x.js"`,
 * `import("./x.js")`, and — added after a bare `require("./client-core.js")`
 * shipped to HEAD unnoticed — factory-form `require("./x.js")`. Bare
 * specifiers (react, peer packages) are ignored: those are the runtime's
 * problem, not the tarball's.
 * @param {string} source - the module's text.
 * @returns {string[]} the imported paths, without the `./` prefix.
 */
function staticImports(source) {
  const found = [];
  const pattern = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'](\.\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    found.push(match[1].replace(/^\.\//, ""));
  }
  return found;
}

// --- 2. every module reachable from an entry is shipped -------------------
// The walk is over the real files on disk, so a new import added anywhere in
// the graph is checked without touching this test.
const seen = new Set();
const queue = [...entries.filter((entry) => entry.endsWith(".js"))];
while (queue.length > 0) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  const source = readFileSync(join(root, file), "utf8");
  for (const dep of staticImports(source)) {
    if (!seen.has(dep)) queue.push(dep);
  }
}
check("the import graph is walkable", seen.size > 0, `${seen.size} module(s) reached`);
for (const file of [...seen].sort()) {
  check(`${file} reachable from the entries is in files`, shipped.has(file), shipped.has(file) ? "" : "would be missing from the tarball");
}

// --- 3. every shipped .js module exists (no stale leftovers) --------------
for (const entry of shipped) {
  if (!entry.endsWith(".js")) continue;
  let present = true;
  try {
    readFileSync(join(root, entry));
  } catch {
    present = false;
  }
  check(`shipped ${entry} exists`, present, present ? "" : "listed but absent on disk");
}

// --- 4. no root module ships that nothing references ----------------------
// A file left in `files` after its importer was deleted is dead weight in
// every tarball — the mirror of the missing-file bug, in the other direction.
const rootModules = readdirSync(root).filter((name) => name.endsWith(".js"));
for (const name of rootModules) {
  if (seen.has(name)) continue;
  check(`${name} is not shipped while unreferenced`, !shipped.has(name), shipped.has(name) ? "shipped but unreachable from the entries" : "");
}

// --- 5. the browser bundle resolves packages, never paths ------------------
// The Client module table's synchronous `require` (dsh-client-modules,
// `makeRequire`) looks specifiers up by seed word and registered FACTORY ID;
// only `require.async` accepts a `./` path, and only for build-time chunks.
// An unbuilt bundle that requires a relative path therefore loads fine under
// Node in tests — where `import` resolves paths — and throws "missed the
// module table" in the browser: a split that is green everywhere except the
// thing it ships to. This pins the bundle to package specifiers only.
{
  // Full-line comments are dropped first: the bundle documents its own
  // loading story in prose that mentions example specifiers, and a pin that
  // red-flags its own documentation would be deleted rather than kept.
  const clientSource = readFileSync(join(root, "client.js"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
  const relatives = [...clientSource.matchAll(/require\s*\(\s*["'](\.\/[^"']+)["']/g)].map((match) => match[1]);
  check("the browser bundle requires no relative path", relatives.length === 0, relatives.join(", "));
  const required = [...new Set([...clientSource.matchAll(/require\s*\(\s*["']([^"']+)["']/g)].map((match) => match[1]))];
  check("the browser bundle requires only the platform's package seeds",
    required.every((spec) => spec === "react"), required.join(", "));
}

// --- 6. the test-gate roster is one fact, not three mirrors ----------------
// A suite that exists on disk but is not wired into `npm test` runs for
// nobody; a suite in `npm test` but not in the CI offline job is a local-only
// gate; a CI line naming a removed file rots silently. All three happened or
// were one refactor away. `retry.test.mjs` and `draw.test.mjs` (89 peer-free
// checks over the shipped 429 self-heal and draw-absorption code) sat in the
// first bucket until this pin.
//
// The one deliberate exception is the network tier: `live-jwks.test.mjs` is
// NOT a default-run check (a green offline run must not reach the platform),
// so it is exempted here and pinned EXCLUDED by its own header.
{
  const TEST_DIR = join(root, "test");
  const EXEMPT = new Set(["live-jwks.test.mjs"]);

  const disk = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".test.mjs"))
    .filter((name) => !EXEMPT.has(name));

  const listed = (text) => new Set(
    [...text.matchAll(/node test\/([\w.-]+\.test\.mjs)/g)].map((m) => m[1])
  );
  const npmTest = listed(manifest.scripts.test ?? "");
  const ciText = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  const ci = listed(ciText);

  // disk ⊆ npmTest and disk ⊆ ci: no orphaned suite.
  for (const name of disk) {
    check(`${name} is wired into the npm test chain`, npmTest.has(name),
      npmTest.has(name) ? "" : "exists on disk but never run by `npm test`");
    check(`${name} is wired into the CI offline job`, ci.has(name),
      ci.has(name) ? "" : "run locally but absent from ci.yml's hard gate");
  }
  // npmTest ⊆ disk and ci ⊆ disk: no ghost reference to a deleted suite.
  const diskSet = new Set(disk);
  for (const name of npmTest) check(`npm test's ${name} exists on disk`, diskSet.has(name),
    diskSet.has(name) ? "" : "chain names a file not in test/");
  for (const name of ci) check(`CI's ${name} exists on disk`, diskSet.has(name),
    diskSet.has(name) ? "" : "ci.yml names a file not in test/");
  // npmTest == ci: the two gates run the same set. e2e-gate is a separate
  // best-effort tier (its own job) and is not a *.test.mjs, so neither side
  // lists it here — the comparison stays exact.
  const onlyNpm = [...npmTest].filter((n) => !ci.has(n));
  const onlyCi = [...ci].filter((n) => !npmTest.has(n));
  check("npm test and the CI offline job cover the same suites",
    onlyNpm.length === 0 && onlyCi.length === 0,
    onlyNpm.length || onlyCi.length ? `only-in-npm=${onlyNpm.join(",")} only-in-CI=${onlyCi.join(",")}` : "");
  // The exempted network suite must STAY out of the default gate — if someone
  // wires it in, the pin fails rather than letting a green run reach the platform.
  check("live-jwks.test.mjs stays out of the default npm test gate", !npmTest.has("live-jwks.test.mjs"),
    "the network tier must not be a default-run check");
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
