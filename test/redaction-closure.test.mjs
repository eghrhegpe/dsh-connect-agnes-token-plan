/**
 * The redaction surface must stay CLOSED — one copy of the rules, and every
 * route error goes through the shared collector.
 *
 * ## Why this file exists
 *
 * `src/host/util.ts` owns the rules (`redactSecrets`) and the collector
 * (`redactError`). The 2026-10-21 review found the two halves had drifted:
 * five error sites in `routes/agnescode.ts` hand-rolled their own copy of the
 * redaction expression instead of calling the collector — behaviourally
 * IDENTICAL, so nothing could tell them apart from the outside, and a rule
 * added to the shared one would not have reached them.
 *
 * That is fixed. THIS file is what keeps it fixed.
 *
 * ## Why every check here is a SHAPE check
 *
 * A hand-rolled copy produces byte-identical output to the shared collector —
 * that is exactly why it is dangerous and exactly why a behaviour test cannot
 * see one. The review could not tell the two apart from the outside either.
 * So the fences below look at the CODE: the only thing a test can assert about
 * "there is exactly one copy of this rule" is that the other copy is absent.
 *
 * Comments are stripped before every grep: the fix's own prose names these
 * expressions, and a fence that a comment can satisfy guards nothing.
 *
 * Peer-free: reads `src/host/routes/` as text and imports only `util.ts`
 * (whose one import is a type), so it still runs on a clean checkout.
 */
import { redactError, redactSecrets } from "../src/host/util.ts";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES = join(ROOT, "src", "host", "routes");

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function section(title) {
  console.log(`\n— ${title}`);
}

/**
 * Blank every comment body, keeping the code and the string literals.
 * @param {string} src - the file text.
 * @returns {string} the text without comments.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      if (i === 0) return ""; // a whole-line comment carries no code
      // An inline `//` that is not part of a `https://` URL starts a comment.
      return i > 0 && line[i - 1] !== ":" ? line.slice(0, i) : line;
    })
    .join("\n");
}

const routeFiles = readdirSync(ROUTES).filter((name) => name.endsWith(".ts")).sort();
const masked = new Map(routeFiles.map((name) => [name, stripComments(readFileSync(join(ROUTES, name), "utf8"))]));

section("the rule set still covers a bare JWT");
// A dropped rule changes no output of any other test, so without this fence
// the 2026-10-21 fix would be silently reversible.
const bareJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlX2hlcmU";
check("a bare JWT is redacted even with no key name in front of it",
  redactSecrets(`request rejected, token ${bareJwt}`) === "request rejected, token [REDACTED]",
  redactSecrets(`request rejected, token ${bareJwt}`));
check("a named credential is still redacted",
  redactSecrets('{"access_token":"abc123def456"}').includes("[REDACTED]"),
  redactSecrets('{"access_token":"abc123def456"}'));
check("ordinary prose is not mangled by the rules",
  redactSecrets("the token is expired") === "the token is expired",
  redactSecrets("the token is expired"));
check("the collector is the shared one",
  redactError(new Error("boom sk-abcdef123456")) === redactSecrets("boom sk-abcdef123456"),
  redactError(new Error("boom sk-abcdef123456")));

section("every route module that catches a value goes through the collector");
// A `catch {` without a binding answers with a FIXED wording ("the body is
// not valid JSON") — there is no error text to redact. A catch that BINDS the
// error is the one that can carry a credential into the panel, so that is the
// one the fence is about.
const withoutCollector = [];
for (const [name, code] of masked) {
  if (!/catch\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(code)) continue;
  if (!code.includes("redactError(")) withoutCollector.push(name);
}
check("every route module that catches a value goes through the shared collector",
  withoutCollector.length === 0,
  withoutCollector.length === 0
    ? `${routeFiles.length} route module(s) checked`
    : `${withoutCollector.join(", ")} catches a value without redactError(`);

section("no route module hand-rolls its own redaction");
const handRolled = [];
for (const [name, code] of masked) {
  if (/redactSecrets\([^)]*instanceof Error/.test(code)) handRolled.push(name);
}
check("no route module hand-rolls its own redaction",
  handRolled.length === 0,
  handRolled.length === 0
    ? "the shared collector is the only copy"
    : `${handRolled.join(", ")} builds the message by hand`);

const failed = results.filter((result) => !result.pass);
for (const result of failed) {
  console.error(`  FAIL  ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
}
console.log(`\nredaction-closure.test.mjs: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
