/**
 * The frozen Agnes inference contract — peer-free offline gate.
 *
 * `test/baselines/agnes-contract.json` records what the platform's
 * `https://api.agnes-ai.cn/v1` catalogue and thinking dialect are known to be.
 * Its `meta` half is SOURCE-DERIVED (`baseUrl` from `CONFIG_DEFAULTS.apiBase`,
 * `apiKeyRef` from `api-key-store.API_KEY_REF`), and this suite asserts that
 * link: a baseline pointing at a different origin than the code would replay a
 * clean run against the wrong platform, which is the one failure a drift guard
 * must never have.
 *
 * The per-model half is still a SEED until `npm run test:live:contract` is run
 * with a real key (the baseline's own `meta.note` says so; `docs/AGNES-API.md`
 * §7 is the human mirror). So every cell is read in BOTH directions:
 *
 *   - `true`      → the code MUST offer that level (a probe answered 200);
 *   - `false`     → the code MUST NOT offer it (probed and refused);
 *   - `"pending"` → never probed, and the code must treat it exactly like
 *     `false` — a level nobody proved stays CLOSED. That conservative
 *     direction is what lets a seed baseline drive real assertions instead of
 *     a suite full of maybes.
 *
 * Any other cell value fails, so a half-filled baseline cannot pass as frozen.
 *
 * Everything here imports no Host peer, so the contract stays covered on a
 * clean checkout. A red here means the CODE drifted from the recorded dialect,
 * not that the platform changed — the platform side is `test/live-contract.mjs`
 * (manual, `npm run test:live:contract`).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  toPiDescriptor,
  buildDescriptors,
  isChatModel,
  rosterWithAvailability,
  supportedThinkingLevels,
  thinkingLevelMapFor,
  FALLBACK_CONTEXT_WINDOW,
  PROBED_CONTEXT_WINDOWS,
  LLM_PROVIDER_ID
} from "../src/host/llm-models.ts";
import { countOf, timestampSeconds, checkShape, identifyVisionModel } from "../src/host/parsers.ts";
import { retryableCodes, QUOTA_CODES } from "../src/host/llm-retry.ts";
import { isCredentialRefusal, CODE } from "../src/host/codes.ts";
import { CONFIG_DEFAULTS } from "../src/host/host-config.ts";
import { API_KEY_REF } from "../src/host/api-key-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  readFileSync(join(ROOT, "test", "baselines", "agnes-contract.json"), "utf8")
);
const baseUrl = contract.meta.baseUrl;

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

/** The thinking levels the baseline freezes, in the picker's ladder order.
 *  The cell KEY is the platform's wire spelling (`none` — what the off level
 *  dispatches to), matching sensenova-contract.json's vocabulary. */
const EFFORT_CELLS = ["none", "low", "medium", "high", "xhigh", "max"];

// --- 0. the baseline's own discipline -------------------------------------
// The two `meta` facts are not opinions: they are read off the source, so the
// baseline and the code cannot describe different platforms. And every effort
// cell must be a real verdict — a missing or misspelled cell would silently
// read as "not true" and close a level nobody ever probed.
{
  check("the baseline's baseUrl is the code's apiBase",
    baseUrl === CONFIG_DEFAULTS.apiBase, `${baseUrl} vs ${CONFIG_DEFAULTS.apiBase}`);
  check("the baseline's apiKeyRef is the credential name the code stores under",
    contract.meta.apiKeyRef === API_KEY_REF, `${contract.meta.apiKeyRef} vs ${API_KEY_REF}`);
  check("the baseline carries a drift log", Array.isArray(contract.meta.driftLog),
    JSON.stringify(contract.meta.driftLog));
  check("the baseline declares at least one model", contract.models.length > 0,
    String(contract.models.length));

  for (const model of contract.models) {
    // The effort ladder is a CHAT-model question: image/video rows are
    // presence guards only (their chat endpoint 400s by design), so they
    // carry no reasoningEffort at all and demanding cells here would force
    // fake verdicts into the baseline.
    if (model.chat !== true) continue;
    for (const level of EFFORT_CELLS) {
      const cell = model.reasoningEffort?.[level];
      check(`${model.id} reasoningEffort.${level} is a frozen verdict or "pending"`,
        cell === true || cell === false || cell === "pending", JSON.stringify(cell));
    }
  }
}

