/**
 * The four opt-in switch stores, measured against ONE shared behaviour list.
 *
 * Why this file exists: the panel's opt-in switches (provider / draw / video /
 * AgnesCode) are FOUR separate state files that answer the same question —
 * "did the panel ever decide this, and what did it decide?" — with the same
 * integrity discipline (versioned payload, temp+rename atomic write, 0600,
 * "anything unrecognised reads as not set", a short-TTL read cache and the
 * §23 one-shot legacy adoption). They were written by copying each other, so
 * a fix or a rule that reached three of them could be missing from the fourth
 * with nothing noticing. This suite runs the SAME assertions against all four
 * so the four cannot quietly disagree.
 *
 * It was written BEFORE the four were refactored onto one shared factory
 * (the token-store playbook: freeze first, then move) — every assertion here
 * is pinned against the pre-refactor behaviour, including the one that records
 * a known defect (see "legacy adoption" below).
 *
 * Peer-free: no Host peer, no network, no DPAPI. Only `node:fs` and the
 * injected `dir`.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateHostEnv, isolateStateDir } from "./peer-roots.mjs";
import { PROVIDER_VERSION, createFileProviderStore } from "../src/host/provider-store.ts";
import { DRAW_STORE_VERSION, createFileDrawStore } from "../src/host/draw-store.ts";
import { VIDEO_STORE_VERSION, createFileVideoStore } from "../src/host/video-store.ts";
import { AGNESCODE_SWITCH_VERSION, createFileAgnescodeStore } from "../src/host/agnescode-switch-store.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

/**
 * The four switches, and what makes each one different.
 *
 * `modelKey: null` = a plain on/off switch (no model preference); a non-null
 * key is the persisted model-preference field, which the switch and the
 * preference share one file for ("one read, two answers").
 */
const SWITCHES = [
  { key: "provider", file: "provider.json", version: PROVIDER_VERSION, create: createFileProviderStore, modelKey: null },
  { key: "draw", file: "draw.json", version: DRAW_STORE_VERSION, create: createFileDrawStore, modelKey: "drawModelId" },
  { key: "video", file: "video.json", version: VIDEO_STORE_VERSION, create: createFileVideoStore, modelKey: "videoModelId" },
  { key: "agnescode", file: "agnescode-provider.json", version: AGNESCODE_SWITCH_VERSION, create: createFileAgnescodeStore, modelKey: null }
];

