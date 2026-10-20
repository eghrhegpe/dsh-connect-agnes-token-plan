// host-range.test.mjs —— peer 范围 × 真实版本宇宙的对齐门禁。
//
// ## 它守什么，不守什么
//
// `package.json` 里那 10 条 `@deepseek-ai/dsh-*` peer 范围是**声明**：宿主用
// `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 拿它
// 决定一个运行时版本能不能装本插件（dsh-app-boot/lib/index.js）。声明错了不会
// 有编译错误、不会有测试红——它只是**安静地接受或拒绝一批版本**。
//
// 本套件把「这条范围在真实发布史上到底放行哪些版本」冻结成 golden 文件，然后
// 每次跑都对一遍。它守的是**对齐**（范围与版本宇宙是否还匹配），不是**行为**
// （插件在那个版本上能不能跑）。后者要真装真启，见
// docs/TESTING.md 的 tier 说明。
//
// ## 为什么红线在 0.1.5 上不可信（这个门禁就是为此写的）
//
// `">=0.1.5 <0.3"` 读起来是「0.1.5 及以上」，实际语义是「**0.1.6-alpha.1** 及
// 以上」：`0.1.5` 是稳定版，预发布排序低于自身。所以 0.1.5 自己的
// alpha/rc 全部被拒——写作者想放行的版本，正是它拒绝的那批。反过来它又
// **主动接收** 0.1.6-alpha.1、0.1.7-alpha.1、0.2.1-alpha.1 这些内测版。
// 两个方向都只有把范围拿去跑一遍真实版本表才看得见。
//
// ## 为什么是 `.test.mjs`（会进 npm test）
//
// 本仓库的 npm test 名册是 test/_roster.mjs 的 readdir 结果，所以本文件自动
// 进默认门禁；它零网络、零安装、只读两个 JSON，干净检出即跑。golden 刷新走
// tools/update-host-range.mjs（唯一联网的地方）。
//
// ## 红了怎么办
//
// 报错会逐个版本点名（例如 `@deepseek-ai/dsh-settings ">=0.1.5 <0.3" now
// REFUSES 0.2.2-rc.1 (was admitted)`）。三种可能：上游发了新版本（→ 跑生成器
// 刷新 golden，然后**用人的判断**看那个新版本该不该被收）；范围被人改了
// （→ 若是有意的，刷新 golden；若是手滑，改回去）；JSON 被手改坏了（→ golden
// 是生成物，别手改）。
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, diffAgainstGolden, explain, hostPeers, partition } from "./host-range.mjs";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const golden = JSON.parse(readFileSync(join(here, "host-range.golden.json"), "utf8"));

// --- 1. golden 的宇宙 = 已发布的全部版本，不是抽样 ------------------------
{
  const universe = golden.universe ?? [];
  check("golden 记录了版本宇宙", Array.isArray(universe) && universe.length > 0, `universe=${universe.length}`);
  check(
    "宇宙的包名是 @deepseek-ai/dsh（宿主判的是运行时版本，不是 peer 包自己的版本）",
    golden.universePackage === "@deepseek-ai/dsh",
    String(golden.universePackage),
  );
  // 注册表返回的是发布序（0.2.1-alpha.1 在 0.2.0-rc.2 之后发布），不是版本序。
  // 生成器排过序，这里复核——没排序的黄金表会让「最新放行版本」算错。
  const ascending = universe.every((v, i) => i === 0 || compareVersions(universe[i - 1], v) < 0);
  check("宇宙按 semver 升序且无重复", ascending, ascending ? "" : "顺序或重复被破坏，重跑生成器");
  // 锚点：每个代际至少一个。全丢说明扫描没够到输入。
  for (const anchor of ["0.1.7-rc.1", "0.2.0-rc.1", "0.2.1-rc.2"]) {
    check(`宇宙里含锚点 ${anchor}`, universe.includes(anchor), "锚点缺失——golden 被截断过？");
  }
}

// --- 2. 每条 peer 范围的判定与记录一致 -----------------------------------
{
  const report = diffAgainstGolden(manifest, golden);
  check(
    "每条 host peer 范围对宇宙的判定与 golden 一致",
    report.length === 0,
    report.length === 0 ? "" : `\n${explain(report)}\n（上游发版或范围改动都会走到这里；确认后用 node tools/update-host-range.mjs 刷新）`,
  );
}

// --- 3. 记录的分区与它自己的范围自洽（防手改 golden） ---------------------
{
  let inconsistent = 0;
  for (const [name, entry] of Object.entries(golden.peers ?? {})) {
    const derived = partition(golden.universe ?? [], entry.range);
    if (JSON.stringify(derived.admitted) !== JSON.stringify(entry.admitted)) inconsistent++;
    if (derived.admitted.length + derived.refused.length !== (golden.universe ?? []).length) inconsistent++;
    void name;
  }
  check(
    "golden 的 admitted 列表与它自己的 range 算出来的结果一致",
    inconsistent === 0,
    inconsistent === 0 ? "" : `${inconsistent} 条 peer 记录不自洽——golden 是生成物，别手改`,
  );
  // 反向：磁盘上的每条 host peer 都必须有记录（否则「新增了 peer 却没人评分」）。
  const recorded = new Set(Object.keys(golden.peers ?? {}));
  const declared = hostPeers(manifest).map(([name]) => name);
  const missing = declared.filter((name) => !recorded.has(name));
  check("磁盘上每条 host peer 都在 golden 里被评过分", missing.length === 0, missing.join(", "));
}