// --- 1. catalog entry shape from the contract -----------------------------
// The contract's `models` entries are the normalized catalog rows
// (`console-client.js` keeps each `/v1/models` row whole, plus the plugin's
// `id`). Build them exactly the way the provider would see them.
function entryFor(model) {
  if (model.modalityMetadata === "none") {
    // The Agnes reality: the catalog entry carries NO modality metadata, so
    // both predicates must fall through to the id-name layer (modality.ts
    // resolution level 2). Synthesizing the fields here would hide a name
    // regression behind a declaration the platform never sends.
    return {
      id: model.id,
      ...(model.contextLength !== undefined ? { context_length: model.contextLength } : {})
    };
  }
  return {
    id: model.id,
    input_modalities: model.visionInput ? ["text", "image"] : ["text"],
    output_modalities: model.imageGen ? ["image"] : ["text"],
    ...(model.contextLength !== undefined ? { context_length: model.contextLength } : {})
  };
}

// --- 2. toPiDescriptor against the frozen contract ------------------------
for (const model of contract.models) {
  if (model.chat !== true) continue; // 403/404 models are asserted in §3
  try {
    const entry = entryFor(model);
    const descriptor = toPiDescriptor(entry, { baseUrl });
    check(`${model.id} descriptor.id is the catalog id`, descriptor.id === model.id, descriptor.id);
    check(`${model.id} descriptor pins max_tokens field with the probed cap 65536`,
      descriptor.compat?.maxTokensField === "max_tokens" && descriptor.compat?.supportsDeveloperRole === false &&
      descriptor.maxTokens === 65_536,
      JSON.stringify({ compat: descriptor.compat, maxTokens: descriptor.maxTokens }));
    check(`${model.id} descriptor declares reasoning + thinkingLevelMap`,
      descriptor.reasoning === true && typeof descriptor.thinkingLevelMap === "object",
      JSON.stringify({ reasoning: descriptor.reasoning }));
    const map = thinkingLevelMapFor(entry);
    // `off` is the one level whose wire spelling is pinned platform-wide: the
    // picker's 关闭 must send `none`, because `off` itself is refused.
    check(`${model.id} thinkingLevelMap.off === "none" (platform off spelling)`,
      map.off === "none", JSON.stringify(map.off));
    check(`${model.id} thinkingLevelMap.high === "high" (platform default, always offered)`,
      map.high === "high", JSON.stringify(map.high));
    check(`${model.id} thinkingLevelMap.minimal === null (unverified on this gateway)`,
      map.minimal === null, JSON.stringify(map.minimal));
    // low/medium/xhigh/max are per-model, gated on the baseline's own cells: a
    // level is offered ONLY where the cell says a probe answered 200. `false`
    // and `"pending"` both stay closed — "not measured" is never "supported".
    for (const level of ["low", "medium", "xhigh", "max"]) {
      const cell = model.reasoningEffort?.[level];
      if (cell === true) {
        check(`${model.id} thinkingLevelMap.${level} === "${level}" (probed 200)`,
          map[level] === level, JSON.stringify(map[level]));
      } else {
        check(`${model.id} thinkingLevelMap.${level} === null (${cell === false ? "probed and refused" : "unprobed"})`,
          map[level] === null, JSON.stringify({ cell, got: map[level] }));
      }
    }
    // vision: the descriptor's input array mirrors the contract's visionInput
    // flag (structured `input_modalities` wins).
    const expectedInput = model.visionInput ? ["text", "image"] : ["text"];
    check(`${model.id} descriptor.input matches contract visionInput`,
      JSON.stringify(descriptor.input) === JSON.stringify(expectedInput),
      JSON.stringify({ got: descriptor.input, want: expectedInput }));
    // The window: a declared `context_length` wins; an entry that declares none
    // gets the official-doc hard table (`PROBED_CONTEXT_WINDOWS`, source =
    // archived platform docs), and only a model in neither keeps the SAME
    // fallback pi-ai is handed — never undefined, which pi-ai's options
    // builder would treat as zero.
    if (model.contextLength !== undefined) {
      check(`${model.id} descriptor.contextWindow reads catalog context_length`,
        descriptor.contextWindow === model.contextLength,
        `${descriptor.contextWindow} vs ${model.contextLength}`);
    } else {
      const official = PROBED_CONTEXT_WINDOWS[model.id];
      const want = official ?? FALLBACK_CONTEXT_WINDOW;
      check(`${model.id} descriptor.contextWindow falls back to the shipped default`,
        descriptor.contextWindow === want,
        `${descriptor.contextWindow} vs ${want}`);
    }
  } catch (error) { fail(`${model.id} descriptor`, error); }
}

