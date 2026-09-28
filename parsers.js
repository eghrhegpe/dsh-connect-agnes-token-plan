/**
 * Console response parsing and shape-drift detection.
 *
 * The parsers stay forgiving so a poll never throws because a field moved;
 * that forgiveness is also how a platform-side rename becomes a serene "no
 * data yet" screen, so `EXPECTED_SHAPES` + `checkShape` are what let the panel
 * say "the upstream shape changed" instead of "you used nothing".
 * @module dsh-connect-sensenova-token-plan/parsers
 */

import { str, obj } from "./util.js";

/**
 * The top-level keys each console contract is expected to carry.
 *
 * The parsers below stay forgiving so that a poll never throws because a field
 * moved. That forgiveness is also how a platform-side rename becomes a serene
 * "no data yet" screen, so this declaration is what lets the panel say
 * "the upstream shape changed" instead of "you used nothing".
 */
export const EXPECTED_SHAPES = Object.freeze({
  "pool-usage": ["plan", "pools"],
  "credit-usage-trend": ["series"]
});

/** Parse one numeric field the console returns as a string. */
export function credits(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parse one epoch field the console returns as a decimal STRING
 * (`reset_at`, `nearest_grant_expiry`): seconds since the epoch, or `null`
 * when absent or not a usable number. A string here is the console's own
 * shape — `Number` accepts it, and it keeps a second-precision integer.
 */
export function epochSeconds(value) {
  if (value === undefined || value === null || value === "" || value === "0") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/**
 * Report which expected top-level keys a console payload is missing.
 * @param {unknown} body - the parsed console response.
 * @param {string} kind - a key of {@link EXPECTED_SHAPES}.
 * @returns {{ok: boolean, missing: string[]}} the drift report.
 */
export function checkShape(body, kind) {
  const expected = EXPECTED_SHAPES[kind] ?? [];
  const source = obj(body);
  const missing = expected.filter((key) => source[key] === undefined);
  return { ok: missing.length === 0, missing };
}

/** Normalize the `pool-usage` response into the panel's pool rows. */
export function parsePools(body) {
  const plan = obj(body?.plan);
  const pools = Array.isArray(body?.pools) ? body.pools : [];
  return {
    plan: {
      id: str(plan.id, ""),
      name: str(plan.name, ""),
      type: str(plan.type, "")
    },
    pools: pools.map((pool) => {
      const source = obj(pool);
      const window5 = obj(source.window_5h);
      const window7 = obj(source.window_7d);
      return {
        id: str(source.id, ""),
        name: str(source.name, ""),
        poolType: str(source.pool_type, "default"),
        modelIds: Array.isArray(source.model_ids) ? source.model_ids.filter((m) => typeof m === "string") : [],
        window5h: {
          limit: credits(window5.limit),
          used: credits(window5.used),
          remaining: credits(window5.remaining),
          resetAt: epochSeconds(window5.reset_at)
        },
        window7d: {
          limit: credits(window7.limit),
          used: credits(window7.used),
          remaining: credits(window7.remaining),
          resetAt: epochSeconds(window7.reset_at)
        },
        grantBalance: credits(source.grant_balance),
        nearestGrantExpiry: epochSeconds(source.nearest_grant_expiry),
        nearestGrantExpiringBalance: credits(source.nearest_grant_expiring_balance)
      };
    })
  };
}

/** Normalize the `credit-usage-trend` response into per-model credit rows. */
export function parseTrend(body, trendHours) {
  const series = Array.isArray(body?.series) ? body.series : [];
  const rows = [];
  for (const entry of series) {
    const source = obj(entry);
    const modelId = str(source.model_id, str(source.model_name, ""));
    if (modelId === "") continue;
    const points = Array.isArray(source.points) ? source.points : [];
    let total = 0;
    for (const point of points) {
      total += credits(obj(point).credits);
    }
    rows.push({ model: modelId, credits: Math.round(total * 1000) / 1000 });
  }
  rows.sort((a, b) => b.credits - a.credits);
  return { hours: trendHours, models: rows };
}
