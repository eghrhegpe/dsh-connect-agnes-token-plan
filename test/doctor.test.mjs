/**
 * Unit checks for the doctor module (`doctor.ts`) — PEER-FREE, like the other
 * host-side pure readers: it answers "is the provider on or off on this
 * machine" from the plugin's own state files, without a Host running.
 *
 * Covers:
 *   - the three payload parsers (provider / draw / catalog) and their
 *     "corrupt or foreign version reads as unset" direction;
 *   - `diagnose` over a real on-disk layout: the shared (pre-§23) directory,
 *     a profile-scoped directory, and a machine with neither;
 *   - the "a corrupt file is named, not silently dropped" rule;
 *   - `renderReport` lines;
 *   - the machine-level AgnesCode storage survey (drift named, healthy silent,
 *     unknown platform honestly skipped).
 *
 * Nothing here imports a Host peer or opens a socket.
 */
import { mkdtemp, rm, writeFile, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProviderPayload,
  parseDrawPayload,
  parseVideoPayload,
  parseCatalogPayload,
  diagnose,
  renderReport
} from "../src/host/doctor.ts";
import { name as PLUGIN_NAME } from "../src/host/host-config.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

// --- 1. parseProviderPayload ------------------------------------------------
{
  check("a stored true round-trips", parseProviderPayload({ version: 1, enabled: true }).enabled === true);
  check("a stored false round-trips", parseProviderPayload({ version: 1, enabled: false }).enabled === false);
  check("a payload with no enabled key reads as null (fall back to config)",
    parseProviderPayload({ version: 1, updatedAt: "x" }).enabled === null);
  check("a foreign version reads as unset", parseProviderPayload({ version: 99, enabled: true }) === null);
  check("a non-object payload reads as unset",
    parseProviderPayload(null) === null && parseProviderPayload([]) === null && parseProviderPayload("x") === null);
}

// --- 2. parseDrawPayload ----------------------------------------------------
{
  const ok = parseDrawPayload({ version: 1, enabled: true, drawModelId: "Agnes-u1.5-lite" });
  check("draw switch + model round-trip", ok.enabled === true && ok.modelId === "Agnes-u1.5-lite");
  const noModel = parseDrawPayload({ version: 1, enabled: true });
  check("draw with no model preference reads modelId null (auto)",
    noModel.enabled === true && noModel.modelId === null);
  check("draw with a junk model preference reads null",
    parseDrawPayload({ version: 1, enabled: true, drawModelId: 7 }).modelId === null);
  check("a foreign draw version reads as unset", parseDrawPayload({ version: 99 }) === null);
}

// --- 2b. parseVideoPayload --------------------------------------------------
// Same shape as draw, DIFFERENT wire key. The key is the whole point: a parser
// that read `drawModelId` out of a video file would report "auto" for a file
// that plainly pins a model.
{
  const ok = parseVideoPayload({ version: 1, enabled: true, videoModelId: "agnes-video-v2.0" });
  check("video switch + model round-trip", ok.enabled === true && ok.modelId === "agnes-video-v2.0");
  const noModel = parseVideoPayload({ version: 1, enabled: true });
  check("video with no model preference reads modelId null (auto)",
    noModel.enabled === true && noModel.modelId === null);
  check("video with a junk model preference reads null",
    parseVideoPayload({ version: 1, enabled: true, videoModelId: 7 }).modelId === null);
  check("a foreign video version reads as unset", parseVideoPayload({ version: 99 }) === null);
  check("a non-object video payload reads as unset",
    parseVideoPayload(null) === null && parseVideoPayload([]) === null && parseVideoPayload("x") === null);
  // The isolation check, on disk this time: the DRAW key in a video file is not
  // a video preference, and vice versa.
  check("a video file carrying only drawModelId reads as no preference",
    parseVideoPayload({ version: 1, enabled: true, drawModelId: "Agnes-image-2.1-flash" }).modelId === null);
  check("a draw file carrying only videoModelId reads as no preference",
    parseDrawPayload({ version: 1, enabled: true, videoModelId: "agnes-video-v2.0" }).modelId === null);
}