// --- 3. isChatModel excludes the image/video generation + 404/403 models --
for (const model of contract.models) {
  const entry = entryFor(model);
  if (model.imageGen === true) {
    check(`${model.id} (image-gen) is NOT a chat model (excluded from picker)`,
      isChatModel(entry) === false, "isChatModel should be false");
  } else if (model.chat === true) {
    // A 403 plan restriction is NOT an image-gen model: it stays in the offer
    // (the panel greys it with the reason instead of hiding it).
    check(`${model.id} stays a chat model despite its plan status (${model.status})`,
      isChatModel(entry) === true, "isChatModel should be true");
  } else if (model.modalityMetadata === "none") {
    // The Agnes reality: no declared modalities to lean on, so the exclusion
    // must come from the id's own family segment (`agnes-image-*` /
    // `agnes-video-*`) — modality.ts resolution level 2.
    check(`${model.id} is excluded from chat by its id name alone (the catalog declares no modalities)`,
      isChatModel(entry) === false, "isChatModel should be false via the name layer");
  }
}

// --- 4. identifyVisionModel mirrors the contract's visionInput ------------
for (const model of contract.models) {
  const entry = entryFor(model);
  const verdict = identifyVisionModel(entry);
  check(`${model.id} identifyVisionModel.vision matches contract`,
    verdict.vision === (model.visionInput === true),
    JSON.stringify({ got: verdict.vision, want: model.visionInput === true }));
}

// --- 5. the thinking gate: a probed id rides the table, an unknown one the safe-set
// A model PRESENT in the probe table gets exactly the levels its cells proved
// (§2 pins every cell); a model ABSENT from it (an id Agnes added this
// morning) is given the OpenAI-compatible safe-set so the picker is never
// empty, while the extended levels stay closed. The one place the two branches
// visibly differ today is agnes-3.0-flash's xhigh: the table OPENS it (probed
// 200 on a wider upstream validator) where the safe-set keeps it closed — so
// this section fails if the table branch ever degrades into the safe-set.
{
  const known = thinkingLevelMapFor({ id: "agnes-3.0-flash" });
  check("a known id rides its probed cells, not the safe-set (3.0-flash xhigh open where the safe-set stays closed)",
    known.xhigh === "xhigh", JSON.stringify(known));
  check("xhigh stays closed where the validator refused it (union text has no xhigh: 2026-10-01, 2.0/2.5 both 400)",
    thinkingLevelMapFor({ id: "agnes-2.0-flash" }).xhigh === null &&
    thinkingLevelMapFor({ id: "agnes-2.5-flash" }).xhigh === null,
    JSON.stringify([thinkingLevelMapFor({ id: "agnes-2.0-flash" }).xhigh,
      thinkingLevelMapFor({ id: "agnes-2.5-flash" }).xhigh]));
  check("max is open on every known chat model (2026-10-01 ladder; a dialect flip from the SenseNova era)",
    thinkingLevelMapFor({ id: "agnes-2.0-flash" }).max === "max" &&
    thinkingLevelMapFor({ id: "agnes-2.5-flash" }).max === "max" &&
    thinkingLevelMapFor({ id: "agnes-3.0-flash" }).max === "max");

  const unknown = thinkingLevelMapFor({ id: "a-model-added-tomorrow" });
  check("an unprobed id is offered the OpenAI-compatible safe-set",
    unknown.off === "none" && unknown.low === "low" && unknown.medium === "medium" && unknown.high === "high",
    JSON.stringify(unknown));
  check("an unprobed id keeps the extended levels closed",
    unknown.minimal === null && unknown.xhigh === null && unknown.max === null,
    JSON.stringify(unknown));
  check("an id-less entry is treated as unprobed, not as a known one",
    thinkingLevelMapFor({}).low === "low", JSON.stringify(thinkingLevelMapFor({})));
}

