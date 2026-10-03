/**
 * `doctor` — the read-only answer to "is the provider on or off on THIS
 * machine" (PITFALLS §22: the effective switch lives in a JSON file that no
 * config file and no Host route ever reported).
 *
 * A plain reader over the plugin's own state files — it imports no Host peer,
 * so it runs on a clean checkout and answers from disk even when no Host is
 * running. It reports EFFECTIVE values ("panel-saved value beats the
 * deployment default"), never secrets.
 *
 * @module dsh-connect-agnes-token-plan/doctor
 */
import { readdir, stat, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { name } from "./host-config.ts";
import { isProfileSegment, dshHome as defaultDshHome } from "./state-store.ts";
import { parseAgnescodePayload } from "./agnescode-switch-store.ts";

/**
 * The switch payload parsers, re-exported from the stores that own the files.
 *
 * A survey that re-implemented these would be a SECOND opinion about what a
 * state file means, and the two opinions drift — which is exactly how the draw
 * and video switches came to adopt their legacy value into the wrong field
 * (see `switch-store.ts`). The doctor reads through the store's own parser, so
 * "the file is not ours" and "the file is ours but empty" mean the same thing
 * to the survey and to the store.
 *
 * The catalog parser belongs to that set for the same reason and was added last:
 * it had its own copy until the store exported `parseCatalogPayload`, and the copies had
 * already drifted into disagreeing about a record with an unusable
 * `fetchedAt` (see the note on `parseCatalogPayload` in `catalog-store.ts`).
 */
import { parseProviderPayload } from "./provider-store.ts";
import { parseDrawPayload } from "./draw-store.ts";
import { parseVideoPayload } from "./video-store.ts";
import { parseCatalogPayload } from "./catalog-store.ts";
import { parseAgnescodeModelsPayload } from "./agnescode-models-store.ts";

export { parseProviderPayload, parseDrawPayload, parseVideoPayload, parseCatalogPayload };
import { surveyAgnescodeStorage } from "./agnescode.ts";
import { ADMISSION_AUDIT_FILE, parseAdmissionAudit } from "./admission-audit.ts";

/** A scope whose state the doctor reported on (a profile name, or "" for shared). */
export interface DoctorScope {
  profile: string | null;
  stateDir: string;
  /** `registerProvider` the panel saved; `null` = fall back to the deployment default. */
  providerPanel: boolean | null;
  /** The saved draw-tool switch; `null` = fall back to the deployment default. */
  drawPanel: boolean | null;
  /** The saved draw-model preference; `null` = auto. */
  drawModelPanel: string | null;
  /** The saved video-tool switch; `null` = fall back to the deployment default. */
  videoPanel: boolean | null;
  /** The saved video-model preference; `null` = auto. */
  videoModelPanel: string | null;
  /** The saved AgnesCode provider switch; `null` = fall back to OFF (opt-in default). */
  agnescodePanel: boolean | null;
  /** Stored catalog entries, `[]` when nothing usable is stored. */
  catalogEntries: object[];
  /** The stored model allow-list; `[]` means "no filter". */
  catalogEnabledIds: string[];
  /** When the catalog was fetched (ms), or 0 when unknown. */
  catalogFetchedAt: number;
  /**
   * The AgnesCode roster curation, `[]` when nothing is curated.
   *
   * Read for the same reason as the allow-list above, and added for the same
   * reason it was missing: the panel writes the file (`saveModels` is its only
   * writer), so "the ticks I made do not reach the picker" is a question this
   * report must be able to answer. It reported nothing for that file before —
   * the gap was invisible rather than fixed.
   */
  agnescodeEnabledIds: string[];
  /** The state file could not be read as this plugin's payload. */
  unreadable: string[];
  /**
   * Whether this scope's state directory accepted a write, probed live.
   *
   * `true` / `false` / `null` (nothing to say — no directory). This is the one
   * answer the doctor cannot get by reading: `catalog-store.ts`'s `persist()`
   * swallows write failures by design, so a failed write leaves the disk behind
   * the memory and the process stops republishing a catalog it thinks it
   * published. Reading the directory would report the OLD catalog honestly and
   * never reveal the newer one that failed to land.
   */
  writable: boolean | null;
}

/** The full doctor report: one entry per state scope, plus the shared layout. */
export interface DoctorReport {
  /** The DSH home the report was read from. */
  dshHome: string;
  /** The plugin state directory name. */
  plugin: string;
  /** One entry per profile found (plus a "" shared entry when the shared layout was used). */
  scopes: DoctorScope[];
  /** The shared (pre-profile-segment) state directory, present when in use. */
  shared: DoctorScope | null;
  /** Whether a profile-scoped layout existed at all (false = pre-§23 shared-only machine). */
  profiled: boolean;
  /**
   * The machine-level read-only survey of the desktop AgnesCode App's session
   * storage (file NAMES only — never bytes, never crypto). `null` only if the
   * survey itself failed to run; an App that is not installed is a real answer,
   * not a skipped one (`presentDirs: 0`).
   */
  agnescode: Awaited<ReturnType<typeof surveyAgnescodeStorage>> | null;
  /**
   * 不带 `Origin` 的写请求审计（次数 / 最后一次时间 / 方法）。`null` = 没发生过
   * 或读不出来——**不是**零次：文件缺席与"零次"在这里是同一个答案，见
   * `parseAdmissionAudit`。
   */
  admission: { count: number; lastAt: number; lastMethod: string } | null;
}

/** Read a state JSON, or `null` when absent / unreadable / not JSON. */
async function readJson(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Can this plugin actually WRITE its state directory right now?
 *
 * Why the doctor asks, rather than reading a record of past failures: the
 * failure this answers for is `catalog-store.ts`'s `persist()`, which
 * deliberately swallows write failures (the in-memory record keeps serving the
 * process — that is load-bearing for a read-only `$DSH_HOME`, see its comment).
 * The consequence is that a failed write leaves the DISK behind the MEMORY, and
 * `snapshot-aggregate.ts` / `routes/models.ts` advance
 * `providerState.signature` anyway. That signature's only job is "equal ⇒ skip
 * publishing", so once a write fails the process can stop republishing a catalog
 * it believes it already published — while disk holds the old one.
 *
 * A doctor that only READ the directory could not see this: it would report the
 * OLD catalog, honestly, and never learn that a newer one failed to land. So
 * this probe writes instead of reading. That also sidesteps the obvious trap —
 * an audit file recording "the last write failed" would itself have to be
 * written by the very operation that is failing.
 *
 * The probe is a real write to a throwaway name (never `catalog.json`), removed
 * immediately. It answers about the DIRECTORY, which is what every state file
 * here shares. `null` = could not determine (the directory does not exist and
 * could not be created, so there is nothing to say about writability — that is
 * "no state here", not "unwritable").
 *
 * @param {string} stateDir - the plugin state directory to probe.
 * @returns {Promise<boolean|null>} writable / not / unknown.
 */
export async function probeStateWritable(stateDir: string) {
  const probeFile = join(stateDir, `.write-probe-${process.pid}-${Date.now()}`);
  let verdict: boolean | null;
  try {
    // NO `mkdir`: this probe must not be able to create the directory it is
    // asking about. `readScope` only runs for directories that already exist, so
    // creating one here would make the probe change the very report it feeds.
    // A missing directory is `null` ("nothing to say"), never `false`.
    await writeFile(probeFile, "probe", { mode: 0o600, flag: "wx" });
    verdict = true;
  } catch {
    // "exists but refuses writes" (the interesting answer) and "does not exist"
    // are told apart by one stat.
    verdict = await stat(stateDir).then(() => false).catch(() => null);
  }
  await rm(probeFile, { force: true }).catch(() => {});
  return verdict;
}

/**
 * Read one state directory into a scope, tolerant of a missing directory.
 * A directory that is absent or unreadable yields an all-empty scope; a file
 * that exists but is not this plugin's payload is named in `unreadable`.
 * @param {string} stateDir - the directory to read.
 * @param {string|null} profile - the profile this scope belongs to ("" = shared).
 * @returns {Promise<DoctorScope>} the populated scope.
 */
async function readScope(stateDir: string, profile: string | null) {
  const scope: DoctorScope = {
    profile: profile === "" ? null : profile,
    stateDir,
    providerPanel: null,
    drawPanel: null,
    drawModelPanel: null,
    videoPanel: null,
    videoModelPanel: null,
    agnescodePanel: null,
    catalogEntries: [],
    catalogEnabledIds: [],
    catalogFetchedAt: 0,
    agnescodeEnabledIds: [],
    writable: null,
    unreadable: []
  };
  // Distinguish "file absent" from "file present but not this plugin's
  // payload": only the latter is named in `unreadable`, so a machine that has
  // never toggled a switch reports nothing, while a corrupt or foreign file
  // is called out by name (the §22 question: "is this file even ours?").
  const present = async (file: string) => {
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  };

  const providerFile = join(stateDir, "provider.json");
  if (await present(providerFile)) {
    const parsed = parseProviderPayload(await readJson(providerFile));
    if (parsed !== null) scope.providerPanel = parsed.enabled;
    else scope.unreadable.push("provider.json");
  }
  const drawFile = join(stateDir, "draw.json");
  if (await present(drawFile)) {
    const parsed = parseDrawPayload(await readJson(drawFile));
    if (parsed !== null) {
      scope.drawPanel = parsed.enabled;
      scope.drawModelPanel = parsed.modelId;
    } else scope.unreadable.push("draw.json");
  }
  const videoFile = join(stateDir, "video.json");
  if (await present(videoFile)) {
    const parsed = parseVideoPayload(await readJson(videoFile));
    if (parsed !== null) {
      scope.videoPanel = parsed.enabled;
      scope.videoModelPanel = parsed.modelId;
    } else scope.unreadable.push("video.json");
  }
  // The remaining upstream switch is a plain {version, enabled} payload (no
  // model preference) — same unreadable discipline as the files above.
  const agnescodeFile = join(stateDir, "agnescode-provider.json");
  if (await present(agnescodeFile)) {
    const parsed = parseAgnescodePayload(await readJson(agnescodeFile));
    if (parsed !== null) scope.agnescodePanel = parsed.enabled;
    else scope.unreadable.push("agnescode-provider.json");
  }
  const catalogFile = join(stateDir, "catalog.json");
  if (await present(catalogFile)) {
    const parsed = parseCatalogPayload(await readJson(catalogFile));
    if (parsed !== null) {
      scope.catalogEntries = parsed.entries;
      scope.catalogEnabledIds = parsed.enabledModelIds;
      scope.catalogFetchedAt = parsed.fetchedAt;
    } else scope.unreadable.push("catalog.json");
  }
  // The AgnesCode roster curation, through its own store's parser like every
  // other file above — the sixth state file, and the one this survey skipped
  // until now.
  const agnescodeModelsFile = join(stateDir, "agnescode-models.json");
  if (await present(agnescodeModelsFile)) {
    const parsed = parseAgnescodeModelsPayload(await readJson(agnescodeModelsFile));
    if (parsed !== null) scope.agnescodeEnabledIds = parsed.enabledModelIds;
    else scope.unreadable.push("agnescode-models.json");
  }
  // Asked LAST, and after every read above: a probe that creates the directory
  // would otherwise turn "no state here" into "state here" for this very report.
  scope.writable = await probeStateWritable(stateDir);
  return scope;
}

/** List the profile-segment names under a `$DSH_HOME/state` directory. */
async function listProfiles(stateRoot: string) {
  try {
    const entries = await readdir(stateRoot);
    const profiles: string[] = [];
    for (const entry of entries) {
      // The shared (pre-§23) layout lives at `state/<plugin>/`; that directory
      // is a PLUGIN, not a profile, so it must not be read back as one.
      if (entry === name) continue;
      if (!isProfileSegment(entry)) continue;
      const abs = join(stateRoot, entry);
      if ((await stat(abs)).isDirectory()) profiles.push(entry);
    }
    return profiles;
  } catch {
    return [];
  }
}

/**
 * Diagnose one DSH home: read every profile's state directory plus the shared
 * layout, and answer which switch / model list is in effect from disk.
 * A directory that does not exist answers as "no state here" (null scope),
 * so a clean machine is distinguished from a machine with an all-empty one.
 * @param {object} [options]
 * @param {string} [options.dshHome] - the DSH home to read; defaults to `~/.dsh` (or `$DSH_HOME`).
 * @param {any} [options.env] - env for the AgnesCode storage survey (defaults to `process.env`).
 * @param {string} [options.platform] - platform for the survey (defaults to real).
 * @returns {Promise<DoctorReport>}
 */
export async function diagnose(options: { dshHome?: string; env?: any; platform?: string } = {}) {
  const home = typeof options.dshHome === "string" && options.dshHome !== "" ? options.dshHome : defaultDshHome();
  const stateRoot = join(home, "state");
  const sharedDir = join(stateRoot, name);
  const profiles = await listProfiles(stateRoot);
  const dirExists = async (dir: string) => {
    try {
      return (await stat(dir)).isDirectory();
    } catch {
      return false;
    }
  };
  const sharedScope = profiles.length === 0 && (await dirExists(sharedDir)) ? await readScope(sharedDir, "") : null;
  const profileScopes = await Promise.all(profiles.map((profile) => readScope(join(stateRoot, profile, name), profile)));
  // The desktop App survey is machine-level and read-only — a survey that
  // cannot run must never take the rest of the doctor down with it.
  let agnescode: DoctorReport["agnescode"] = null;
  try {
    agnescode = await surveyAgnescodeStorage({ env: options.env, platform: options.platform });
  } catch {
    agnescode = null;
  }
  // 审计是共享目录里的一个文件（`throttle` 同款，不按 profile 分段），且与
  // AgnesCode 盘点同理：读不出来不能把整份报告带走。
  let admission: DoctorReport["admission"] = null;
  try {
    admission = parseAdmissionAudit(await readJson(join(sharedDir, ADMISSION_AUDIT_FILE)));
  } catch {
    admission = null;
  }
  return {
    dshHome: home,
    plugin: name,
    scopes: profileScopes,
    shared: sharedScope,
    profiled: profiles.length > 0,
    agnescode,
    admission
  };
}

/** Render a report as human-readable lines (the non-`--json` doctor output). */
export function renderReport(report: any) {
  const lines = [`dshHome: ${report.dshHome}`];
  // 审计行紧跟 dshHome：它回答的是"这台机器上有没有人打过无 Origin 的写"，
  // 比任何单个 profile 的开关都更靠前——尤其 `/agnescode`（一次 POST 就会触发
  // 本机解密 + 凭据落库 + provider 注册）。零次与"读不出来"都要如实说。
  const admission = report.admission;
  if (admission !== null && admission !== undefined) {
    const when = admission.lastAt > 0 ? new Date(admission.lastAt).toISOString() : "unknown time";
    lines.push(
      `admission: ${String(admission.count)} state-changing request(s) admitted with no Origin`
        + ` (last: ${admission.lastMethod} @ ${when})`
        + " — 浏览器跨站 POST 必带 Origin 且已被闸拦，这类只能是非浏览器客户端；"
        + "若有意外值，查 /agnescode 与 /account 的调用方"
    );
  }
  // The desktop App fact reads FIRST — the question it answers ("is the App
  // even here, in a shape we can read?") precedes any per-profile switch.
  const agnes = report.agnescode;
  if (agnes !== null && agnes !== undefined) {
    lines.push(agnes.surveyed === false
      ? `agnescode storage: no App layout known for platform ${String(agnes.platform)} (survey skipped)`
      : `agnescode storage: app dirs ${String(agnes.presentDirs)}/${String(agnes.dirsChecked)}, session files=${String(agnes.sessionFiles.length)}`
        + (agnes.driftFiles.length > 0
          ? ` — FORMAT DRIFT: unrecognized family files: ${agnes.driftFiles.slice(0, 3).join(", ")} (the App changed its storage format; update this plugin)`
          : ""));
  }
  const scopes = report.shared !== null ? [report.shared, ...report.scopes] : report.scopes;
  if (scopes.length === 0) {
    lines.push(`no state found under ${join(report.dshHome, "state", report.plugin)} (a clean machine, or one that has never toggled a switch)`);
    return lines.join("\n");
  }
  for (const scope of scopes) {
    const label = scope.profile === null ? "shared" : scope.profile;
    const provider = scope.providerPanel === null ? "unset (deployment default rules)" : String(scope.providerPanel);
    const draw = scope.drawPanel === null ? "unset (deployment default rules)" : String(scope.drawPanel);
    const modelPart = scope.drawModelPanel !== null ? ` model=${scope.drawModelPanel}` : "";
    const video = scope.videoPanel === null ? "unset (deployment default rules)" : String(scope.videoPanel);
    const videoModelPart = scope.videoModelPanel !== null ? ` model=${scope.videoModelPanel}` : "";
    const enabledPart = scope.catalogEnabledIds.length === 0 ? "(no filter)" : String(scope.catalogEnabledIds.length);
    // Same wording for the AgnesCode roster: an empty curation is "push
    // everything", NOT "nothing selected" — reporting it as 0 would train the
    // reader to expect a filter that is deliberately off by default.
    // Read through `?.` / `?? []` so a scope literal assembled by a caller (or
    // an older report shape) renders as "(no filter)" instead of throwing: a
    // diagnostic must not be the thing that breaks.
    const agnescodeModels = scope.agnescodeEnabledIds ?? [];
    const agnescodeModelsPart = agnescodeModels.length === 0 ? "(no filter)" : String(agnescodeModels.length);
    const agnescode = scope.agnescodePanel === null ? "unset (off)" : String(scope.agnescodePanel);
    lines.push(
      `${label}: provider=${provider} draw=${draw}${modelPart} video=${video}${videoModelPart} agnescode=${agnescode} catalog=${scope.catalogEntries.length} enabled=${enabledPart} agnescode-models=${agnescodeModelsPart}`
    );
    if (scope.unreadable.length > 0) lines.push(`${label}: unreadable state: ${scope.unreadable.join(", ")}`);
    // Only the failure is worth a line. `true` is the ordinary case and `null`
    // ("no directory to ask about") has nothing to report — printing either
    // would train the reader to skip this line, which is exactly how a
    // diagnostic stops working. What it must never do is stay SILENT while the
    // disk is behind the memory (`persist()` swallows the write and the
    // signature is already advanced), because then the panel shows a catalog
    // that will not survive a restart and nothing anywhere says so.
    if (scope.writable === false) {
      lines.push(
        `${label}: STATE DIRECTORY IS NOT WRITABLE — writes are being swallowed`
          + " (catalog-store.persist() keeps the in-memory record, so the panel can show a"
          + " catalog that will NOT survive a restart, and publish de-duplication may have"
          + " stopped republishing it); fix permissions on this directory"
      );
    }
  }
  return lines.join("\n");
}

/** `--json` entry: print a stable report object. */
export async function main(argv = process.argv.slice(2)) {
  const report = await diagnose();
  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report));
  return report;
}