// --- 3. parseCatalogPayload -------------------------------------------------
{
  const ok = parseCatalogPayload({
    version: 1,
    fetchedAt: 1000,
    entries: [{ id: "m1", output_modalities: ["image"] }, { id: "m2" }],
    enabledModelIds: ["m1", "m1", 3, null]
  });
  check("catalog entries normalize + allow-list dedupes junk",
    ok.entries.length === 2 && JSON.stringify(ok.enabledModelIds) === JSON.stringify(["m1"]));
  check("a foreign catalog version reads as unset", parseCatalogPayload({ version: 99, fetchedAt: 1, entries: [] }) === null);
  check("a catalog with no fetchedAt and no entries reads as unset",
    parseCatalogPayload({ version: 1, entries: [] }) === null);
}

// --- 4. diagnose over an on-disk layout -------------------------------------
{
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-"));
  const stateRoot = join(home, "state");
  const sharedDir = join(stateRoot, PLUGIN_NAME);
  const profileDir = join(stateRoot, "web", PLUGIN_NAME);
  await mkdir(sharedDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  // The shared (pre-§23) layout keeps its own values.
  await writeFile(join(sharedDir, "provider.json"), JSON.stringify({ version: 1, enabled: true }));
  await writeFile(join(sharedDir, "draw.json"), JSON.stringify({ version: 1, enabled: true }));
  await writeFile(join(sharedDir, "video.json"), JSON.stringify({ version: 1, enabled: true, videoModelId: "agnes-video-v2.0" }));
  await writeFile(join(sharedDir, "catalog.json"), JSON.stringify({
    version: 1, fetchedAt: 1000,
    entries: [{ id: "a" }, { id: "b", output_modalities: ["image"] }],
    enabledModelIds: []
  }));
  // The profile-scoped layout has its own, DIFFERENT values.
  await writeFile(join(profileDir, "provider.json"), JSON.stringify({ version: 1, enabled: false }));
  await writeFile(join(profileDir, "video.json"), JSON.stringify({ version: 1, enabled: false }));
  await writeFile(join(profileDir, "catalog.json"), JSON.stringify({
    version: 1, fetchedAt: 2000, entries: [{ id: "c" }], enabledModelIds: ["c"]
  }));

  const report = await diagnose({ dshHome: home });
  check("diagnose sees the profile-scoped scope",
    report.scopes.some((s) => s.profile === "web") === true,
    JSON.stringify(report.scopes.map((s) => s.profile)));
  const web = report.scopes.find((s) => s.profile === "web");
  check("the profile scope reads its OWN values, not the shared ones",
    web.providerPanel === false && web.drawPanel === null && web.catalogEntries.length === 1,
    JSON.stringify({ provider: web.providerPanel, draw: web.drawPanel, entries: web.catalogEntries.length }));
  check("the profile scope reads its own allow-list", JSON.stringify(web.catalogEnabledIds) === JSON.stringify(["c"]));
  // The video file is scoped exactly like the others: this profile saved its
  // own switch and no model, so it must NOT inherit the shared scope's model.
  check("the profile scope reads its own video switch, not the shared one",
    web.videoPanel === false && web.videoModelPanel === null,
    JSON.stringify({ panel: web.videoPanel, model: web.videoModelPanel }));

  // A machine that has a profile directory should NOT also report the shared
  // directory as a fake "profile" — the shared layout is only the pre-§23 answer.
  check("the shared dir is not mistaken for a profile when profiles exist",
    report.scopes.every((s) => s.profile !== null),
    JSON.stringify(report.scopes.map((s) => s.profile)));
  check("with profiles present, the shared layout is reported as `shared`, not a scope",
    report.shared === null && report.profiled === true,
    JSON.stringify({ shared: report.shared === null ? "null" : "set", profiled: report.profiled }));

  await rm(home, { recursive: true, force: true });
}

// --- 4b. diagnose over a shared-only (pre-§23) machine ----------------------
{
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-shared-"));
  const stateRoot = join(home, "state");
  const sharedDir = join(stateRoot, PLUGIN_NAME);
  await mkdir(sharedDir, { recursive: true });
  await writeFile(join(sharedDir, "provider.json"), JSON.stringify({ version: 1, enabled: true }));

  const report = await diagnose({ dshHome: home });
  check("a machine with only the shared layout reports it as `shared`",
    report.shared !== null && report.shared.providerPanel === true && report.profiled === false,
    JSON.stringify({ profiled: report.profiled, provider: report.shared?.providerPanel }));
  await rm(home, { recursive: true, force: true });
}

// --- 4c. a corrupt file is named, not silently dropped ----------------------
{
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-corrupt-"));
  const stateRoot = join(home, "state");
  const dir = join(stateRoot, PLUGIN_NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "provider.json"), "this is not json");
  // A second file that parses as JSON but is not THIS plugin's payload (a
  // foreign version): also named, also read as unset.
  await writeFile(join(dir, "video.json"), JSON.stringify({ version: 99, enabled: true }));
  const report = await diagnose({ dshHome: home });
  check("a corrupt provider.json is named in the scope's unreadable list",
    report.shared.unreadable.includes("provider.json"),
    JSON.stringify(report.shared.unreadable));
  check("a foreign-version video.json is named too, not silently dropped",
    report.shared.unreadable.includes("video.json") && report.shared.videoPanel === null,
    JSON.stringify({ unreadable: report.shared.unreadable, panel: report.shared.videoPanel }));
  check("the unreadable file still reads the switch as null (fall back to config)",
    report.shared.providerPanel === null);
  const lines = renderReport(report);
  check("the human report names the unreadable file", lines.includes("provider.json"), lines);
  check("the human report carries the video switch beside the draw one",
    /video=unset/.test(lines), lines);
  await rm(home, { recursive: true, force: true });
}

