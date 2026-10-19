// @ts-check
/**
 * The `any` BUDGET gate — a fence around the debt `noImplicitAny: false` allows.
 *
 * WHAT IT PINS. A per-file ceiling on explicit `any` in the shipped source
 * (`src/**\/*.ts`, plus `types/*.d.ts`), frozen in
 * `test/baselines/any-budget.json`. A file may not go above the count recorded
 * for it; a file absent from the baseline starts at zero.
 *
 * WHY IT EXISTS. `tsconfig.json`'s `$comment` records `noImplicitAny: false` as
 * a deliberate trade-off — untyped signatures in the Host glue stay greppable
 * and never block the build, with "tsc plus the test/build gates" named as the
 * substitute. That substitution was true for the type layer (tsc-gate), the
 * clone floor (dup-gate), build freshness (build-gate) and the peer contract,
 * and it was simply absent for the debt the trade-off actually creates: nothing
 * in the suite ever counted `any`, so the number only ever went up, and a new
 * `any` was indistinguishable from an old one. This gate is the missing half —
 * not a reversal of the trade-off, a ledger for it.
 *
 * WHY A BUDGET AND NOT A BAN. The same tsconfig note is explicit that the glue
 * is *meant* to stay untyped where typing it would cost more than it buys
 * (inline wiring shapes, peer surfaces we do not own). Banning `any` would
 * fight the decision that was made on purpose and lose. Capping it does not:
 * the debt stays visible, and it can no longer grow by accident.
 *
 * WHY THE BLUNTEST POSSIBLE RULE. The count is `/\bany\b/` — not a
 * "type-position" pattern — over comment- and string-blanked lines. A clever
 * pattern was measured against this one and lost twice: it missed every `any` in
 * a RETURN position (`(service: string) => any`, `loadToolsModule?: () => any`)
 * and it counted only the first `any` on a line, so `(...args: any[]) => any`
 * scored 1 instead of 2. A rule that a new file, a new module or an AI session
 * can dodge by writing a slightly different shape is not a budget. The one
 * exclusion is a member call (`AbortSignal.any([…])`), made by lookbehind on the
 * dot rather than by an allow-list.
 *
 * WHY THERE IS NO SKIP BRANCH. Unlike tsc-gate / dup-gate / composer-slot-gate,
 * this gate reads only files inside this repo and needs no tool, runtime or
 * key. There is no environment that cannot run it, so a SKIP here would only
 * ever be a way to be quiet. Finding nothing to count is a failure (see the
 * floor checks below), not a skip.
 *
 * WHY `test/` IS NOT IN SCOPE. This file is itself dense with the token it
 * counts — the rule, the probe, the prose. Scanning the test tree would make
 * the gate a reader of its own evidence, the same self-feeding loop dup-gate
 * documents for its clone report. The debt that matters is the one that ships.
 *
 * REGENERATING. Budget is spent deliberately, not silently:
 *   UPDATE_BASELINE=1 node test/any-budget-gate.mjs
 * writes the current counts and exits 0. The change then lands as a visible
 * diff in the baseline file, which is what review is for — a file whose number
 * went UP is a decision, and it should be argued in that commit, not here.
 *
 * @module test/any-budget-gate
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(root, "test", "baselines", "any-budget.json");

/**
 * The whole rule: the word `any` in code, minus `something.any(…)`.
 * See the module docblock for why it is not a type-position pattern.
 */
const ANY_RE = /(?<!\.)\bany\b/g;

/**
 * Floor on the number of files the walk must see. A walk that quietly returns
 * nothing would make every "within budget" comparison pass for the wrong
 * reason, which is how a fence goes blind.
 */
const FILE_FLOOR = 80;