/** Read the persisted payload, or `null` when the file is not there. */
function readPayload(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// --- 1. one shared behaviour list, run against all four switches ----------
for (const spec of SWITCHES) {
  const restoreEnv = isolateHostEnv();
  const restoreHome = isolateStateDir();
  const dir = mkdtempSync(join(tmpdir(), `dsh-switch-${spec.key}-`));
  const file = join(dir, spec.file);
  const group = `${spec.key} switch`;
  try {
    const store = spec.create({ dir });

    // ── A. untouched: nothing stored means "not set", never a default ──
    check(`${group}: an untouched switch reads as unset`,
      (await store.enabled()) === null && (await store.isSet()) === false);
    if (spec.modelKey !== null) {
      check(`${group}: an untouched model preference reads as unset`, (await store.modelId()) === null);
    }

    // ── B. save round-trips, and the payload carries the shape version ──
    await store.save(true);
    check(`${group}: save(true) persists a boolean`,
      (await store.enabled()) === true && (await store.isSet()) === true);
    const persisted = readPayload(file);
    check(`${group}: the payload carries the format version`,
      persisted?.version === spec.version && persisted?.enabled === true,
      JSON.stringify(persisted));
    check(`${group}: a fresh store reads the persisted switch`,
      (await spec.create({ dir }).enabled()) === true);

    await store.save(false);
    check(`${group}: save(false) flips the switch`, (await store.enabled()) === false);

    // ── C. save refuses junk instead of persisting a guess ──
    let threw = false;
    try {
      await store.save("yes");
    } catch {
      threw = true;
    }
    check(`${group}: save refuses a non-boolean`, threw);

    // ── D. a damaged or foreign file reads as unset, never as a decision ──
    writeFileSync(file, "{ this is not json", "utf8");
    check(`${group}: a corrupted file reads as unset`,
      (await spec.create({ dir }).enabled()) === null);
    writeFileSync(file, JSON.stringify({ version: 999, enabled: true }), "utf8");
    check(`${group}: a foreign format version reads as unset`,
      (await spec.create({ dir }).enabled()) === null);
    writeFileSync(file, JSON.stringify({ version: spec.version, enabled: "yes" }), "utf8");
    check(`${group}: a non-boolean enabled reads as unset`,
      (await spec.create({ dir }).enabled()) === null);

    // ── E. forget returns the switch to the config default ──
    await store.save(true);
    await store.forget();
    check(`${group}: forget returns to the config default`,
      (await store.enabled()) === null && (await store.isSet()) === false);
    const forgotten = readPayload(file);
    check(`${group}: a forgotten payload keeps its version stamp but no answer`,
      forgotten?.version === spec.version && !("enabled" in forgotten),
      JSON.stringify(forgotten));

    // ── F. the model preference, for the two switches that carry one ──
    if (spec.modelKey !== null) {
      await store.save(true);
      await store.saveModel("agnes-image-2.5-flash");
      check(`${group}: a saved model preference round-trips`,
        (await store.modelId()) === "agnes-image-2.5-flash");
      check(`${group}: saving a model leaves the switch alone`, (await store.enabled()) === true);
      check(`${group}: the preference is persisted under its own key`,
        readPayload(file)?.[spec.modelKey] === "agnes-image-2.5-flash",
        JSON.stringify(readPayload(file)));
      check(`${group}: a fresh store reads the persisted preference`,
        (await spec.create({ dir }).modelId()) === "agnes-image-2.5-flash");

      await store.saveModel(null);
      check(`${group}: saveModel(null) clears the preference`, (await store.modelId()) === null);

      let modelThrew = false;
      try {
        await store.saveModel("   ");
      } catch {
        modelThrew = true;
      }
      check(`${group}: saveModel refuses a blank id`, modelThrew);

      await store.saveModel("agnes-video-2.5");
      await store.forgetModel();
      check(`${group}: forgetModel clears only the preference`,
        (await store.modelId()) === null && (await store.enabled()) === true);

      // A preference that survives a forget(): forgetting the SWITCH is not
      // forgetting "which model I wanted" — the two are separate answers.
      await store.saveModel("agnes-image-2.5-flash");
      await store.forget();
      check(`${group}: forgetting the switch keeps the model preference`,
        (await store.modelId()) === "agnes-image-2.5-flash" && (await store.enabled()) === null);
    }
  } catch (error) {
    fail(group, error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreHome();
    restoreEnv();
  }
}

// --- 2. §23 legacy adoption, on the two shapes that exist ----------------
// Pre-§23 machines kept every switch in ONE shared directory. A profile-scoped
// store adopts that value once, by copy, and the legacy file stays in place
// for an older Host of this plugin.
for (const spec of SWITCHES) {
  const restoreEnv = isolateHostEnv();
  const restoreHome = isolateStateDir();
  const label = `${spec.key} switch adoption`;
  try {
    const home = process.env.DSH_HOME;
    const legacyDir = join(home, "state", "dsh-connect-agnes-token-plan");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, spec.file),
      `${JSON.stringify({ version: spec.version, enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" })}\n`,
      { encoding: "utf8" });

    const adopted = spec.create({ profile: "web" });
    check(`${label}: a profile store adopts the pre-§23 shared value`,
      (await adopted.enabled()) === true, `enabled=${await adopted.enabled()}`);

    const adoptedDir = join(home, "state", "web", "dsh-connect-agnes-token-plan");
    check(`${label}: the adopted value is written under the profile`,
      existsSync(join(adoptedDir, spec.file)), join(adoptedDir, spec.file));
    check(`${label}: the legacy file is left in place for an older Host`,
      existsSync(join(legacyDir, spec.file)));

    // A fresh store reads the adopted file back off disk — the answer a
    // restarted Host will get.
    const reopened = spec.create({ profile: "web" });
    check(`${label}: the adopted value survives a restart`,
      (await reopened.enabled()) === true, `enabled=${await reopened.enabled()}`);

    // An explicit `dir` was never part of the shared layout.
    const explicit = mkdtempSync(join(tmpdir(), `dsh-switch-explicit-${spec.key}-`));
    try {
      check(`${label}: an explicit dir does not adopt`,
        (await spec.create({ dir: explicit, profile: "web" }).enabled()) === null);
    } finally {
      rmSync(explicit, { recursive: true, force: true });
    }
  } catch (error) {
    fail(label, error);
  } finally {
    restoreHome();
    restoreEnv();
  }
}

// --- 3. two profiles never overwrite each other --------------------------
{
  const restoreEnv = isolateHostEnv();
  const restoreHome = isolateStateDir();
  try {
    const home = process.env.DSH_HOME;
    const web = createFileProviderStore({ profile: "web" });
    const desktop = createFileProviderStore({ profile: "desktop" });
    await web.save(true);
    await desktop.save(false);
    check("two profiles keep independent switch values",
      (await createFileProviderStore({ profile: "web" }).enabled()) === true &&
      (await createFileProviderStore({ profile: "desktop" }).enabled()) === false);
    check("a profile switch lands in the profile's own directory",
      existsSync(join(home, "state", "web", "dsh-connect-agnes-token-plan", "provider.json")) &&
      existsSync(join(home, "state", "desktop", "dsh-connect-agnes-token-plan", "provider.json")));
  } catch (error) {
    fail("per-profile switch isolation", error);
  } finally {
    restoreHome();
    restoreEnv();
  }
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