// --- 6. buildDescriptors / rosterWithAvailability: offer vs greyed -------
// The picker DROPS a model the Host declares unavailable (so no doomed request
// is dispatched) while the panel roster KEEPS it, greyed, with the reason. On
// Agnes nothing is ever handed in — there is no per-model quota to deplete —
// and that is pinned here so a future change has to be deliberate.
{
  const allEntries = contract.models.map(entryFor);
  const chatIds = contract.models.filter((m) => m.chat === true).map((m) => m.id);
  const offered = buildDescriptors(allEntries, { baseUrl, enabledIds: [], unavailableModelIds: [] });
  const offeredIds = offered.map((d) => d.id);
  check("buildDescriptors offers exactly the contract's chat models",
    JSON.stringify(offeredIds) === JSON.stringify(chatIds),
    JSON.stringify({ offered: offeredIds, want: chatIds }));
  check("every descriptor carries the plugin's own provider id",
    offered.every((d) => d.provider === LLM_PROVIDER_ID), JSON.stringify(offered.map((d) => d.provider)));

  // The image/video generation family (400 on the chat endpoint, "请使用
  // /v1/images/generations" / "/v1/videos") is the only one the picker
  // excludes. On Agnes the catalog declares no modality field, so the
  // load-bearing signal is the id's family segment via modality.ts's name
  // layer (the `modalityMetadata: "none"` rows); a platform that DOES declare
  // `output_modalities` is covered by an `imageGen: true` row instead.
  const imageGenIds = contract.models.filter((m) => m.imageGen === true).map((m) => m.id);
  const nameExcludedIds = contract.models.filter((m) => m.modalityMetadata === "none").map((m) => m.id);
  check("buildDescriptors excludes every non-chat model from the offer (declared or name-inferred)",
    imageGenIds.every((id) => !offeredIds.includes(id)) &&
    nameExcludedIds.every((id) => !offeredIds.includes(id)),
    JSON.stringify({ offered: offeredIds, imageGen: imageGenIds, nameExcluded: nameExcludedIds }));

  // Nothing handed in: the offer is the whole chat set and every roster row is
  // available. Agnes allocates no quota per model, so an empty blocked set is
  // the DESIGN, not a missing derivation.
  const roster = rosterWithAvailability(allEntries, []);
  check("with nothing handed in, every roster row is available",
    roster.length === chatIds.length && roster.every((row) => row.available === true && row.quotaExhausted === false),
    JSON.stringify(roster.map((row) => [row.id, row.available])));
  check("the roster quotes the same levels the descriptor will dispatch",
    roster.every((row) => {
      const entry = allEntries.find((candidate) => candidate.id === row.id);
      return JSON.stringify(row.thinkingLevels) === JSON.stringify(supportedThinkingLevels(entry));
    }),
    JSON.stringify(roster.map((row) => [row.id, row.thinkingLevels.join("/")])));

  // Handed in: the offer drops it, the roster keeps it greyed. This is the
  // mechanism the sibling upstream reuses.
  const blockedId = chatIds[0];
  const blockedOffer = buildDescriptors(allEntries, { baseUrl, enabledIds: [], unavailableModelIds: [blockedId] });
  check("buildDescriptors drops a handed-in unavailable id from the offer",
    blockedOffer.every((d) => d.id !== blockedId), JSON.stringify(blockedOffer.map((d) => d.id)));
  const greyed = rosterWithAvailability(allEntries, [blockedId]);
  check("the roster keeps the unavailable model, greyed with a reason",
    greyed.some((row) => row.id === blockedId && row.available === false && row.quotaExhausted === true),
    JSON.stringify(greyed.filter((row) => !row.available)));
  check("the roster's unavailable set is exactly what was handed in",
    greyed.filter((row) => !row.available).map((row) => row.id).join(",") === blockedId,
    JSON.stringify(greyed.filter((row) => !row.available).map((row) => row.id)));
}