// --- 4d. a clean machine (no state at all) ----------------------------------
{
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-clean-"));
  const report = await diagnose({ dshHome: home });
  check("a clean machine reports no state and is not profiled",
    report.shared === null && report.scopes.length === 0 && report.profiled === false,
    JSON.stringify({ shared: report.shared, scopes: report.scopes.length, profiled: report.profiled }));
  const lines = renderReport(report);
  check("the human report says so plainly", lines.includes("no state found"), lines);
  await rm(home, { recursive: true, force: true });
}

// --- 5. the desktop AgnesCode storage survey (names only, never decrypts) ---
// The sentinel's offline half:「没装 App」「装了没登录」「登录了但格式变了」
// are three different facts, and the doctor must tell them apart WITHOUT
// reading a single byte of session content.
{
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-home-"));
  const appRootDrift = await mkdtemp(join(tmpdir(), "dsh-doctor-drift-"));
  const appRootOk = await mkdtemp(join(tmpdir(), "dsh-doctor-okapp-"));
  await mkdir(join(appRootDrift, "AgnesCode"), { recursive: true });
  await writeFile(join(appRootDrift, "AgnesCode", "code-auth-session.cn.v2"), "opaque-bytes");
  await mkdir(join(appRootOk, "AgnesCode"), { recursive: true });
  await writeFile(join(appRootOk, "AgnesCode", "code-auth-session.cn.v1"), "opaque-bytes");

  const drift = await diagnose({ dshHome: home, env: { APPDATA: appRootDrift }, platform: "win32" });
  check("the survey names the drifted family member as drift, not as absence",
    drift.agnescode?.presentDirs === 1 && drift.agnescode?.sessionFiles.length === 0
    && drift.agnescode?.driftFiles.join(",") === "code-auth-session.cn.v2",
    JSON.stringify(drift.agnescode));
  check("the human report calls FORMAT DRIFT out by name",
    renderReport(drift).includes("FORMAT DRIFT") && renderReport(drift).includes("code-auth-session.cn.v2"),
    renderReport(drift));

  const healthy = await diagnose({ dshHome: home, env: { APPDATA: appRootOk }, platform: "win32" });
  check("a readable v1 reads as a session file with no drift claim",
    healthy.agnescode?.sessionFiles.join(",") === "code-auth-session.cn.v1"
    && healthy.agnescode?.driftFiles.length === 0,
    JSON.stringify(healthy.agnescode));
  check("the healthy report does not shout about drift",
    renderReport(healthy).includes("FORMAT DRIFT") === false, renderReport(healthy));

  const skipped = await diagnose({ dshHome: home, env: {}, platform: "sunos" });
  check("an unknown platform is reported as skipped, not as zero files",
    skipped.agnescode?.surveyed === false && skipped.agnescode?.dirsChecked === 0);
  check("the human report says the survey was skipped",
    renderReport(skipped).includes("no App layout known for platform sunos"), renderReport(skipped));

  await rm(home, { recursive: true, force: true });
  await rm(appRootDrift, { recursive: true, force: true });
  await rm(appRootOk, { recursive: true, force: true });
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
