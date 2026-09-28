/**
 * Unit checks for the console parsers — the layer that turns a platform
 * response into the panel's rows, and the one PITFALLS §12 says must never read
 * a renamed field as "no usage".
 *
 * Until now `parsePools` / `parseTrend` / `checkShape` were only touched
 * indirectly: the route stubs served them a single happy-path body, so the drift
 * branch (the whole reason `EXPECTED_SHAPES` exists), the string-number coercion
 * (§11), and the trend SUM-vs-first semantics each had no direct assertion. A
 * regression in any of them stayed green as long as one well-shaped body still
 * parsed. This file exercises them directly, with no network at all — they are
 * pure functions over an object.
 */
import {
  credits,
  epochSeconds,
  checkShape,
  parsePools,
  parseTrend,
  EXPECTED_SHAPES
} from "../parsers.js";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail }); }
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) }); }

// --- 1. credits(): the console returns numbers AS STRINGS (§11) -----------
{
  check("a numeric string becomes a number", credits("60000") === 60000, String(credits("60000")));
  check("a real number passes through", credits(42.5) === 42.5);
  check("a decimal string keeps precision", credits("1234.56") === 1234.56, String(credits("1234.56")));
  // NaN is what a raw `Number(undefined)` produces; the parser must not leak it
  // onto the screen as "NaN".
  check("undefined reads as zero, not NaN", credits(undefined) === 0);
  check("null reads as zero", credits(null) === 0);
  check("an empty string reads as zero", credits("") === 0);
  check("a non-numeric string reads as zero", credits("abc") === 0);
  check("Infinity reads as zero (not finite)", credits(Infinity) === 0);
}

// --- 2. epochSeconds(): decimal-string epochs, and the 1970 trap ----------
// The console sends `reset_at` / `nearest_grant_expiry` as second-precision
// epoch STRINGS. Absent or unusable must be `null`, NOT 0 — reading "no expiry"
// as epoch 0 would render a reset date in 1970.
{
  check("a decimal-string epoch becomes a number", epochSeconds("1800000000") === 1800000000, String(epochSeconds("1800000000")));
  check("a real number epoch passes through", epochSeconds(1800000000) === 1800000000);
  check("fractional seconds are floored", epochSeconds("1800000000.9") === 1800000000, String(epochSeconds("1800000000.9")));
  check("undefined is null (absent)", epochSeconds(undefined) === null);
  check("null is null", epochSeconds(null) === null);
  check('empty string is null', epochSeconds("") === null);
  // The specific trap: the console's own sentinel for "never expires" is "0".
  check('"0" is null, not the year 1970', epochSeconds("0") === null, String(epochSeconds("0")));
  check("numeric 0 is null", epochSeconds(0) === null);
  check("a negative epoch is null", epochSeconds(-5) === null);
  check("a non-numeric string is null", epochSeconds("soon") === null);
}

// --- 3. checkShape(): the drift detector behind shapeWarnings -------------
// Forgiving parsers turn a platform rename into a serene empty screen; this is
// the one place that notices. Both directions matter: a missing key flags, a
// present key does not, and an unknown kind flags nothing (it has no contract).
{
  const poolKeys = EXPECTED_SHAPES["pool-usage"];
  check("pool-usage expects plan and pools",
    poolKeys.includes("plan") && poolKeys.includes("pools"), JSON.stringify(poolKeys));
  check("a complete pool body has no drift",
    checkShape({ plan: {}, pools: [] }, "pool-usage").ok === true);
  const missingPools = checkShape({ plan: {} }, "pool-usage");
  check("a dropped `pools` key is reported", missingPools.ok === false && missingPools.missing.includes("pools"),
    JSON.stringify(missingPools));
  const renamedPlan = checkShape({ pools: [], planX: {} }, "pool-usage");
  check("a renamed `plan` is reported as missing", renamedPlan.missing.includes("plan"), JSON.stringify(renamedPlan));
  check("trend expects `series`", EXPECTED_SHAPES["credit-usage-trend"].includes("series"));
  check("a trend body without series drifts",
    checkShape({}, "credit-usage-trend").missing.includes("series"));
  // A null/array body must not throw — obj() folds it to {}.
  check("a null body reports every expected key missing",
    checkShape(null, "pool-usage").missing.length === poolKeys.length);
  check("an array body is not a plain object, so keys are missing",
    checkShape([], "pool-usage").ok === false);
  check("an unknown kind flags nothing", checkShape({}, "does-not-exist").ok === true);
}

