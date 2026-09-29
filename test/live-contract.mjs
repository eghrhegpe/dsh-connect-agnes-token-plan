/**
 * The SenseNova inference contract against the LIVE platform — run
 * deliberately, never by default.
 *
 * Companion to `test/live-jwks.test.mjs` (same discipline: not part of
 * `npm test`, a default run must not reach a real service). This one replays
 * the frozen `test/baselines/sensenova-contract.json` against the platform's
 * `/v1/models` catalogue and a SMALL set of inference probes, so a platform
 * dialect drift (a renamed field, a flipped 400, a new modality spelling)
 * shows up as a red here FIRST, before it silently degrades the panel.
 *
 * A failure is INFORMATION, not a regression — the fix belongs in
 * `docs/SENSENOVA-API.md` §7 (the comment layer) plus a refresh of the
 * baseline JSON with the new platform response, never in `llm-models.js`
 * logic. See ROADMAP.md §2.3 (the "live failure is not a regression" rule).
 *
 *   npm run test:live:contract
 *
 * One catalogue request (the `/v1/models` poll) plus at most ONE inference
 * probe per model family that the contract marks "thinking-object untested",
 * kept deliberately small and rate-limit friendly: each probe is a single
 * `reasoning_effort:"none"` chat completion, and a failure is recorded, not
 * retried.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  readFileSync(join(ROOT, "test", "baselines", "sensenova-contract.json"), "utf8")
);
const BASE_URL = contract.meta.baseUrl;

/** The live `sk-` key, read from the environment. `/v1/models` itself
 *  requires it (无鉴权实测 401，SENSENOVA-API.md §7.1), so without one the
 *  whole replay is meaningless — it SKIPs, loudly, and exits 0 the way
 *  `test/e2e-gate.mjs` does for a missing dsh CLI. A missing key is an
 *  environment fact, not a platform signal; conflating the two would train
 *  readers to ignore reds, which is the one thing a drift guard must never
 *  teach. */
const apiKey = process.env.SENSENOVA_API_KEY ?? "";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

if (apiKey === "") {
  console.log("SKIP test:live:contract — SENSENOVA_API_KEY is not set in this environment.");
  console.log("The platform's /v1/models answers 401 without a key, so nothing here");
  console.log("could distinguish 'the platform drifted' from 'we never asked'. Set the");
  console.log("key (or run on a Host whose credentials service holds it) and re-run.");
  process.exit(0);
}

// --- 1. the catalogue: every contract model still carries its frozen fields -
{
  let body;
  try {
    const response = await fetch(`${BASE_URL}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(30_000)
    });
    check("the /v1/models catalogue is reachable", response.ok, `HTTP ${response.status}`);
    body = await response.json().catch(() => null);
  } catch (error) {
    check("the /v1/models catalogue is reachable", false, String(error?.message ?? error));
  }
  if (body !== null) {
    const ids = new Set((Array.isArray(body.data) ? body.data : []).map((row) => row?.id));
    for (const model of contract.models) {
      check(`the catalogue still lists ${model.id}`, ids.has(model.id),
        `ids: ${[...ids].join(", ") || "none"}`);
      const row = (Array.isArray(body.data) ? body.data : []).find((r) => r?.id === model.id) ?? {};
      // The frozen modality fields in BOTH directions: a rename of
      // `input_modalities` / `output_modalities`, a model RE-CLAIMING image
      // input, or silently LOSING it, is a dialect drift, red here.
      if (model.visionInput === true) {
        check(`${model.id} input_modalities still declares image`,
          Array.isArray(row.input_modalities) && row.input_modalities.includes("image"),
          JSON.stringify(row.input_modalities));
      } else if (model.imageGen !== true && Array.isArray(body.data)) {
        check(`${model.id} input_modalities still declares NO image`,
          !(Array.isArray(row.input_modalities) && row.input_modalities.includes("image")),
          JSON.stringify(row.input_modalities));
      }
      if (model.imageGen === true) {
        check(`${model.id} output_modalities still declares image (excluded from chat)`,
          Array.isArray(row.output_modalities) && row.output_modalities.includes("image"),
          JSON.stringify(row.output_modalities));
      }
      if (model.contextLength !== undefined) {
        check(`${model.id} context_length still ${model.contextLength}`,
          row.context_length === model.contextLength,
          `got ${String(row.context_length)}`);
      }
    }
  }
}

// --- 2. inference probes: one `reasoning_effort:"none"` per untested model -
// Only the families the contract marked `thinkingObject: "untested"` /
// `"doc-claimed"` get a single live probe; a failure is recorded, never
// retried (rate-limit friendly against the shared pool). The key is always
// present here: without one the whole file already SKIPPED above.
for (const model of contract.models) {
  if (model.status !== "ok") continue; // 403/404 plans cannot be probed
  const probeNeeded = model.thinkingObject === "untested" || model.thinkingObject === "doc-claimed";
  if (!probeNeeded) continue;
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "ping" }],
        reasoning_effort: "none",
        max_tokens: 8,
        stream: false
      }),
      signal: AbortSignal.timeout(60_000)
    });
    const text = await response.text().catch(() => "");
    check(`${model.id} reasoning_effort:"none" probe answered ${response.status}`,
      response.ok, `HTTP ${response.status} ${text.slice(0, 120)}`);
  } catch (error) {
    check(`${model.id} reasoning_effort:"none" probe answered`, false,
      String(error?.message ?? error));
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} live contract check(s) did not hold`);
  console.error("A live contract failure is usually a PLATFORM change, not a code bug: " +
    "refresh test/baselines/sensenova-contract.json and docs/SENSENOVA-API.md §7.");
  process.exit(1);
}
console.log(`\nall ${results.length} live contract checks passed`);
