/**
 * The AgnesCode BFF contract against the LIVE platform — run deliberately,
 * never by default.
 *
 * Sibling of `test/live-contract.mjs` for the third upstream (ROADMAP §6.3,
 * the "仍缺：带凭据的 live 端到端探针档" gap): it replays the frozen BFF
 * facts (envelope `code` spelling, balance field set, catalogue field set,
 * the ADR-009 thinking wire) so a platform dialect drift or a dead 28-day
 * JWT shows up as a red here FIRST, before it silently degrades the panel.
 *
 * A failure is INFORMATION, not a regression — the fix belongs in the
 * comment layer (ROADMAP §6.3 / §6.3.1) and, when the catalogue changed, in
 * `AGNESCODE_FALLBACK_MODELS` + the `test/agnescode.test.mjs` count pins,
 * never in `src/host/agnescode*.ts` request logic. The one exception that IS
 * a credential fact: an expired or rejected token says "re-harvest from the
 * desktop App" — the panel's「检测本机登录态」ritual, which no script can do.
 *
 *   npm run test:live:agnescode          # two READ-ONLY requests
 *   npm run test:live:agnescode -- --chat  # + two BILLED thinking probes
 *
 * Credential resolution (first hit wins, token stays in process memory):
 *   1. `$AGNESCODE_CREDENTIAL` — a JSON document, the same shape the plugin
 *      persists (`{ access_token, bff_public_base_url }`).
 *   2. `refs.AGNESCODE_CREDENTIAL` in the DSH credentials service file
 *      (`$DSH_HOME/.credentials.yaml`, else `~/.dsh/.credentials.yaml`).
 * No credential → SKIP, loudly, exit 0 — a missing credential is an
 * environment fact, not a platform signal (the live-contract SKIP rule).
 *
 * Red lines honored by construction (ROADMAP §6.3.1 stdout discipline):
 *   - stdout carries SHAPE FACTS only: hostnames, HTTP statuses, key names,
 *     row counts, reasoning-token budget numbers. Never the token, the
 *     nickname, or generated content.
 *   - the BFF base from the credential is PINNED to the Agnes origin family
 *     before any Authorization header is aimed at it (mirror of
 *     `trustAgnescodeBffBase`, src/host/agnescode.ts) — a foreign base means
 *     the token goes nowhere.
 *   - a 429 is a rhythm answer, not a verdict: it is recorded as INDEFINITE
 *     (excluded from the failure count, re-run later), exactly the
 *     live-contract discipline.
 *
 * Rhythm: 3s backoff between the read-only probes, 5s around each billed
 * probe — deliberately LONGER than live-contract's 2s. The BFF is a smaller
 * upstream than the shared Token Plan pool, and a manual stage has no reason
 * to spend a faster rhythm.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const READ_ONLY_BACKOFF_MS = 3000;
const BILLED_BACKOFF_MS = 5000;
/** The ADR-009 model: non-member-only, chat-capable, the one the 2026-10-03
 *  real-machine thinking probe used. A model the account cannot run would
 *  403 and read as "the wire broke" when it is a plan question. */
const THINKING_PROBE_MODEL = "agnes-3.0-flash";

// Mirror of AGNESCODE_FALLBACK_MODELS (src/host/agnescode.ts, 2026-10-01 night
// re-probe, ROADMAP §6.3.1). Keep the two in lockstep; the src copy's count
// is pinned by test/agnescode.test.mjs, this list's ids by the catalogue
// cross-check below. A live row missing from the fallback is an INFO row
// (refresh the table when the catalogue moves), a fallback id missing live
// is a red (the fallback would push a model the platform no longer serves).
const FALLBACK_IDS = Object.freeze([
  "agnes-3.0-flash",
  "agnes-2.5-flash",
  "agnes-2.5-pro",
  "deepseek-v4-flash",
  "agnes-2.0-flash",
  "glm-5.2",
  "kimi-k3",
  "deepseek-v4-pro"
]);

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

