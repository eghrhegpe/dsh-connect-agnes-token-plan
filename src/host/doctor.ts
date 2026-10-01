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
import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { name } from "./host-config.ts";
import { isProfileSegment, dshHome as defaultDshHome } from "./state-store.ts";
import { CATALOG_VERSION, normalizeEntries, normalizeEnabledIds } from "./catalog-store.ts";
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
 */
import { parseProviderPayload } from "./provider-store.ts";
import { parseDrawPayload } from "./draw-store.ts";
import { parseVideoPayload } from "./video-store.ts";

export { parseProviderPayload, parseDrawPayload, parseVideoPayload };
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
  /** The state file could not be read as this plugin's payload. */
  unreadable: string[];
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

/** Parse one stored catalog record, or `null` when absent / corrupt / foreign version. */
export function parseCatalogPayload(raw: Record<string, unknown> | null) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  if (typeof source.version !== "number" || source.version !== CATALOG_VERSION) return null;
  const fetchedAt = typeof source.fetchedAt === "number" && source.fetchedAt > 0 ? source.fetchedAt : 0;
  const entries = normalizeEntries(source.entries);
  const enabledModelIds = normalizeEnabledIds(source.enabledModelIds);
  if (fetchedAt <= 0 && entries.length === 0) return null;
  return { fetchedAt, entries, enabledModelIds };
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
    const agnescode = scope.agnescodePanel === null ? "unset (off)" : String(scope.agnescodePanel);
    lines.push(
      `${label}: provider=${provider} draw=${draw}${modelPart} video=${video}${videoModelPart} agnescode=${agnescode} catalog=${scope.catalogEntries.length} enabled=${enabledPart}`
    );
    if (scope.unreadable.length > 0) lines.push(`${label}: unreadable state: ${scope.unreadable.join(", ")}`);
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
