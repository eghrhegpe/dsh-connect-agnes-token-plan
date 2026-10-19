// @ts-check
/**
 * The composer pill's peer contract gate — the `conversation.input.right` seat.
 *
 * WHAT IT PINS. The pill appears only if the DSH client still honours four
 * things, none of them under this plugin's control:
 *
 *   A. `dsh-client-ui-conversation` still declares `'conversation.input.right'`
 *      as `kind: 'list'` + `scope: 'session'`. A non-session seat is not a
 *      per-session seat: there is no selected model to gate on, and
 *      `useProjection` stops being strictly injected.
 *   B. that package's client bundle still CALLS
 *      `renderSlot("conversation.input.right", …)` — declared but never
 *      rendered is a dead seat.
 *   C. `dsh-client-ui-session`'s session adapter still lists `projection` in its
 *      `keyedHooks`: it is the only source `useProjection` can come from.
 *   D. `dsh-client-ui-renderer`'s `materializeStandardBinding` still turns keyed
 *      hooks into a `use<Name>` prop through `standardHookPropName`, throws when
 *      a session-scoped source is missing, and still passes
 *      `scope === "session-maybe"` as the `optional` argument — i.e. the prop is
 *      STRICTLY materialized for our seat, not optional.
 *
 * WHY IT EXISTS. The plugin's peer range is `>=0.1.5 <0.3`. A DSH release inside
 * that range that moves the seat, or relaxes the projection to optional, would
 * make the pill vanish with no error text anywhere — an outcome indistinguishable
 * from "this provider has no quota". The behaviour suite (`dom-render`) mounts the
 * shipped `client.js` through a CAPTURING slot stub, so it proves our half and
 * says nothing about the shell's. This gate re-reads the shell's own bytes.
 *
 * HOW. Static file reads only: no peer import, no Host boot, no network. Scopes
 * are the DSH runtime trees on this machine, `test/peer-roots.mjs`'s root first
 * (the tree the plugin actually runs inside). Anchors are FUNCTION NAMES and
 * structural tokens, never line numbers — runtime bundles are regenerated whole,
 * so a line anchor would rot on the next release.
 *
 * FINDING NOTHING = LOUD SKIP, exit 0: a machine with no DSH runtime has nothing
 * to contradict, same family as `store.test.mjs` / `build-gate.mjs`. A copy that
 * IS present but missing one of the three packages whose BYTES are read is a
 * FAILURE, not a skip — an incomplete environment that reads as "nothing to
 * check" is how a gate goes blind.
 *
 * `dsh-client-ui-slots` is DELIBERATELY NOT one of those three. It is the
 * `renderSlot` implementation, and upstream 0.2.1-rc.2 stopped shipping it as a
 * standalone package: its symbols are inlined into
 * `dsh-client-ui-conversation`'s `lib/client.js` (the package's `devDependencies`
 * still name it, which is why `npm ls` used to implicate it, but it is no longer
 * a runtime dependency of anything). It was only ever an EXISTENCE assertion
 * here — `bundleText` never read it, and no A–D check depends on its bytes. So it
 * is OPTIONAL when present-but-unreadable, and the inline evidence is asserted
 * instead via {@link slotsInlined}.
 *
 * @module test/composer-slot-gate
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findPeerRoot } from "./peer-roots.mjs";

const results = [];
/** @param {string} name @param {unknown} condition @param {unknown} [detail] */
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail ?? "") });
}

/** The three packages whose BYTES this gate reads. All three must be present. */
const CONTRACT_PKGS = [
  "dsh-client-ui-conversation",
  "dsh-client-ui-session",
  "dsh-client-ui-renderer"
];

/**
 * The slot runtime, shipped standalone through 0.2.0 and inlined from 0.2.1 on.
 *
 * Kept as a name (not a required package) because its presence is informative:
 * when it IS installed the old packaging is in play; when it is not, the inline
 * symbols must be there instead. See {@link slotsInlined}.
 */
const LEGACY_SLOTS_PKG = "dsh-client-ui-slots";

/**
 * Candidate DSH runtime `node_modules` roots, deduped, existing ones only.
 *
 * The primary is `findPeerRoot()` (the tree the plugin runs inside); the rest
 * are the unpacked desktop runtime, which a machine can have in addition. A root
 * without the conversation package is not a client copy and is dropped.
 * @returns {string[]} roots to inspect.
 */
function scopes() {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  /** Every candidate root, `findPeerRoot()`'s `undefined` included. @type {Array<string|undefined>} */
  const raw = [
    findPeerRoot(),
    join(homedir(), ".dsh", "dsh-asar-unpacked", "dsh", "node_modules"),
    ...(localAppData === ""
      ? []
      : [join(localAppData, "Programs", "DeepSeek Harness", "resources", "app.asar.unpacked", "dsh", "node_modules")])
  ];
  /** @type {string[]} */
  const candidates = [];
  for (const root of raw) {
    if (typeof root === "string" && root !== "") candidates.push(root);
  }
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const root of candidates) {
    if (seen.has(root)) continue;
    seen.add(root);
    if (existsSync(join(root, "@deepseek-ai", "dsh-client-ui-conversation"))) out.push(root);
  }
  return out;
}