// --- 7. parsers: the console's numeric/epoch spellings -------------------
// The Agnes console mixes real JSON numbers (plan limits) with numeric STRINGS
// (usage counters on the sibling gateway routes), and its timestamps arrive as
// epoch seconds, epoch millis or an ISO date depending on the route. Both
// coercions are pinned here against the same helpers the poll uses.
{
  check("countOf normalizes a string number (the platform's spelling)",
    countOf("12345") === 12345, String(countOf("12345")));
  check("countOf returns 0 for an absent value", countOf(undefined) === 0, String(countOf(undefined)));
  check("countOf returns 0 for a non-numeric string", countOf("n/a") === 0, String(countOf("n/a")));
  check("timestampSeconds reads a decimal-seconds STRING",
    timestampSeconds("1700000000") === 1700000000, String(timestampSeconds("1700000000")));
  check("timestampSeconds reads an epoch in MILLIS",
    timestampSeconds(1700000000000) === 1700000000, String(timestampSeconds(1700000000000)));
  check("timestampSeconds returns null for absent/0",
    timestampSeconds(null) === null && timestampSeconds("0") === null,
    JSON.stringify([timestampSeconds(null), timestampSeconds("0")]));

  // The drift shapes the poll checks: the account overview's two totals and the
  // series' `items` array. A missing key is a drift, never "no usage".
  const drift = checkShape({ total_requests: 1 }, "usage-overview");
  check("checkShape flags an overview body missing `total_tokens` (drift, not 'no data')",
    drift.ok === false && drift.missing.includes("total_tokens"), JSON.stringify(drift));
  check("checkShape flags a series body missing `items`",
    checkShape({}, "usage-series").missing.includes("items"));
  // `subscription` declares only its OBSERVED identity keys (2026-10-01,
  // docs/AGNES-API.md §6): `plan_name` / `billing_cycle`. A body without them
  // is drift; the `usage` block is deliberately NOT expected — an account that
  // has never consumed anything may simply omit it.
  check("checkShape expects the subscription's observed identity keys",
    checkShape({ plan_name: "入门版", billing_cycle: "monthly" }, "subscription").ok === true);
  check("checkShape flags a subscription body without the identity keys",
    checkShape({ anything: 1 }, "subscription").ok === false);
  check("a subscription body without `usage` is NOT drift",
    checkShape({ plan_name: "入门版", billing_cycle: "monthly" }, "subscription").missing.includes("usage") === false);
}

// --- 8. 429 / quota classification matches the frozen retry policy --------
{
  const codes = retryableCodes();
  check("retryableCodes keeps RATE_LIMIT (transient throttle self-clears)",
    codes.includes(QUOTA_CODES.rateLimit), JSON.stringify(codes));
  check("retryableCodes excludes QUOTA (depleted shared pool is not retried)",
    !codes.includes(QUOTA_CODES.quota), JSON.stringify(codes));
  check("retryableCodes excludes ACCOUNT_QUOTA",
    !codes.includes(QUOTA_CODES.accountQuota), JSON.stringify(codes));
  // A quota-shaped refusal is parked, never auto-retried (the credential
  // discipline the throttle-store enforces).
  check("isCredentialRefusal treats a parked quota refusal as non-retriable",
    isCredentialRefusal(CODE.LOGIN_REJECTED) === true,
    "login_rejected is the credential-shaped refusal");
}

// --- 9. vision model roster mirrors the contract's visionInput -----------
{
  const allEntries = contract.models.map(entryFor);
  // The vision LIST is asserted through `identifyVisionModel` in §4 against the
  // STRUCTURED field only (the platform's `input_modalities`), independent of a
  // model's 403/404 status. Count the vision chat models the picker offers:
  // every contract model with `chat: true` and `visionInput: true`.
  const visionChat = contract.models.filter((m) => m.chat === true && m.visionInput === true);
  const visionOffer = buildDescriptors(allEntries, { baseUrl, enabledIds: [], unavailableModelIds: [] })
    .filter((d) => JSON.stringify(d.input) === JSON.stringify(["text", "image"]));
  check("the vision offer count matches the contract's visionInput chat models",
    visionOffer.length === visionChat.length,
    `${visionOffer.length} vs ${visionChat.length}`);
}

