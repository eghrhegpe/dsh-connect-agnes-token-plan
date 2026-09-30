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
 *   - `renderReport` lines.
 *
 * Nothing here imports a Host peer or opens a socket.
 */
import { mkdtemp, rm, writeFile, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProviderPayload,
  parseDrawPayload,
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
  const ok = parseDrawPayload({ version: 1, enabled: true, drawModelId: "sensenova-u1.5-lite" });
  check("draw switch + model round-trip", ok.enabled === true && ok.modelId === "sensenova-u1.5-lite");
  const noModel = parseDrawPayload({ version: 1, enabled: true });
  check("draw with no model preference reads modelId null (auto)",
    noModel.enabled === true && noModel.modelId === null);
  check("draw with a junk model preference reads null",
    parseDrawPayload({ version: 1, enabled: true, drawModelId: 7 }).modelId === null);
  check("a foreign draw version reads as unset", parseDrawPayload({ version: 99 }) === null);
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
  await writeFile(join(sharedDir, "catalog.json"), JSON.stringify({
    version: 1, fetchedAt: 1000,
    entries: [{ id: "a" }, { id: "b", output_modalities: ["image"] }],
    enabledModelIds: []
  }));
  // The profile-scoped layout has its own, DIFFERENT values.
  await writeFile(join(profileDir, "provider.json"), JSON.stringify({ version: 1, enabled: false }));
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
  const report = await diagnose({ dshHome: home });
  check("a corrupt provider.json is named in the scope's unreadable list",
    report.shared.unreadable.includes("provider.json"),
    JSON.stringify(report.shared.unreadable));
  check("the unreadable file still reads the switch as null (fall back to config)",
    report.shared.providerPanel === null);
  const lines = renderReport(report);
  check("the human report names the unreadable file", lines.includes("provider.json"), lines);
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

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