// --- credential resolution (never printed, never logged) -------------------
function resolveCredential() {
  const env = process.env.AGNESCODE_CREDENTIAL ?? "";
  if (env.trim() !== "") {
    try {
      return JSON.parse(env);
    } catch {
      return { malformed_env: true };
    }
  }
  const candidates = [];
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== "") {
    candidates.push(join(process.env.DSH_HOME, ".credentials.yaml"));
  }
  candidates.push(join(homedir(), ".dsh", ".credentials.yaml"));
  for (const file of candidates) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Targeted parse: refs entries are two-space-indented, single-quoted,
    // one line each. `records:` entries never match the key name.
    const line = text.split("\n").find((l) => /^\s{2}AGNESCODE_CREDENTIAL:\s*/.test(l));
    if (line === undefined) continue;
    let value = line.trim().replace(/^AGNESCODE_CREDENTIAL:\s*/, "").trim();
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    try {
      return { ...JSON.parse(value), __from_file: file };
    } catch {
      return { malformed_file: file };
    }
  }
  return null;
}

// Mirror of trustAgnescodeBffBase: https, default port only, Agnes family.
function pinBffBase(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "") return null;
  const host = url.hostname.toLowerCase();
  if (!(host === "agnes-ai.cn" || host === "agnes-ai.com"
    || host.endsWith(".agnes-ai.cn") || host.endsWith(".agnes-ai.com"))) {
    return null;
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const raw = resolveCredential();
if (raw === null || raw.malformed_env || raw.malformed_file !== undefined) {
  console.log("SKIP test:live:agnescode — no usable AGNESCODE_CREDENTIAL.");
  if (raw?.malformed_env) {
    console.log("$AGNESCODE_CREDENTIAL is set but is not a JSON document.");
  } else if (raw?.malformed_file !== undefined) {
    console.log(`Found refs.AGNESCODE_CREDENTIAL in ${raw.malformed_file} but it is not a parseable JSON document.`);
  } else {
    console.log("Set the reference (the panel's「检测本机登录态」harvest writes it) or the env var, then re-run.");
  }
  console.log("A missing credential is an environment fact, not a platform signal — skipping is a pass.");
  process.exit(0);
}

const accessToken = String(raw.access_token ?? "");
const bffBase = pinBffBase(String(raw.bff_public_base_url ?? ""));
if (accessToken === "" || bffBase === null) {
  console.log("SKIP test:live:agnescode — the credential carries no access token or no Agnes-family BFF base; the token is aimed at nothing.");
  process.exit(0);
}
// The apiRoot is the BFF base WITHOUT its /v1 suffix (the plugin's
// agnescodeApiRoot rule: the credits endpoint does not live under /v1).
const apiRoot = bffBase.endsWith("/v1") ? bffBase.slice(0, -3) : bffBase;
const host = new URL(bffBase).hostname;
console.log(`bff host: ${host} | apiRoot: ${apiRoot}`);

const headers = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Authorization: `Bearer ${accessToken}`,
  "X-App-Id": "1",
  "X-Platform": "1",
  "X-User-Language": "zh-Hans"
};

// --- 0. the JWT lifetime: the 28-day fact the panel cannot renew -----------
{
  const parts = accessToken.split(".");
  let daysLeft = null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    if (typeof payload?.exp === "number") daysLeft = (payload.exp * 1000 - Date.now()) / 86_400_000;
  } catch { /* undecodable exp: the balance probe below answers whether the token is actually dead */ }
  if (daysLeft === null) {
    check("the JWT exp claim decodes", false, "no numeric exp — the expiry cannot be predicted, only felt as a 401");
  } else {
    check("the JWT is not expired", daysLeft > 0,
      `~${daysLeft.toFixed(1)} days left${daysLeft > 0 && daysLeft <= 3 ? " — near-expiry: plan the desktop re-harvest (panel「检测本机登录态」)" : ""}`);
  }
}

