// The panel's SHARED quota readings, tested at their source.
//
// `cards.ts` holds the two readings two surfaces quote — `windowPercent` (a
// window's consumption percentage) and `usageTier` (its severity) — and the
// composer pill imports both instead of growing a second opinion. Until this
// suite existed that contract was only exercised through a drawn tree
// (`render.test.mjs`) or a mounted pill (`dom-render.test.mjs`), so moving a
// THRESHOLD could only be noticed by a test that also had to render. These
// checks pin the reading itself: the platform's figure verbatim (never clamped,
// never re-derived), the `used / limit` branch only when the platform sent
// nothing, `null` and `0` as two different claims, and the 90 / 70 boundaries.
//
// The last three checks are mechanical source fences, not values: they read the
// module text so the "one opinion" invariant fails at the moment a second copy
// of the thresholds appears, rather than at the moment someone notices the two
// surfaces disagree.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { usageTier, usageTone, windowPercent } from "../src/client/cards.ts";
import { S } from "../src/client/styles.ts";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, "..", "src", "client");

const results = [];

/**
 * Record one assertion. `detail` is only worth passing when it names the value
 * that actually came back — a failing check should be readable without a
 * debugger.
 */
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

// ---------------------------------------------------------------------------
// windowPercent — the reading is the platform's own figure
// ---------------------------------------------------------------------------

// Each case carries a `used / limit` that would produce a DIFFERENT number, so
// a pass proves the platform's figure took precedence rather than agreeing by
// coincidence.
const verbatim = [
  ["a fractional percentage is quoted exactly", 42.5, 1],
  ["a whole-number percentage stays exact", 100, 1],
  ["an overage above 100 is NOT clamped", 130.4, 1],
  ["a sub-1 percent is not rounded away", 0.4, 1],
  // `0` is the case that separates a `!== null` guard from a truthiness test:
  // the fallback here would answer 1, so a pass proves the zero survived.
  ["a platform zero is a reading, not a missing one", 0, 1]
];
for (const [name, pct, used] of verbatim) {
  const got = windowPercent({ usagePct: pct, used, limit: 100 });
  check(name, got === pct, `usagePct=${pct} with used=${used}/100 → ${got}`);
}

// The reason the platform figure leads: it and the arithmetic are two different
// numbers, and the panel must transcribe the one the console shows.
check(
  "the platform figure wins over used/limit instead of agreeing with it",
  windowPercent({ usagePct: 99, used: 1, limit: 100 }) === 99
);

// ---------------------------------------------------------------------------
// windowPercent — the fallback, and only the fallback
// ---------------------------------------------------------------------------

check("no usagePct falls back to used/limit", windowPercent({ used: 25, limit: 100 }) === 25);
check("usagePct: null falls back to used/limit", windowPercent({ used: 25, limit: 100, usagePct: null }) === 25);
check("a NaN platform figure falls back", windowPercent({ used: 25, limit: 100, usagePct: NaN }) === 25);
check("a non-finite platform figure falls back", windowPercent({ used: 25, limit: 100, usagePct: Infinity }) === 25);
// A string is a shape drift, not a reading: only a real number is transcribed.
check(
  "a quoted platform figure falls back rather than being coerced",
  windowPercent({ used: 25, limit: 100, usagePct: "50" }) === 25
);

// ---------------------------------------------------------------------------
// windowPercent — "no reading" is a different claim from "zero"
// ---------------------------------------------------------------------------

check("an explicit zero used is 0%, not null", windowPercent({ used: 0, limit: 100 }) === 0);
check("a missing used is null, not 0%", windowPercent({ limit: 100 }) === null);
check("a null used is null, not 0%", windowPercent({ used: null, limit: 100 }) === null);
check("a NaN used is null", windowPercent({ used: NaN, limit: 100 }) === null);
check("a non-number used is null", windowPercent({ used: "5", limit: 100 }) === null);