// --- 10. the snapshot wire contract: both halves name the same keys -------
//
// `src/client/wire.ts` states the CONSTRAINT in prose — "Every type here
// mirrors a field the Host's `buildSnapshotBody` returns" — and that prose
// named a gate in THIS file which, until now, did not exist (docs/PITFALLS.md
// §39). The client half bundles without the Host, so the check cannot be an
// import: it parses the Host's top-level `return {` literal and the client's
// `SnapshotData` declaration as TEXT and compares the key sets.
//
// The load-bearing direction is Host ⊆ Client. A key the Host serves and the
// client never declares is data dropped silently on the floor — the failure
// this whole duplication constraint exists to prevent. The reverse direction
// (client declares, Host never serves) is reported as a note, never failed:
// every client field is optional by design, so it is a §38 "looks like a
// path" signal for review rather than a break.
{
  const readSource = (rel) => readFileSync(join(ROOT, rel), "utf8");

  /**
   * Top-level keys of the Host snapshot literal (exactly 4-space indent, so
   * nested objects at 6+ spaces stay out).
   * @param {string} text - `snapshot-aggregate.ts` source.
   * @returns {Set<string>} the key names, empty if the parse found no literal.
   */
  function hostKeys(text) {
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((l) => /^export async function buildSnapshotBody\b/.test(l));
    const open = at < 0 ? -1 : lines.findIndex((l, i) => i > at && /^ {2}return \{$/.test(l));
    const keys = new Set();
    if (open < 0) return keys;
    for (let i = open + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^ {2}\};/.test(line)) break;
      // `...(cond ? { key } : {})` — a conditional field is still a served key.
      let m = line.match(/^ {4}\.\.\..*\{\s*(\w+)\s*\}/);
      // A plain key ends in `:` or `,` — or nothing at all, which is how the
      // LAST field of the literal is written. Requiring the separator dropped
      // `shapeWarnings` and turned it into a phantom "client declares what the
      // Host never serves" (the parser bug this guard set exists to catch).
      if (!m) m = line.match(/^ {4}(\w+)\s*(?::|,|$)/);
      if (m) keys.add(m[1]);
    }
    return keys;
  }

  /**
   * Top-level fields of the client's `SnapshotData` interface (2-space indent).
   * @param {string} text - `wire.ts` source.
   * @returns {Set<string>} the field names, empty if the interface is absent.
   */
  function clientKeys(text) {
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((l) => /^export interface SnapshotData \{/.test(l));
    const keys = new Set();
    if (at < 0) return keys;
    for (let i = at + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^\}/.test(line)) break;
      const m = line.match(/^ {2}(\w+)\??:/);
      if (m) keys.add(m[1]);
    }
    return keys;
  }

  const host = hostKeys(readSource(join("src", "host", "snapshot-aggregate.ts")));
  const client = clientKeys(readSource(join("src", "client", "wire.ts")));

  // Parser-liveness guard FIRST. If either regex stops matching — a reindent, a
  // renamed function, a reformatted return — the sets shrink and a subset
  // assertion passes for the wrong reason. The anchors are the blocks the panel
  // cannot render without, plus `shapeWarnings` — the LITERAL'S LAST KEY, so a
  // parser that only reads separator-terminated lines is caught too. Without
  // this the gate itself becomes another §39 specimen.
  const ANCHORS = ["ok", "now", "quota", "usage", "llm", "shapeWarnings"];
  const anchored = ANCHORS.every((k) => host.has(k) && client.has(k));
  check("both halves' key parsers are live (snapshot anchors found on each side)",
    anchored, JSON.stringify({ host: [...host], client: [...client] }));

  if (anchored) {
    const missing = [...host].filter((k) => !client.has(k));
    check("every key the Host serves is declared in the client's SnapshotData",
      missing.length === 0, `SnapshotData is missing: ${missing.join(", ") || "(none)"}`);

    const extra = [...client].filter((k) => !host.has(k));
    if (extra.length > 0) {
      console.log(`  note - SnapshotData declares keys the Host never serves: ${extra.join(", ")}`);
    } else {
      console.log(`  note - snapshot key sets match exactly (${host.size} keys)`);
    }
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} contract check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} contract checks passed`);