// --- 1. credits-balance: the envelope + field set the plugin parses --------
{
  let response;
  try {
    response = await fetch(`${apiRoot}/api/v2/subscription/credits-balance`, {
      headers,
      signal: AbortSignal.timeout(30_000)
    });
  } catch (error) {
    check("the credits-balance endpoint is reachable", false, String(error?.message ?? error));
  }
  if (response !== undefined) {
    if (response.status === 429) {
      check("credits-balance probe INDEFINITE (rate-limited)", true,
        "HTTP 429 — re-run after the window clears; a 429 is not a verdict");
    } else if (response.status === 401) {
      check("the stored token is still accepted", false,
        "HTTP 401 — the token was rejected: re-harvest from the desktop App, then save the credential again");
    } else {
      check("the credits-balance endpoint answers 200", response.status === 200, `HTTP ${response.status}`);
      const envelope = (await response.json().catch(() => ({}))) ?? {};
      const data = envelope.data;
      check("the envelope code is the frozen STRING \"000000\"",
        typeof envelope.code === "string" && envelope.code === "000000",
        `code=${JSON.stringify(envelope.code)} (typeof ${typeof envelope.code})`);
      const numeric = (v) => typeof v === "number" && Number.isFinite(v);
      const balanceKeys = ["total_balance", "time_sensitive_balance", "permanent_balance", "daily_free_credits", "subscription_credits"];
      const periodKeys = ["current_period_start", "current_period_end", "duration", "cancel_at_period_end"];
      const haveData = data !== null && typeof data === "object";
      check("data carries all five balance fields as numbers",
        haveData && balanceKeys.every((k) => numeric(data?.[k])),
        haveData ? balanceKeys.map((k) => `${k}=${data?.[k]}`).join(" ") : "data missing");
      check("data carries level + the four subscription-period keys",
        haveData && numeric(data?.level) && periodKeys.every((k) => k in (data ?? {})),
        haveData ? `level=${data?.level} periodKeys=${periodKeys.filter((k) => k in data).length}/4` : "data missing");
    }
  }
  await sleep(READ_ONLY_BACKOFF_MS);
}

// --- 2. the catalogue: the row field set the parser builds on -------------
{
  let response;
  try {
    response = await fetch(`${bffBase}/models`, {
      headers,
      signal: AbortSignal.timeout(30_000)
    });
  } catch (error) {
    check("the /models catalogue is reachable", false, String(error?.message ?? error));
  }
  if (response !== undefined) {
    if (response.status === 429) {
      check("/models probe INDEFINITE (rate-limited)", true,
        "HTTP 429 — re-run after the window clears; a 429 is not a verdict");
    } else {
      check("the /models catalogue answers 200", response.status === 200, `HTTP ${response.status}`);
      const body = (await response.json().catch(() => ({}))) ?? {};
      const rows = Array.isArray(body.data) ? body.data : [];
      const liveIds = [...new Set(rows.map((r) => String(r?.id ?? "")).filter((id) => id !== ""))];
      check("the catalogue rows carry the parser's field set (id / model_type / max_input_tokens / max_output_tokens)",
        rows.length > 0 && rows.every((r) =>
          typeof r?.id === "string" && r.id !== ""
          && "model_type" in (r ?? {})
          && "max_input_tokens" in (r ?? {})
          && "max_output_tokens" in (r ?? {})),
        `rows=${liveIds.length} ids: ${liveIds.join(", ") || "none"}`);
      const missingLive = FALLBACK_IDS.filter((id) => !liveIds.includes(id));
      check("every AGNESCODE_FALLBACK_MODELS id is still served live",
        missingLive.length === 0,
        missingLive.length > 0 ? `no longer listed: ${missingLive.join(", ")} — refresh the fallback table` : "all 8 live");
      const newLive = liveIds.filter((id) => !FALLBACK_IDS.includes(id));
      check(`INFO: ${newLive.length === 0 ? "the catalogue added no rows beyond the fallback" : "catalogue rows beyond the fallback (refresh AGNESCODE_FALLBACK_MODELS + the agnescode.test.mjs count pin, same discipline as the 10-01 re-probe)"}`,
        true,
        newLive.join(", ") || "");
    }
  }
  await sleep(READ_ONLY_BACKOFF_MS);
}