// --- 4. parsePools(): normalization of the whole pool row -----------------
{
  const body = {
    plan: { id: "p1", name: "TokenPlan", type: "token_plan" },
    pools: [{
      id: "pool-1", name: "通用池", pool_type: "dedicated", model_ids: ["A", 42, "B"],
      window_5h: { limit: "60000", used: "12345", remaining: "47655", reset_at: "1800000000" },
      window_7d: { limit: 600000, used: 12345, remaining: 587655, reset_at: "1800600000" },
      grant_balance: "500",
      nearest_grant_expiry: "1800900000",
      nearest_grant_expiring_balance: "120"
    }]
  };
  try {
    const out = parsePools(body);
    check("plan fields are carried", out.plan.id === "p1" && out.plan.name === "TokenPlan" && out.plan.type === "token_plan");
    check("one pool row", out.pools.length === 1);
    const pool = out.pools[0];
    check("pool identity + type", pool.id === "pool-1" && pool.name === "通用池" && pool.poolType === "dedicated");
    // model_ids filters to strings only: a stray number cannot reach the panel.
    check("non-string model ids are dropped", pool.modelIds.join(",") === "A,B", pool.modelIds.join(","));
    check("5h window coerces strings to numbers",
      pool.window5h.limit === 60000 && pool.window5h.used === 12345 && pool.window5h.remaining === 47655);
    check("5h reset_at becomes a number", pool.window5h.resetAt === 1800000000, String(pool.window5h.resetAt));
    check("7d window parses alongside", pool.window7d.limit === 600000 && pool.window7d.resetAt === 1800600000);
    check("grant balance is coerced", pool.grantBalance === 500, String(pool.grantBalance));
    check("expiry fields normalize",
      pool.nearestGrantExpiry === 1800900000 && pool.nearestGrantExpiringBalance === 120);
  } catch (error) {
    fail("parsePools normalizes a full row", error);
  }

  // Defaults on a sparse body: pool_type falls back to "default", absent windows
  // become zeros/null rather than throwing.
  try {
    const sparse = parsePools({ plan: {}, pools: [{ id: "x" }] });
    const p = sparse.pools[0];
    check("a missing pool_type defaults to 'default'", p.poolType === "default", p.poolType);
    check("absent model_ids is an empty list", Array.isArray(p.modelIds) && p.modelIds.length === 0);
    check("absent windows read as zero/none, not undefined",
      p.window5h.limit === 0 && p.window5h.resetAt === null && p.window7d.used === 0);
    check("absent grant reads as zero", p.grantBalance === 0);
  } catch (error) {
    fail("parsePools tolerates a sparse pool", error);
  }

  // Malformed top-level shapes must not throw — the poll must survive.
  try {
    check("a missing pools array yields no rows", parsePools({ plan: {} }).pools.length === 0);
    check("a null pools value yields no rows", parsePools({ plan: {}, pools: null }).pools.length === 0);
    check("a completely empty body still parses", parsePools({}).pools.length === 0 && parsePools({}).plan.id === "");
  } catch (error) {
    fail("parsePools survives malformed input", error);
  }
}

// --- 5. parseTrend(): the SUM over points, not the first point ------------
// AGENTS.md names this exact semantic: a test once expected the first point and
// was wrong. Pin the sum, the rounding, the fallback id, and the sort order.
{
  const body = {
    series: [
      { model_id: "Low", points: [{ credits: 1 }, { credits: 2 }] },
      { model_id: "High", points: [{ credits: 42.5 }, { credits: 51.25 }] },
      { model_name: "NameOnly", points: [{ credits: 5 }] },
      { model_id: "Empty", points: [] },
      { model_id: "", points: [{ credits: 9 }] },
      { points: [{ credits: 3 }] }
    ]
  };
  try {
    const out = parseTrend(body, 24);
    check("hours echoes the requested window", out.hours === 24);
    // "" and the entry with neither id nor name are skipped entirely.
    check("rows without any model id are dropped", out.models.length === 4, JSON.stringify(out.models.map((m) => m.model)));
    const byModel = new Map(out.models.map((row) => [row.model, row.credits]));
    check("the trend is a SUM over points (42.5+51.25)", byModel.get("High") === 93.75, String(byModel.get("High")));
    check("a two-point sum adds correctly", byModel.get("Low") === 3, String(byModel.get("Low")));
    check("model_name is the fallback id", byModel.has("NameOnly") === true);
    check("an empty points array sums to zero", byModel.get("Empty") === 0);
    // Rows come back sorted by consumption, descending.
    const creditsList = out.models.map((m) => m.credits);
    check("rows are sorted by credits descending",
      [...creditsList].sort((a, b) => b - a).join(",") === creditsList.join(","), creditsList.join(","));
  } catch (error) {
    fail("parseTrend sums points and orders rows", error);
  }

  // Rounding to three decimals: 12.3456 -> 12.346, and float noise is cleaned.
  try {
    const rounded = parseTrend({ series: [{ model_id: "R", points: [{ credits: 12.3456 }] }] }, 24);
    check("credits round to three decimals", rounded.models[0].credits === 12.346, String(rounded.models[0].credits));
    const noisy = parseTrend({ series: [{ model_id: "N", points: [{ credits: 0.1 }, { credits: 0.2 }] }] }, 24);
    check("float noise (0.1+0.2) rounds clean", noisy.models[0].credits === 0.3, String(noisy.models[0].credits));
  } catch (error) {
    fail("parseTrend rounds cleanly", error);
  }

  // Malformed: a missing/non-array series yields an empty list, not a throw.
  try {
    check("a missing series reads as no rows", parseTrend({}, 24).models.length === 0);
    check("a non-array series reads as no rows", parseTrend({ series: null }, 24).models.length === 0);
    check("a point without credits counts as zero",
      parseTrend({ series: [{ model_id: "Z", points: [{}, { credits: 4 }] }] }, 24).models[0].credits === 4);
  } catch (error) {
    fail("parseTrend survives malformed input", error);
  }
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