/**
 * All `.js` / `.d.ts` text under one package, concatenated.
 *
 * Bundles are regenerated whole on every release, so the token may sit in any
 * chunk: searching the package rather than one hardcoded path is what keeps this
 * gate from failing on packaging changes it does not actually care about.
 * Bounded on purpose (a UI bundle can be several MB) — a file-count or size cap
 * that trips is reported, not silently swallowed: `bundleText` collects the
 * reasons and the `[caps]` check fails loudly, because a token missing from a
 * PARTIAL read is not proof it is missing from the package.
 * @param {string} pkgDir - absolute package directory.
 * @returns {{text: string, files: number, errors: string[], caps: string[]}} the concatenated text.
 */
function bundleText(pkgDir) {
  const chunks = [];
  const errors = [];
  /**
   * Why the walk stopped, when it stopped early: the walk is bounded on
   * purpose (a UI bundle can be several MB), and the doc says a cap trip is
   * REPORTED, not silently swallowed — so every bound that trips appends its
   * reason here and the caller turns it into a failing check.
   * @type {string[]}
   */
  const caps = [];
  let files = 0;
  const walk = (dir, depth) => {
    if (depth > 6) {
      caps.push(`depth cap: ${dir}`);
      return;
    }
    if (files >= 400) {
      caps.push(`file cap: at least 400 files, ${dir} not walked`);
      return;
    }
    let names;
    try {
      names = readdirSync(dir);
    } catch (error) {
      errors.push(`${dir}: ${String(error instanceof Error ? error.message : error)}`);
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name === ".git") continue;
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!name.endsWith(".js") && !name.endsWith(".d.ts")) continue;
      if (stat.size > 8_000_000) {
        caps.push(`size cap: ${path} (${stat.size} bytes) not read`);
        continue;
      }
      try {
        chunks.push(readFileSync(path, "utf8"));
        files += 1;
      } catch (error) {
        errors.push(`${path}: ${String(error instanceof Error ? error.message : error)}`);
      }
    }
  };
  walk(pkgDir, 0);
  return { text: chunks.join("\n"), files, errors, caps };
}

/**
 * Whether the slot runtime is reachable from the conversation bundle.
 *
 * Two packagings satisfy the contract, and the gate accepts both rather than
 * pinning one:
 *
 *   - **standalone** (`<= 0.2.0`): `dsh-client-ui-slots` is installed as its own
 *     package, so the conversation bundle only has to CALL `renderSlot`.
 *   - **inlined** (`>= 0.2.1-rc.2`): the package is gone and `renderSlot`'s
 *     definition moved into `dsh-client-ui-conversation`'s own bundle, together
 *     with `useProjection`. The `.d.ts` surface still names the seat.
 *
 * A conversation bundle that neither sits next to the standalone package nor
 * carries `renderSlot` at all is the case this gate exists to catch: the seat
 * would stop rendering and the pill would vanish silently.
 * @param {boolean} standaloneInstalled - whether the legacy package is present.
 * @param {{text: string}} conversation - the conversation bundle walk.
 * @returns {{ok: boolean, evidence: string}} the verdict and what proved it.
 */
function slotsInlined(standaloneInstalled, conversation) {
  if (standaloneInstalled) return { ok: true, evidence: "standalone dsh-client-ui-slots installed" };
  const hasRenderSlot = /\brenderSlot\b/.test(conversation.text);
  const hasProjection = /\buseProjection\b/.test(conversation.text);
  return {
    ok: hasRenderSlot && hasProjection,
    evidence: `no standalone slots package; inlined renderSlot=${hasRenderSlot} useProjection=${hasProjection}`
  };
}

const found = scopes();
if (found.length === 0) {
  process.stdout.write(
    "\n[composer-slot-gate] SKIPPED — no DSH client copy on this machine.\n" +
    "[composer-slot-gate]   The composer seat's contract cannot be contradicted here; the peer\n" +
    "[composer-slot-gate]   suite family (`store.test.mjs` / `build-gate.mjs`) skips the same way.\n\n"
  );
  process.exit(0);
}