// --- 3. the ADR-009 thinking wire: two BILLED probes (opt-in) -------------
// The probes replay the WIRE THE PLUGIN ACTUALLY SENDS — not the desktop App's
// switch. `request_params.agnes_thinking_enabled` is a desktop-contract fact
// recorded in ADR-009; the plugin's descriptor (src/host/agnescode-models.ts)
// instead speaks pi-ai's standard `reasoning_effort` and spells `off` as
// "no field at all" (thinkingLevelMap off→null). So the two directions worth
// re-probing are:
//   ON  — `reasoning_effort:"high"`: the BFF must still accept it and
//         still produce reasoning content (the ADR-009 "档位可用" fact).
//   OFF — no thinking field at all: the BFF's default is thinking ON (the
//         10-03 v1-shape fact). If it STOPS producing reasoning content in
//         that shape, ADR-009's "off 诚实不提供" premise flips — a finding to
//         carry to the ADR, not a code change here.
// `usage.reasoning_tokens` gets an INFO line, not a verdict: the plugin does
// not read that value at runtime (only the comment layer mentions it), so a
// drift to zero/absent is a documentation fact, not a red.
if (process.argv.includes("--chat")) {
  const probe = async (label, extraBody, wantReasoning) => {
    await sleep(BILLED_BACKOFF_MS); // billed probes get the longer margin
    let response;
    try {
      // `bffBase` already carries the `/v1` suffix (the credential's
      // `bff_public_base_url`), so the chat path is relative to it — the same
      // shape `fetchAgnescodeCatalog` uses for `${bffBase}/models`.
      response = await fetch(`${bffBase}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: THINKING_PROBE_MODEL,
          // A harmless multi-step arithmetic prompt: the 10-03 probe used one,
          // and the evidence needed is reasoning-content LENGTHS, not content.
          messages: [{ role: "user", content: "step by step: 3×7 + 41, then multiply by 2" }],
          max_tokens: 32,
          stream: false,
          ...extraBody
        }),
        signal: AbortSignal.timeout(60_000)
      });
    } catch (error) {
      check(`${THINKING_PROBE_MODEL} thinking probe "${label}" reachable`, false, String(error?.message ?? error));
      return;
    }
    if (response.status === 429) {
      check(`${THINKING_PROBE_MODEL} thinking probe "${label}" INDEFINITE (rate-limited, not a wire verdict)`,
        true, "HTTP 429 — re-run after the window clears");
      return;
    }
    const body = (await response.json().catch(() => ({}))) ?? {};
    const message = body.choices?.[0]?.message ?? {};
    const reasoningChars = typeof message.reasoning_content === "string" ? message.reasoning_content.length : 0;
    const usage = body.usage ?? {};
    const reasoningTokens = typeof usage.reasoning_tokens === "number" ? usage.reasoning_tokens : -1; // -1 = absent
    check(`${THINKING_PROBE_MODEL} thinking probe "${label}" answers 200`,
      response.status === 200, `HTTP ${response.status} ${JSON.stringify(body).slice(0, 120)}`);
    check(`${THINKING_PROBE_MODEL} thinking "${label}" ${wantReasoning
      ? "still produces reasoning content (the frozen ADR-009 fact)"
      : "STILL defaults to thinking on (the premise behind off→null)"}`,
      reasoningChars > 0,
      `reasoning_chars=${reasoningChars}${reasoningChars === 0 ? " — if the no-field shape now suppresses reasoning, ADR-009's off-premise flipped: carry it to docs/ADR.md, do not patch the wire" : ""}`);
    const tokensLabel = reasoningTokens < 0 ? "absent" : String(reasoningTokens);
    check(`INFO: usage.reasoning_tokens observed ${tokensLabel} (plugin does not read it at runtime; the 10-03 re-probe fact was non-zero)`,
      true, `reasoning_chars=${reasoningChars} reasoning_tokens=${tokensLabel}`);
  };
  // ON: the plugin's own wire for a thinking level (descriptor
  // `reasoning:true` + thinkingLevelMap low/medium/high → `reasoning_effort`).
  await probe("ON wire (reasoning_effort high)", { reasoning_effort: "high" }, true);
  // OFF: the plugin's own wire for "off" — the field ABSENT (off→null).
  await probe("OFF wire (no thinking field)", {}, false);
}

console.log(JSON.stringify(results, null, 2));
// Same verdict rule as live-contract: a 429 is a rhythm answer, not a
// platform verdict; only a non-INDEFINITE red counts.
const failed = results.filter((r) => !r.pass && !r.name.includes("INDEFINITE"));
const indefinite = results.filter((r) => r.name.includes("INDEFINITE"));
if (failed.length > 0 || indefinite.length > 0) {
  if (indefinite.length > 0) {
    console.error(`\n${indefinite.length} probe(s) INDEFINITE (rate-limited, no verdict):`);
    for (const row of indefinite) console.error(`  - ${row.name}`);
    console.error("Re-run after the rate window clears; a 429 is not a verdict.");
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length}/${results.length} live AgnesCode check(s) did not hold`);
    console.error("A live AgnesCode failure is usually a PLATFORM change or an EXPIRED token, not a code bug:");
    console.error("refresh ROADMAP §6.3.1 / the AGNESCODE_FALLBACK_MODELS table (with the agnescode.test.mjs count pins),");
    console.error("or re-harvest the desktop App session for the 401 case — never the src/host request logic.");
  }
  process.exit(failed.length > 0 ? 1 : 0);
}
console.log(`\nall ${results.length} live AgnesCode checks passed`);
