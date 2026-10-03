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
import { mkdtemp, rm, writeFile, mkdir, copyFile, chmod, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProviderPayload,
  parseDrawPayload,
  parseVideoPayload,
  parseCatalogPayload,
  probeStateWritable,
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
  // The store's `fetchedAt` gate is a WHOLE-record verdict, not a per-field
  // default: `catalog-store.parse` returns null the moment the stamp is unusable,
  // so the next snapshot re-fetches. Before this re-export the doctor's copy
  // only fell back to 0 and then asked "is the entry list empty?", which let it
  // call a file the store had rejected ("there is no usable catalog here") a
  // healthy one ("1 model") — a report that names a catalogue the panel will
  // never use. One parser, one answer.
  check("a catalog the store rejects (fetchedAt<=0) is rejected here too, even with entries",
    parseCatalogPayload({ version: 1, fetchedAt: 0, entries: [{ id: "m1" }] }) === null,
    JSON.stringify(parseCatalogPayload({ version: 1, fetchedAt: 0, entries: [{ id: "m1" }] })));
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
  // The AgnesCode roster curation — the sixth state file. It was the one the
  // survey did not read, so this file used to be invisible to the report even
  // though the panel writes it and the picker obeys it.
  await writeFile(join(sharedDir, "agnescode-models.json"), JSON.stringify({
    version: 1, enabledModelIds: ["agnes-3.0-flash"]
  }));
  await writeFile(join(profileDir, "agnescode-models.json"), JSON.stringify({
    version: 1, enabledModelIds: []
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
  // The AgnesCode curation is scoped like everything else. This profile's own
  // file curates nothing, so it must NOT inherit the shared copy's one model —
  // and "nothing curated" is the load-bearing default ("push everything"), not
  // "nothing available". (The shared scope is not reported while profiles exist;
  // the per-profile layout is what this assertion is about.)
  check("the AgnesCode roster curation is read and stays per-profile",
    JSON.stringify(web.agnescodeEnabledIds) === JSON.stringify([]),
    JSON.stringify({ web: web.agnescodeEnabledIds, shared: report.shared && report.shared.agnescodeEnabledIds }));
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
  await writeFile(join(sharedDir, "agnescode-models.json"), JSON.stringify({
    version: 1, enabledModelIds: ["agnes-3.0-flash", "agnes-3.0-flash", 7]
  }));

  const report = await diagnose({ dshHome: home });
  check("a machine with only the shared layout reports it as `shared`",
    report.shared !== null && report.shared.providerPanel === true && report.profiled === false,
    JSON.stringify({ profiled: report.profiled, provider: report.shared?.providerPanel }));
  // The shared scope reads the shared roster file, with the same normalization
  // (dedupe / junk dropped) the store applies — the report must not answer a
  // different question about the same bytes.
  check("the shared scope reads and normalizes the AgnesCode roster curation",
    JSON.stringify(report.shared?.agnescodeEnabledIds) === JSON.stringify(["agnes-3.0-flash"]),
    JSON.stringify(report.shared?.agnescodeEnabledIds));
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
  // And the file that used to be skipped entirely: a foreign version here
  // must be NAMED, not merely unread — the point of the list is that no state
  // file this plugin owns can fail silently now that the survey reads all six.
  await writeFile(join(dir, "agnescode-models.json"), JSON.stringify({ version: 99, enabledModelIds: ["x"] }));
  const report = await diagnose({ dshHome: home });
  check("a corrupt provider.json is named in the scope's unreadable list",
    report.shared.unreadable.includes("provider.json"),
    JSON.stringify(report.shared.unreadable));
  check("a foreign-version video.json is named too, not silently dropped",
    report.shared.unreadable.includes("video.json") && report.shared.videoPanel === null,
    JSON.stringify({ unreadable: report.shared.unreadable, panel: report.shared.videoPanel }));
  check("the unreadable file still reads the switch as null (fall back to config)",
    report.shared.providerPanel === null);
  check("a foreign-version agnescode-models.json is named like the others",
    report.shared.unreadable.includes("agnescode-models.json"),
    JSON.stringify(report.shared.unreadable));
  const lines = renderReport(report);
  check("the human report names the unreadable file", lines.includes("provider.json"), lines);
  check("the human report quotes the AgnesCode roster curation",
    /agnescode-models=\(no filter\)/.test(lines), lines);
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

// --- 9. the state-directory writability probe --------------------------------
//
// PITFALLS §40's visibility half. `catalog-store.ts`'s `persist()` swallows
// write failures BY DESIGN (the in-memory record keeps serving the process), so
// a failed write leaves the DISK behind the MEMORY while the publish signature
// is already advanced — the process stops republishing a catalog it believes it
// published. A doctor that only READ could never see this: it would report the
// old catalog, honestly, and never learn a newer one failed to land.
//
// So the doctor WRITES. That also dodges the obvious trap — an audit file
// recording "the last write failed" would have to be written by the very
// operation that is failing.
{
  const stateDir = await mkdtemp(join(tmpdir(), "dsh-doctor-writable-"));

  check("a writable directory answers true",
    (await probeStateWritable(stateDir)) === true);

  // The probe must not be able to CREATE the directory it is asking about: it
  // runs from `readScope`, which only runs for directories that already exist,
  // so creating one here would let the probe change the report it feeds.
  const missing = join(stateDir, "not-created-not-ever");
  check("a missing directory answers null (not false)",
    (await probeStateWritable(missing)) === null);
  check("the probe did not create the directory it was asking about",
    (await stat(missing).then(() => true).catch(() => false)) === false);

  // Nothing left behind — a diagnostic that litters is a diagnostic that gets
  // turned off.
  check("the probe leaves no file behind",
    (await readdir(stateDir)).filter((n) => n.startsWith(".write-probe-")).length === 0);

  // On POSIX a read-only directory is the real failure this exists for. On
  // Windows `chmod` barely restricts directories, so the assertion is skipped
  // there rather than faked — and CI (Linux) is where it actually runs.
  if (process.platform !== "win32") {
    await chmod(stateDir, 0o555);
    check("a read-only directory answers false",
      (await probeStateWritable(stateDir)) === false);
    await chmod(stateDir, 0o755);
  }

  // …and the line the reader actually sees. Only the failure is worth a line:
  // `true` is ordinary and `null` has nothing to say. Printing either would
  // train the reader to skip this line, which is how a diagnostic stops working.
  const quiet = { shared: null, scopes: [{ profile: null, stateDir, writable: true, unreadable: [],
    providerPanel: null, drawPanel: null, drawModelPanel: null, videoPanel: null, videoModelPanel: null,
    agnescodePanel: null, catalogEntries: [], catalogEnabledIds: [], catalogFetchedAt: 0 }],
    dshHome: "/tmp/x", plugin: PLUGIN_NAME, profiled: false, agnescode: null, admission: null };
  check("a writable scope says nothing",
    renderReport(quiet).includes("NOT WRITABLE") === false, renderReport(quiet));

  const broken = { ...quiet, scopes: [{ ...quiet.scopes[0], writable: false }] };
  const rendered = renderReport(broken);
  check("an unwritable scope is named loudly", rendered.includes("STATE DIRECTORY IS NOT WRITABLE"), rendered);
  // The line has to say what the reader LOSES, or "not writable" reads like a
  // permissions nit rather than "your panel is showing a catalog that will not
  // survive a restart".
  check("…and says what it costs the reader",
    rendered.includes("will NOT survive a restart"), rendered);

  const unknown = { ...quiet, scopes: [{ ...quiet.scopes[0], writable: null }] };
  check("an unknown answer is not reported as a failure",
    renderReport(unknown).includes("NOT WRITABLE") === false, renderReport(unknown));

  await rm(stateDir, { recursive: true, force: true });
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