// A zero limit has no fraction to draw; `used / limit` would be Infinity.
check("a zero limit yields null, not Infinity", windowPercent({ used: 5, limit: 0 }) === null);
check("a missing limit yields null", windowPercent({ used: 5 }) === null);
check("a negative limit yields null", windowPercent({ used: 5, limit: -100 }) === null);

// A shape-drifted row must render nothing instead of throwing (the reason both
// entry points declare `unknown`).
for (const value of [null, undefined, 0, 42, "", "x", true, false]) {
  check(`a non-object window (${JSON.stringify(value)}) reports no reading`, windowPercent(value) === null);
}

// ---------------------------------------------------------------------------
// usageTier / usageTone — the 90 / 70 vocabulary
// ---------------------------------------------------------------------------

const tiers = [
  [-1, "ok"],
  [0, "ok"],
  [69, "ok"],
  [69.9, "ok"],
  [70, "warn"],
  [70.1, "warn"],
  [89.9, "warn"],
  [90, "error"],
  [90.1, "error"],
  [100, "error"],
  [130.4, "error"]
];
for (const [pct, want] of tiers) {
  check(`usageTier(${pct}) is ${want}`, usageTier(pct) === want, `got ${usageTier(pct)}`);
}

check("usageTone(50) is the plain fill", usageTone(50) === S.barFill);
check("usageTone(69.9) is still the plain fill", usageTone(69.9) === S.barFill);
check("usageTone(70) is the warn fill", usageTone(70) === S.barFillWarn);
check("usageTone(89.9) is still the warn fill", usageTone(89.9) === S.barFillWarn);
check("usageTone(90) is the error fill", usageTone(90) === S.barFillError);

// The tone is derived from the tier, so the two must never disagree at any
// point on the line — a hardcoded second ladder would drift here.
const sweep = [-1, 0, 1, 50, 69.9, 70, 75, 89.9, 90, 100, 130, 1000];
check(
  "usageTone agrees with usageTier across every band",
  sweep.every((pct) => {
    const tier = usageTier(pct);
    const want = tier === "error" ? S.barFillError : tier === "warn" ? S.barFillWarn : S.barFill;
    return usageTone(pct) === want;
  })
);

// ---------------------------------------------------------------------------
// Mechanical fences: the readings have ONE source, and both surfaces use it
// ---------------------------------------------------------------------------

const clientSources = new Map(
  readdirSync(clientDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => [name, readFileSync(join(clientDir, name), "utf8")])
);

const thresholdCopies = [...clientSources]
  .filter(([, src]) => /[><]=\s*(90|70)\b/.test(src))
  .map(([name]) => name);
check(
  "the 90 / 70 thresholds live in cards.ts alone",
  thresholdCopies.length === 1 && thresholdCopies[0] === "cards.ts",
  `carried by: ${thresholdCopies.join(", ") || "(none)"}`
);

const definitions = [...clientSources]
  .flatMap(([name, src]) =>
    [
      /function usageTier\b/.test(src) ? `usageTier@${name}` : null,
      /function windowPercent\b/.test(src) ? `windowPercent@${name}` : null
    ].filter(Boolean)
  )
  .sort();
check(
  "each shared reading has exactly one definition site",
  definitions.length === 2 && definitions.includes("usageTier@cards.ts") && definitions.includes("windowPercent@cards.ts"),
  definitions.join(", ") || "(none)"
);

const pill = clientSources.get("composer-usage-pill.ts") ?? "";
check(
  "the composer pill imports both readings from cards.ts",
  /import\s*\{[^}]*\busageTier\b[^}]*\}\s*from\s*"\.\/cards\.ts"/.test(pill) &&
    /import\s*\{[^}]*\bwindowPercent\b[^}]*\}\s*from\s*"\.\/cards\.ts"/.test(pill)
);

// ---------------------------------------------------------------------------

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((entry) => !entry.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} check(s) FAILED:`);
  for (const entry of failed) console.error(`  ✗ ${entry.name}${entry.detail === "" ? "" : ` — ${entry.detail}`}`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