const results = [];
/** @param {string} name @param {unknown} condition @param {string} [detail] */
function check(name, condition, detail = "") {
  const pass = Boolean(condition);
  results.push({ name, pass, detail });
  if (!pass) console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

/** @param {number} width @returns {string} */
const pad = (width) => " ".repeat(Math.max(0, width));

/** @param {string} file @returns {string} repo-relative, POSIX-separated */
const key = (file) => relative(root, file).split(sep).join("/");

/**
 * Replace comments and string/template bodies with spaces, keeping every line
 * and every column exactly where it was.
 *
 * Column preservation is the point: the count is taken per line, so a
 * "strip the comments" pass that collapses lines would let a comment on line
 * 40 absorb half of line 41 and invent a match that is not in the source.
 * State (`block` / template) survives line ends, so a multi-line comment or
 * template literal stays blanked across the whole span.
 * @param {string} source
 * @returns {string[]} one blanked line per input line.
 */
function blankLines(source) {
  /** @type {string[]} */
  const out = [];
  let mode = "code";
  for (const line of source.split(/\r?\n/)) {
    let buf = "";
    let i = 0;
    const n = line.length;
    while (i < n) {
      if (mode === "block") {
        const end = line.indexOf("*/", i);
        if (end === -1) {
          buf += pad(n - i);
          i = n;
        } else {
          buf += pad(end + 2 - i);
          i = end + 2;
          mode = "code";
        }
        continue;
      }
      if (mode === "tpl") {
        let j = i;
        while (j < n) {
          if (line[j] === "\\") {
            j += 2;
            continue;
          }
          if (line[j] === "`") {
            buf += pad(j - i) + "`";
            j += 1;
            mode = "code";
            break;
          }
          j += 1;
        }
        if (j >= n && mode === "tpl") {
          buf += pad(n - i);
          i = n;
        } else {
          i = j;
        }
        continue;
      }
      const c = line[i];
      const d = line[i + 1];
      if (c === "/" && d === "/") {
        buf += pad(n - i);
        i = n;
        continue;
      }
      if (c === "/" && d === "*") {
        mode = "block";
        const end = line.indexOf("*/", i + 2);
        if (end === -1) {
          buf += pad(n - i);
          i = n;
        } else {
          buf += pad(end + 2 - i);
          i = end + 2;
          mode = "code";
        }
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n) {
          if (line[j] === "\\") {
            j += 2;
            continue;
          }
          if (line[j] === c) {
            j += 1;
            break;
          }
          j += 1;
        }
        buf += c + pad(Math.max(0, j - i - 2)) + (j <= n ? c : "");
        i = j;
        continue;
      }
      if (c === "`") {
        mode = "tpl";
        buf += "`";
        i += 1;
        let j = i;
        while (j < n) {
          if (line[j] === "\\") {
            j += 2;
            continue;
          }
          if (line[j] === "`") {
            buf += pad(j - i) + "`";
            j += 1;
            mode = "code";
            break;
          }
          j += 1;
        }
        if (j >= n && mode === "tpl") {
          buf += pad(n - i);
          i = n;
        } else {
          i = j;
        }
        continue;
      }
      buf += c;
      i += 1;
    }
    out.push(buf);
  }
  return out;
}

/**
 * Every `.ts` file under `dir` — which is also every `*.d.ts`.
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function tsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "lib" || entry.name === "upstream") continue;
      tsFiles(path, out);
      continue;
    }
    if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * @param {string} file
 * @returns {{ count: number, sample: string[] }} the count and up to three sample lines.
 */
function countAny(file) {
  const lines = blankLines(readFileSync(file, "utf8"));
  let count = 0;
  /** @type {string[]} */
  const sample = [];
  lines.forEach((line, index) => {
    const hits = line.match(ANY_RE);
    if (hits === null || hits.length === 0) return;
    count += hits.length;
    if (sample.length < 3) sample.push(`${index + 1}: ${line.trim()}`);
  });
  return { count, sample };
}

// --- the scanner guards itself before it is trusted with anything -----------
// Both directions are pinned on purpose. Only "counts the obvious `: any`" is
// the easy half; "does NOT count the word when it is prose" is the half that
// decays, because a blanking bug that swallows code shows up as a lower number
// and a lower number reads as an improvement.
{
  const probe = [
    "const a: any = 1;", // 1 — the case everyone remembers
    "// any", // 0 — line comment
    "/* any */", // 0 — block comment
    "const s = \"any\";", // 0 — string body
    "const t = `any`;", // 0 — template body
    "x = AbortSignal.any([a]);", // 0 — member call, not a type
    "(cb: (service: string) => any) => 1" // 1 — return position, the case a clever rule missed
  ].join("\n");
  const counted = blankLines(probe).reduce((sum, line) => sum + (line.match(ANY_RE) ?? []).length, 0);
  check("the scanner counts code and ignores prose", counted === 2,
    `the probe counted ${counted}, expected 2 — one annotation "any", one return-position "any"`);
}

// --- the scan ---------------------------------------------------------------
/** @type {Map<string, { count: number, sample: string[] }>} */
const actual = new Map();
for (const file of [...tsFiles(join(root, "src")), ...tsFiles(join(root, "types"))].sort()) {
  actual.set(key(file), countAny(file));
}
let total = 0;
for (const info of actual.values()) total += info.count;

const halves = { host: 0, client: 0 };
for (const name of actual.keys()) {
  if (name.startsWith("src/host/")) halves.host += 1;
  if (name.startsWith("src/client/")) halves.client += 1;
}
check(`the walk saw at least ${FILE_FLOOR} source files`, actual.size >= FILE_FLOOR, `scanned ${actual.size}`);
check("the walk still sees both source halves", halves.host > 0 && halves.client > 0,
  `src/host=${halves.host} src/client=${halves.client}`);

