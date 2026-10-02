/**
 * 平台假设护栏 —— 「本机绿、CI 红」的那一类（PITFALLS §41）。
 *
 * 为什么有这个套件：§41 记录的是**一条护栏自己的存活守卫**因平台假设而失效——
 * `relative()` 的分隔符随平台变（Windows `\`、Linux `/`），而它硬切 `"\\"`，
 * 于是 Linux 上判红、Windows 上判绿，而**两种颜色测的都不是它以为在测的东西**。
 *
 * §32 与 §41 是同一条教训的两次发作，载体不同：
 *   - §32：检查的**对象**（环境缺件、文件系统大小写）
 *   - §41：检查的**代码自己**（路径分隔符 = 同一路径的不同书写形式）
 *
 * 本套件把 §41 的可复用准则钉成可执行物：
 *
 *   > 凡断言涉及「平台如何书写一个路径 / 定义一个环境」，
 *   > 就不能以本机绿为准，必须复现目标平台的输入。
 *
 * 具体钉两条**确定性**规则（不依赖运行平台，因此本机与 CI 结果必然一致）：
 *   A. 裸反斜杠 split：`.split("\\")` 在 Linux 上切不开，是恒定的陷阱写法。
 *      合法写法是 `.split(/[\\/]/)` 或经 `path.sep` 派生的等价物。
 *   B. 存活守卫：扫描器若因正则失配/扫描面为空而"零命中通过"，
 *      必须由**内置探针**当场喊出来——见下方 D 段的自我检验。
 *
 * 本套件自身**用跨平台写法实现**（同一个病的免疫），并在 D 段对"扫描器能看见
 * 它该看见的东西"做一次当场验证：往一段内存字符串上跑同一个正则，
 * 确认它能命中一个**故意构造的**坏样例。若命中不了，本套件自己红——
 * 这是 §39「守护物失效时谁会喊」的落实。
 *
 * 纯离线、peer-free：文本扫描，不 import 任何运行时模块。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok" : "  fail"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** 跨平台归一化：任何拿 relative()/join() 结果做比对的地方都必须走这里。 */
const toPosix = (p) => p.split(/[\\/]/).join("/");

// ── 规则 A：裸反斜杠 split ────────────────────────────────────────────────
//
// 匹配 `.split("\\")` / `.split('\\')`——即「按单个反斜杠切分」。
// 这是 §41 的原始形状：在 Windows 上恰好能切、在 Linux 上完全不切。
// 注意**不**匹配 `.split(/[\\/]/)`（合法的跨平台写法），也不匹配
// `.split("\\n")` 这类转义序列（那是别的意思，见下方排除）。
const BARE_BACKSLASH_SPLIT = /\.split\(\s*(["'])\\{1,2}\1\s*\)/;

/** 扫描面：本仓全部源码与测试（跳过外部容器与产物）。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "upstream", "lib", "dist", "AGNES-API-docs", "tmp"]);
const SCAN_EXT = /\.(mjs|ts|js|tsx|jsx)$/;

function collect(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (SCAN_EXT.test(name)) out.push(p);
  }
  return out;
}

const files = collect(ROOT).sort();

/** 剔除行内与整行注释后再匹配——注释里举反例是正当的，不该判红。 */
const stripComment = (line) => line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");

const offenders = [];
for (const file of files) {
  const rel = toPosix(relative(ROOT, file));
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = stripComment(line);
    if (!BARE_BACKSLASH_SPLIT.test(code)) return;
    offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
  });
}

check(
  "源码与测试里没有裸反斜杠 split（平台假设）",
  offenders.length === 0,
  offenders.length
    ? `命中 ${offenders.length} 处，应改为 .split(/[\\\\/]/)：\n      ${offenders.join("\n      ")}`
    : `${files.length} 个文件零命中`
);

// ── 规则 B（**故意不设**）：为什么不用 `path.sep` 做切分也判红 ────────────
//
// 第一版曾把「拿 `path.sep` 切分」也列为违规，它当场误伤了 `docs.test.mjs`
// 的两处 `rel.split(sep)`。复核后确认那两处是**正确的**：`relative()` 产出的
// 分隔符就是本平台的 `sep`，两者必然一致，在任何平台都能切开——它不是平台
// 假设，它就是平台本身。
//
// 这条误伤值得留成记录，因为它是「过度护栏」的典型形状：规则抓的是
// **看起来像坏写法**（涉及分隔符），而不是**真的会坏**（依赖某个平台的具体值）。
// 本仓反复强调护栏必须零误伤（§39 的「护栏自己也同样会得」），一条会误伤的
// 规则最终只有两种下场：被人绕着走，或者被人删掉——两种都让防线消失。
// 所以本套件只保留**确定性**规则：`split("\\")` 在非 Windows 上恒定切不开，
// 这是事实层面的坏；而 `split(sep)` 在任何平台上都正确。

// ── C. 本套件自身的写法审计（自指检查） ───────────────────────────────────
// 本文件若自己用了裸反斜杠 split，就该自我举报——用 §41 的准则检查 §41 的守卫。
{
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const selfLines = selfText.split(/\r?\n/);
  const selfBad = selfLines.filter((line) => BARE_BACKSLASH_SPLIT.test(stripComment(line)));
  check(
    "本套件自身不用裸反斜杠 split（自指）",
    selfBad.length === 0,
    selfBad.length ? `自己在用：${selfBad.join(" | ")}` : "自指干净"
  );
}

// ── D. 存活守卫：证明扫描器能看见它该看见的东西（PITFALLS §39） ───────────
//
// 致命情形不是"有命中"，而是"扫描器坏了、于是永远零命中"。
// 这里用一个**内存里的坏样例**当场验证正则的判别力：
// 它必须命中坏样例、且必须放过合法写法。任一不满足 → 本套件红。
{
  // 样本**在运行时拼出**，源码里不出现坏形状的完整字面量——这样主扫描与自指
  // 检查都不必为"造样本"开豁免口子（豁免口子本身就是一条会被滥用的后门）。
  const BS = String.fromCharCode(92);                          // 一个反斜杠
  const BAD = ".split(" + '"' + BS + BS + '"' + ")";           // 坏形状：按反斜杠切分
  const GOOD_ALT = ".split(/[" + BS + BS + "/]/)";             // 好形状：两种分隔符都认

  const detectsBad = BARE_BACKSLASH_SPLIT.test(BAD);
  const passesGood = !BARE_BACKSLASH_SPLIT.test(GOOD_ALT);
  check("存活守卫：正则能命中坏样例", detectsBad, `样例 ${BAD} → ${detectsBad}`);
  check("存活守卫：正则放过跨平台写法", passesGood, `样例 ${GOOD_ALT} → 未命中`);

  check("扫描面非空（护栏自身存活）", files.length > 20, `扫到 ${files.length} 个文件`);
  check(
    "递归覆盖子目录（src/ 与 test/ 都在扫描面内）",
    (() => {
      const tops = new Set(files.map((f) => toPosix(relative(ROOT, f)).split("/")[0]));
      return tops.has("src") && tops.has("test");
    })(),
    `顶层项：${[...new Set(files.map((f) => toPosix(relative(ROOT, f)).split("/")[0]))].sort().join(", ")}`
  );
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