for (const root of found) {
  const scope = join(root, "@deepseek-ai");
  const versionOf = (pkg) => {
    try {
      return JSON.parse(readFileSync(join(scope, pkg, "package.json"), "utf8")).version ?? "?";
    } catch {
      return "?";
    }
  };
  const missing = CONTRACT_PKGS.filter((pkg) => !existsSync(join(scope, pkg)));
  check(`[${root}] carries the three contract packages whose bytes are read`, missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : `version ${versionOf("dsh-client-ui-conversation")}`);
  if (missing.length > 0) continue;

  const conversation = bundleText(join(scope, "dsh-client-ui-conversation"));
  const session = bundleText(join(scope, "dsh-client-ui-session"));
  const renderer = bundleText(join(scope, "dsh-client-ui-renderer"));

  // E. The slot runtime is reachable, in either packaging (see `slotsInlined`).
  // Not one of A–D: A–D pin what the seat must DO, this pins that its renderer
  // still exists somewhere. `dsh-client-ui-slots` alone was never enough — it was
  // an install-shape proxy that went stale the day upstream inlined it.
  const slots = slotsInlined(existsSync(join(scope, LEGACY_SLOTS_PKG)), conversation);
  check(`[E][${root}] the slot runtime is reachable (standalone package or inlined in the conversation bundle)`,
    slots.ok, slots.evidence);
  /** Each assertion names the copy it read: several scopes produce several rows. */
  const tag = `v${versionOf("dsh-client-ui-conversation")}`;

  // A. The seat is still declared, as a session-scoped list.
  // The quotes are matched with a back-reference, not pinned: the gate must see
  // either single or double quotes after minification, and anything else is the
  // new contract, not a formatting change.
  const declared = conversation.text.match(/(['"])conversation\.input\.right\1:\s*\{([^}]*)\}/);
  const declaredBody = declared?.[2] ?? "";
  check(`[A][${tag}] conversation.input.right is still declared kind:'list' + scope:'session'`,
    declared !== null
      && /kind:\s*['"]list['"]/.test(declaredBody)
      && /scope:\s*['"]session['"]/.test(declaredBody),
    declared === null ? "declaration not found in the package's type surface" : declaredBody.replace(/\s+/g, " ").trim());

  // B. The seat is still rendered.
  const rendered = /renderSlot\(\s*['"]conversation\.input\.right['"]/.test(conversation.text);
  check(`[B][${tag}] the conversation package still renders that seat`,
    rendered,
    rendered ? "renderSlot(\"conversation.input.right\", …) found" : "no renderSlot(\"conversation.input.right\") call found");

  // C. `projection` is still a keyed hook of the session scope.
  const keyed = /keyedHooks:\s*\[\s*['"]projection['"]\s*\]/.test(session.text);
  check(`[C][${tag}] the session scope still declares the \`projection\` keyed hook`,
    keyed,
    keyed ? "keyedHooks: [\"projection\"] found" : "keyedHooks: [\"projection\"] not found");

  // D. The keyed hook is still materialized strictly for a session seat.
  // The call shape is matched structurally — local names and whitespace are the
  // minifier's to rewrite, so pinning them would red the gate on a reformat.
  // The pattern COUNTS, not just tests: the live bundle carries the function
  // definition plus two non-session call sites on top of the pinned one, so a
  // raw token count would be 4, not 1. Exactly ONE call site compares against
  // "session-maybe" today; a second one would make a single `.test()` match
  // indeterminate — which call did the gate look at? — so one match is part
  // of the check. (The `[^)]*` argument class still cannot see past a nested
  // parenthesis in the second argument; that direction stays a known risk.)
  const sessionMaybeCalls = renderer.text.match(/materializeStandardBinding\(\s*[^,]+,\s*[^)]*===\s*['"]session-maybe['"]/g) ?? [];
  const materialized = sessionMaybeCalls.length === 1;
  check(`[D][${tag}] useProjection is still strictly materialized (optional = scope === "session-maybe") at exactly one call site`,
    materialized
      && renderer.text.includes("standardHookPropName")
      && renderer.text.includes("strict keyed standard hook"),
    `session-maybe call sites=${sessionMaybeCalls.length} standardHookPropName=${renderer.text.includes("standardHookPropName")} strict-throw=${renderer.text.includes("strict keyed standard hook")}`);

  const readErrors = [...conversation.errors, ...session.errors, ...renderer.errors];
  check(`[read][${tag}] every contract file was readable`, readErrors.length === 0, readErrors.slice(0, 3).join(" | ") || "no read errors");

  // The doc says a cap trip is reported, so a bound that trips is a FAILURE, not
  // a silent "declaration not found": the bundle was only partially read, and a
  // token absent from what we saw is not proof it is absent from the package.
  const capTrips = [...conversation.caps, ...session.caps, ...renderer.caps];
  check(`[caps][${tag}] no walk cap was tripped (the bundles were read in full)`,
    capTrips.length === 0,
    capTrips.length ? capTrips.slice(0, 3).join(" | ") : "no cap tripped");
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((entry) => !entry.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} composer-slot-gate check(s) FAILED`);
  console.error(
    "\nThe composer pill registers into `conversation.input.right` and reads\n" +
    "`useProjection(\"modelSelection\")`. One of those facts moved in the DSH client\n" +
    "above. Fix the registration in `src/client/apply.ts` / the gate in\n" +
    "`src/client/composer-usage-pill.ts` to match the new contract — do not delete\n" +
    "this gate: without it the pill disappears silently, looking exactly like a\n" +
    "provider with no quota."
  );
  process.exit(1);
}
console.log(`\nall composer-slot-gate checks passed (${found.length} scope(s): the seat, its renderer, the projection and its materialization)`);