// --- regeneration -----------------------------------------------------------
if (process.env.UPDATE_BASELINE === "1") {
  /** @type {Record<string, number>} */
  const recorded = {};
  let recordedTotal = 0;
  for (const [name, info] of actual) {
    if (info.count === 0) continue; // a file with no debt needs no line: absent means zero.
    recorded[name] = info.count;
    recordedTotal += info.count;
  }
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify({
    $comment: "Per-file ceiling on explicit `any` in the shipped source. Written by `UPDATE_BASELINE=1 node test/any-budget-gate.mjs`; checked on every `npm test`. A file absent here has a budget of zero. Raising a number is a decision — argue it in the commit that changes this file.",
    rule: String(ANY_RE),
    scope: ["src/**/*.ts", "types/*.d.ts"],
    total: recordedTotal,
    files: recorded
  }, null, 2)}\n`);
  console.log(`[any-budget-gate] wrote ${key(BASELINE)} — ${Object.keys(recorded).length} file(s) carrying debt, total ${recordedTotal}`);
  process.exit(0);
}

// --- the budget -------------------------------------------------------------
/** @type {any} */
let baseline = null;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch (error) {
  console.error(
    `\n[any-budget-gate] FAILED — no readable baseline at ${key(BASELINE)} (${String(error instanceof Error ? error.message : error)}).\n` +
    `[any-budget-gate]   Generate it once with: UPDATE_BASELINE=1 node test/any-budget-gate.mjs\n\n`
  );
  process.exit(1);
}

/** @type {Record<string, number>} */
const budgets = {};
{
  const raw = baseline !== null && typeof baseline === "object" ? baseline.files : null;
  if (raw !== null && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === "number") budgets[name] = value;
    }
  }
}
const budgetTotal = typeof baseline?.total === "number" ? baseline.total : -1;

check("the baseline declares a total", budgetTotal >= 0, JSON.stringify(baseline?.total ?? null));
{
  let sum = 0;
  for (const value of Object.values(budgets)) sum += value;
  check("the baseline's total equals the sum of its per-file budgets", sum === budgetTotal,
    `sum=${sum} total=${budgetTotal} — a hand-edited baseline must not be able to widen itself`);
}

// A file that disappears from the tree must not take its debt with it: renaming
// or splitting a module is exactly the moment the ceiling would silently rise,
// and a budget entry nobody can match is a dead entry.
{
  /** @type {string[]} */
  const gone = [];
  for (const name of Object.keys(budgets)) if (!actual.has(name)) gone.push(name);
  check("every file in the baseline is still on disk", gone.length === 0,
    gone.length ? `no longer scanned: ${gone.join(", ")} — regenerate the baseline` : "");
}

/** @type {string[]} */
const over = [];
for (const [name, info] of actual) {
  const budget = budgets[name] ?? 0;
  if (info.count <= budget) continue;
  over.push(`${name}: ${info.count} (budget ${budget})`);
  check(`${name} is within its budget`, false,
    `${info.count} > ${budget}${info.sample.length ? ` — e.g. ${info.sample.join(" | ")}` : ""}`);
}
check(`every scanned file is within its budget (${over.length} over)`, over.length === 0, over.join("; "));
check(`the total is within budget (${total} / ${budgetTotal})`, total <= budgetTotal,
  total > budgetTotal ? `total went up by ${total - budgetTotal}` : "");

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((entry) => !entry.pass);
if (failed.length > 0) {
  console.error(
    `\n[any-budget-gate] ${failed.length} check(s) FAILED — the source carries more explicit \`any\`\n` +
    `[any-budget-gate] than test/baselines/any-budget.json allows.\n` +
    `[any-budget-gate]   Fix it by typing the new occurrence (the preferred answer), or spend budget\n` +
    `[any-budget-gate]   on purpose and let the diff say so:\n` +
    `[any-budget-gate]     UPDATE_BASELINE=1 node test/any-budget-gate.mjs\n` +
    `[any-budget-gate]   Do not raise the ceiling to land an unrelated change: the number in that\n` +
    `[any-budget-gate]   file is the only thing standing between "the glue stays greppable" (the\n` +
    `[any-budget-gate]   tsconfig trade-off) and "nobody knows how much there is".\n`
  );
  process.exit(1);
}
console.log(`\nall any-budget-gate checks passed (${actual.size} file(s), ${total} counted, budget ${budgetTotal})`);