// --- 4. 下界不会被静默上舍 ------------------------------------------------
//
// 稳定版下界（`>=0.1.5`）配预发布宇宙时，写作者以为的「X.Y.Z 及以上」实际是
// 「X.Y.Z 之后的第一个预发布及以上」。这条断言把那个语义差钉出来：稳定版下界
// 不得放行 X.Y.Z 自己的 rc。若哪天真的要「从 0.1.5 起」，正确写法是
// `>=0.1.5-rc.1` 之类——改完这条断言会自动跟随，因为它是从 range 里读的。
{
  const offenders = [];
  for (const [name, entry] of Object.entries(golden.peers ?? {})) {
    const floor = /^>=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(entry.range);
    if (!floor) continue;
    if (floor[1].includes("-")) continue; // 下界自带预发布标签，本检查不适用
    const own = `${floor[1]}-rc.1`;
    if (!(golden.universe ?? []).includes(own)) continue;
    if (entry.admitted.includes(own)) offenders.push(`${name} 放行了 ${own}`);
  }
  check(
    "稳定版下界没有静默放行自己的预发布",
    offenders.length === 0,
    offenders.join("; "),
  );
}

// --- 5. 实际验证过的宿主版本都被放行 -------------------------------------
//
// validatedOn 是「这个插件真的在哪些宿主上跑过」的账本（证据写在生成器里）。
// 它必须既在宇宙里、又被每条 peer 放行——否则等于「我们验证过的版本，自己的
// 声明却拒之门外」。
{
  const validatedOn = golden.validatedOn ?? [];
  check("golden 记录了至少一个已验证宿主版本", validatedOn.length > 0, `validatedOn=${JSON.stringify(validatedOn)}`);
  for (const version of validatedOn) {
    check(`已验证的宿主 ${version} 在宇宙里`, (golden.universe ?? []).includes(version), "版本从注册表消失或 golden 被截断");
    const refusedBy = Object.entries(golden.peers ?? {})
      .filter(([, entry]) => !(entry.admitted ?? []).includes(version))
      .map(([name]) => name);
    check(`已验证的宿主 ${version} 被全部 peer 放行`, refusedBy.length === 0, `被这些 peer 拒绝：${refusedBy.join(", ")}`);
  }
}

// --- 6. 0.x 之外不外泄 ----------------------------------------------------
//
// 上限一律写 `<0.3`（desugar 成 `<0.3.0-0`）。0.3.0 与 1.0.0 必须被拒：跨 minor
// 是 ABI 断裂线，收进来就等于宣称「下一代会跑」而没有一行验证。
{
  const leaked = [];
  for (const probe of ["0.3.0", "1.0.0"]) {
    for (const [name, entry] of Object.entries(golden.peers ?? {})) {
      if ((entry.admitted ?? []).includes(probe)) leaked.push(`${name} 放行了 ${probe}`);
    }
  }
  check("没有 peer 放行 0.3 及以上", leaked.length === 0, leaked.join("; "));
  // 反向的活性证明：宇宙里确实有 0.2.x 被放行，否则「都被拒」会让上一条恒真。
  const anyAdmitted02 = Object.values(golden.peers ?? {}).some((entry) =>
    (entry.admitted ?? []).some((v) => v.startsWith("0.2.")));
  check("有 0.2.x 被放行（上限断言不是恒真）", anyAdmitted02, "没有 0.2.x 被放行——范围塌了或宇宙读空了");
}

// --- 7. 比较器与宿主真正在用的 semver 对拍 -------------------------------
//
// 本仓库自带的比较器（test/host-range.mjs）零依赖，是故意重写的一份。重写就有
// 偏离风险，所以拿宿主那份 semver（dsh 自带的 7.x）对同一批输入逐个比对。找不到
// 宿主副本时 SKIP 而不是 FAIL——干净检出不装任何东西是这个仓库的前提。
function loadHostSemver() {
  const candidates = [];
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (globalRoot) candidates.push(join(globalRoot, "@deepseek-ai", "dsh", "node_modules", "semver"));
  } catch {
    // 没有 npm / 没有全局树：下面还有裸 semver 可试。
  }
  candidates.push("semver");
  const require = createRequire(join(root, "package.json"));
  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      if (loaded && typeof loaded.satisfies === "function") return loaded;
    } catch {
      // 试下一个。
    }
  }
  return null;
}

{
  const semver = loadHostSemver();
  if (semver === null) {
    console.log("SKIP: no semver available (neither the host's copy nor a bare one) — the cross-check did not run");
  } else {
    // 不只比本仓的 range：混进几条已知陷阱形式，防止「比较器只对自己的输入正确」。
    const ranges = [
      ...hostPeers(manifest).map(([, range]) => range),
      "<0.2",
      ">=0.1.5 <0.3",
      ">=0.1.7-rc.1 <0.3.0-0",
      ">=0.2.0-rc.0 <0.3",
    ];
    const universe = golden.universe ?? [];
    let compared = 0;
    const disagreements = [];
    for (const range of ranges) {
      for (const version of universe) {
        const ours = partition([version], range).admitted.length === 1;
        const theirs = semver.satisfies(version, range, { includePrerelease: true });
        compared++;
        if (ours !== theirs) disagreements.push(`${version} × "${range}": 本仓=${ours} 宿主=${theirs}`);
      }
    }
    check(
      `比较器与宿主 semver（${semver.version ?? "?"}）在 ${compared} 组输入上判定一致`,
      disagreements.length === 0,
      disagreements.slice(0, 10).join("\n"),
    );
    // 活性：没比到东西也算红——「一致」不能由零组输入凑出来。
    check("对拍真的比到了输入", compared >= ranges.length * 10, `compared=${compared}`);
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
