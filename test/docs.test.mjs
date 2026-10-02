// docs.test.mjs —— 文档与引用一致性钉子（纯文件读取：无网络、无 peer 依赖、干净检出即可跑）
//
// 守住五类「一致性纪律」：
//   文档结构（1-6）：内部链接可解析、跨文件表格去重、README 行数上限、
//                    DSH-PLUGIN.md 教学快照同步、API.md 快照契约、docs/ 孤儿文件
//   事实引用（N=条目数本身、8）：PITFALLS 条数引用有效、src/ 注释里的模块名引用完整（含伪文件名扫描）
//   自述面与实际一致（9-11）：README 覆盖每个 tab、声明的 UI 位置与 client 槽位注册一致、
//                    screenshots.json 声明的图真实存在于磁盘。这三条与 1-8 有本质区别：
//                    前两组验的是「文档格式对不对」，它们验的是「文档有没有说实话」——
//                    形式全绿而语义已漂，是本仓库踩过两次的坑（见 PITFALLS §25）。
//   考古纪律（12）：现行文档不许盖「修订（日期）」式内联补丁——决策沿革只登记在
//                    docs/ADR.md 账本（规则本体见该文件「使用规则」）
//   peer 边界（13）：静态 `@deepseek-ai/*` import 只许 llm adapter 层——「内核 peer-free
//                    才能缺席降级」这条自述承诺的静态面（与 9-11 同族：验的是文档说的
//                    架构纪律在代码里真的成立，不是格式）
//   活文档计数护栏（14）：现行文档不得写死会随代码漂移的模块数/规模/行数（历史·账本·研究档豁免）
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, extname, resolve, relative, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];
const note = (m) => console.log(`  ok - ${m}`);
const bad = (m) => fails.push(m);

/**
 * Case-SENSITIVE existence, segment by segment.
 *
 * `existsSync` is case-insensitive on Windows and macOS, so a reference written
 * `Agnes-auth.ts` resolved to the real `agnes-auth.ts` on the developer's
 * machine and both the link check and the reference check stayed green — while
 * CI (Linux) reported five broken references the moment the offline chain got
 * far enough to run this suite at all (docs/PITFALLS.md §32). Every segment is
 * therefore matched against the directory's REAL entries.
 * @param {string} path - absolute path to test.
 * @returns {boolean} whether every segment exists with that exact case.
 */
function existsExact(path) {
  const rel = relative(ROOT, path);
  if (rel.startsWith("..")) return existsSync(path);
  let current = ROOT;
  for (const segment of rel.split(sep)) {
    if (segment === "" || segment === ".") continue;
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return false;
    }
    if (!entries.includes(segment)) return false;
    current = join(current, segment);
  }
  return true;
}

/** 官方文档一手信源目录（逐字抓取，只读）——不参与断链/去重检查。 */
const OFFICIAL_DOCS_DIR = "AGNES-API-docs";

function collectMd(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "upstream" || name === ".git" || name === "node_modules" || name === OFFICIAL_DOCS_DIR) continue;
    if (statSync(p).isDirectory()) out.push(...collectMd(p));
    else if (extname(p) === ".md") out.push(p);
  }
  return out;
}

const mdFiles = collectMd(ROOT).sort();
console.log(`docs.test.mjs —— 检查 ${mdFiles.length} 个 markdown 文件`);

// 1) 内部链接全部可解析
{
  let checked = 0;
  for (const f of mdFiles) {
    const text = readFileSync(f, "utf8");
    const re = /\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].trim();
      if (/^(https?:|#)/.test(raw)) continue;
      const pathPart = raw.split("#")[0];
      if (!pathPart) continue;
      checked++;
      if (!existsExact(resolve(dirname(f), pathPart))) bad(`断链：${f} -> ${raw}`);
    }
  }
  note(`内部链接 ${checked} 条全部可解析`);
}

// 2) 跨文件重复表格
{
  const seen = new Map(); // norm -> Set(file)
  for (const f of mdFiles) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    let cur = [];
    const flush = () => {
      if (cur.length >= 3) {
        const norm = cur.map((l) => l.replace(/\s+/g, "").replace(/[|`]/g, "")).join("\n");
        if (norm.length > 40) {
          const set = seen.get(norm) ?? new Set();
          set.add(f);
          seen.set(norm, set);
        }
      }
      cur = [];
    };
    for (const line of lines) {
      if (line.trim().startsWith("|")) cur.push(line.trim());
      else flush();
    }
    flush();
  }
  let dups = 0;
  for (const [norm, files] of seen) {
    if (files.size > 1) {
      dups++;
      bad(`表格「${norm.slice(0, 50)}…」重复出现在 ${files.size} 个文件：${[...files].join(", ")}（同一事实只允许一个出处）`);
    }
  }
  note(`表格去重：${seen.size} 张唯一表格，${dups} 张跨文件重复`);
}

// 3) 根 README 行数上限
{
  const lines = readFileSync(join(ROOT, "README.md"), "utf8").split(/\r?\n/).length;
  const cap = 140;
  if (lines > cap) bad(`README.md 共 ${lines} 行，超过上限 ${cap}：根 README 只做索引与快速上手，细节下沉 docs/`);
  else note(`README.md ${lines} 行（上限 ${cap}）`);
}

// 4) DSH-PLUGIN.md 教学快照 ↔ package.json
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const doc = readFileSync(join(ROOT, "docs", "DSH-PLUGIN.md"), "utf8");
  const block = doc.match(/```jsonc\n([\s\S]*?)```/);
  if (!block) bad("docs/DSH-PLUGIN.md 找不到 jsonc 教学快照块");
  else {
    const snip = block[1];
    for (const key of ["name", "version", "main"]) {
      const m = snip.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
      if (!m) bad(`教学快照缺字段 "${key}"`);
      else if (m[1] !== String(pkg[key])) bad(`教学快照 "${key}" = ${m[1]}，真实 package.json = ${pkg[key]}（快照需同步）`);
    }
    const fm = snip.match(/"files"\s*:\s*\[([\s\S]*?)\]/);
    if (!fm) bad("教学快照缺 files 数组");
    else {
      const snipFiles = [...fm[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      const extra = snipFiles.filter((f) => !pkg.files.includes(f));
      const missing = pkg.files.filter((f) => !snipFiles.includes(f));
      if (extra.length) bad(`教学快照 files 多出：${extra.join(", ")}`);
      if (missing.length) bad(`教学快照 files 缺：${missing.join(", ")}`);
      if (!extra.length && !missing.length) note(`教学快照 files 与 package.json 一致（${snipFiles.length} 项）`);
    }
  }
}

// 5) API.md 快照示例 JSONC ↔ 声明契约
// 契约键集是 API.md 与代码之外的第三个事实源：示例手滑打错字段、或文档了代码里
// 不存在的键，都会红。示例是带省略号与注释的 JSONC，先剥注释（保字符串内 // 不动）再解析。
{
  const apiDoc = readFileSync(join(ROOT, "docs", "API.md"), "utf8");
  const block = apiDoc.match(/```jsonc\n([\s\S]*?)```/);
  if (!block) bad("docs/API.md 找不到 jsonc 快照示例块");
  else {
    const stripJsonc = (src) => {
      let out = "";
      let i = 0;
      let inStr = false;
      while (i < src.length) {
        const c = src[i];
        if (inStr) {
          out += c;
          if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
          if (c === '"') inStr = false;
          i++;
          continue;
        }
        if (c === '"') { inStr = true; out += c; i++; continue; }
        if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
        if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
        out += c;
        i++;
      }
      return out;
    };
    const cleaned = stripJsonc(block[1])
      .replace(/\s*\.\.\.\s*/g, "") // 占位省略号：{...}->{}、["..."]->[""]
      .replace(/,\s*([}\]])/g, "$1"); // 尾随逗号容错
    let parsed = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      bad(`API.md 快照示例不是合法 JSON：${e.message}`);
    }
    if (parsed) {
      // 契约：快照成功响应的 13 个顶层键（含条件性 visionModels）
      const canonical = ["auth", "cacheSeconds", "catalogAvailable", "catalogModels", "consoleBase", "llm", "now", "ok", "pollSeconds", "quota", "shapeWarnings", "usage", "visionModels"].sort().join(",");
      const docKeys = Object.keys(parsed).sort().join(",");
      if (docKeys !== canonical) bad(`API.md 快照示例顶层键与契约不符：\n  文档：${docKeys}\n  契约：${canonical}`);
      else note("API.md 快照示例顶层键与契约一致（13 键）");
      // The contract keys must appear in the code that BUILDS the snapshot
      // body. That is `snapshot-aggregate.js` (the extracted aggregation half)
      // plus `index.js` (which still assembles the error-path bodies and
      // carries the key names through its route handlers). Either file may
      // carry a key; both are required to be import-reachable from index.js.
      const indexSrc = readFileSync(join(ROOT, "src", "host", "index.ts"), "utf8");
      const aggregateSrc = existsSync(join(ROOT, "src", "host", "snapshot-aggregate.ts"))
        ? readFileSync(join(ROOT, "src", "host", "snapshot-aggregate.ts"), "utf8")
        : "";
      const sourceText = `${indexSrc}\n${aggregateSrc}`;
      const missing = canonical.split(",").filter((k) => !new RegExp(`\\b${k}\\b`).test(sourceText));
      if (missing.length) bad(`契约键在快照构建源码中未出现：${missing.join(", ")}`);
    }
  }
}

// 6) docs/ 顶层每个文件都必须被 docs/README.md 索引表引用（README.md 本身除外）
// 防止「粘贴一段文档进来但谁都不引用」的孤儿文件：非 .md（如 .txt）与未被索引的 .md 都红。
// 索引表里指向其它目录（如 ../CHANGELOG.md）的链接不属于 docs/，不算。
{
  const readme = readFileSync(join(ROOT, "docs", "README.md"), "utf8");
  const linked = new Set(["README.md"]);
  for (const m of readme.matchAll(/\]\(\.\/([^)]+\.md)\)/g)) linked.add(m[1]);
  const docsDir = join(ROOT, "docs");
  const orphans = readdirSync(docsDir)
    .filter((name) => !statSync(join(docsDir, name)).isDirectory())
    .filter((name) => !linked.has(name));
  if (orphans.length) bad(`docs/ 顶层存在未被 docs/README.md 索引表引用的文件：${orphans.join(", ")}（孤儿文件，需入库或删除）`);
  else {
    const total = readdirSync(docsDir).filter((name) => !statSync(join(docsDir, name)).isDirectory()).length;
    note(`docs/ 顶层 ${total} 个文件全部被索引表引用`);
  }
}

// N) PITFALLS 的条目数：凡是写了「N 条」的地方，N 必须等于真实条目数
// 这些数字散在三个文件里，已经各自漂移过一次（15 / 17 并存），而 PITFALLS
// 是「改代码前先看」的第一站——一个过期数字会让读者以为自己看全了。
{
  const pitfalls = readFileSync(join(ROOT, "docs/PITFALLS.md"), "utf8");
  const actual = (pitfalls.match(/^## \d+\./gm) ?? []).length;
  let claims = 0;
  let pointed = 0;
  for (const f of mdFiles) {
    const text = readFileSync(f, "utf8");
    // 「N 条」是总数；「第 N 条」/「§N」是条号。两者都要查，但含义不同，
    // 所以 `第` 后面的数字不能当成总数——那会把一条有效引用报成数字漂移。
    // `(?<!\d)` 是必需的：「第 13 条」里的 `3 条` 也是 `\d+条`，没有它就会
    // 把一条有效引用当成总数漂移报出来。
    for (const m of text.matchAll(/PITFALLS\.md[^\n]*?(?<!第\s*)(?<!\d)(\d+)\s*条/g)) {
      claims += 1;
      const claimed = Number(m[1]);
      if (claimed !== actual) {
        bad(`${f.replace(ROOT + "\\", "")} 称 PITFALLS 有 ${claimed} 条，实际 ${actual} 条`);
      }
    }
    for (const m of text.matchAll(/PITFALLS\.md[^\n]*?(?:第\s*(\d+)\s*条|§\s*(\d+))/g)) {
      pointed += 1;
      const cited = Number(m[1] ?? m[2]);
      if (cited < 1 || cited > actual) {
        bad(`${f.replace(ROOT + "\\", "")} 引用 PITFALLS 第 ${cited} 条，但只有 ${actual} 条`);
      }
    }
  }
  if (claims < 2) bad(`只找到 ${claims} 处「N 条」引用，检查本身可能已经失效`);
  else note(`PITFALLS 条目数 ${actual}，${claims} 处总数引用与 ${pointed} 处条号引用全部有效`);
}

// 8) src/ 注释里的模块名引用完整性
// 事故教训：注释里 `indexts`（少了点的 index.ts）这种伪文件名曾在 21 个文件里繁殖 66 处，
// 修完 42 处又长回来——注释里的引用没人校验就不会红。这里钉两条：
//   a) 反引号里的 `Xts` / `dir/Xts` 伪文件名，若 `X.ts`/`X.js` 在 src 里真实存在，直接报错
//      （候选存在判定天然放过 hosts / attempts 这类正常英文词）；
//   b) 反引号里的 `X.ts` 式正引用必须能解析到真实文件，否则断链。
// 两个白名单名词是架构事实而非源码引用，跳过但留痕：
//   - `client.js`        根构建产物（tsdown 从 src/client 构建，gitignore，干净检出不在）
//   - `client-surface.js` loader 的模块面（仓库外约定名，见 src/client/runtime.ts 头注释）
{
  const tsFiles = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); }
      else if (name.endsWith(".ts")) tsFiles.push(p);
    }
  };
  walk(join(ROOT, "src"));
  const rel = (p) => p.replace(ROOT + "\\", "").replace(/\\/g, "/");
  const KNOWN_ARTIFACTS = new Set(["client.js", "client-surface.js"]);
  const srcCandidate = (ref) => {
    // 引用可能是 `X.ts`（同目录或 src 根）、`dir/X.ts`（src 内相对）或 `src/host/X.ts`
    // （仓库根相对，wire.ts 就这么写）；按惯例的基准全部枚举一遍
    const plain = ref.startsWith("./") ? ref.slice(2) : ref;
    const bases = [join(ROOT, "src"), join(ROOT, "src", "host"), join(ROOT, "src", "client"), ROOT];
    return bases.map((b) => join(b, plain)).filter((c) => existsExact(c));
  };
  const fileCandidates = (ref, baseDir) => [join(baseDir, ref), ...srcCandidate(ref)].filter((c) => existsExact(c));
  let pseudo = 0, checked = 0, known = 0;
  for (const f of tsFiles) {
    const text = readFileSync(f, "utf8");
    // a) 伪文件名 `Xts` / `dir/Xts`：候选真实文件存在才算数
    for (const m of text.matchAll(/`([\w-]+(?:\/[\w-]+)*)ts`/g)) {
      const x = m[1];
      const asTs = srcCandidate(`${x}.ts`);
      const asJs = srcCandidate(`${x}.js`);
      if (asTs.length || asJs.length) {
        pseudo++;
        bad(`${rel(f)} 注释伪文件名 \`${x}ts\`（应为 \`${x}.ts\`）`);
      }
    }
    // b) 正引用 `X.ts` / `dir/X.ts`（含 ./ 前缀）必须存在；两个架构名词白名单跳过但留痕
    for (const m of text.matchAll(/`((?:\.\/)?[\w-]+(?:\/[\w-]+)*\.(?:ts|js))`/g)) {
      const ref = m[1];
      checked++;
      if (KNOWN_ARTIFACTS.has(ref)) { known++; continue; }
      if (fileCandidates(ref, dirname(f)).length === 0) {
        bad(`注释引用断链：${rel(f)} -> \`${ref}\``);
      }
    }
  }
  if (pseudo === 0) note(`注释伪文件名 0 处（${tsFiles.length} 个 src 文件）`);
  else note(`注释伪文件名 ${pseudo} 处（已在上方逐条列出）`);
  note(`注释模块引用 ${checked} 条全部可解析${known ? `（含 ${known} 条架构名词白名单）` : ""}`);
}

// 9) README 必须覆盖面板的每一个 tab
// 上面 1-8 全是形式校验：链接能解析、表格没复制、行数没超——它们对「README 说的
// 事是不是真的」一无所知。事故：0.4.3 新增第三个 tab「小浣熊」，README 零处提及，
// 而 README 进 npm 的 files 白名单——装完的用户不知道这个能力存在（PITFALLS §24）。
// 这里从两个真源派生「README 必须出现的文案」，不写死任何名字：
//   a) panel-page.ts 的 activeTab 联合类型 -> tab id 集合
//   b) i18n.ts 里 `tab.<id>` 的中文文案（zh 字典在前，同键只取首次）
// 于是「加一个 tab 而忘了告诉用户」必然红，「改 tab 名而 README 不跟」也必然红。
{
  const panelSrc = readFileSync(join(ROOT, "src", "client", "panel-page.ts"), "utf8");
  const i18nSrc = readFileSync(join(ROOT, "src", "client", "i18n.ts"), "utf8");
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  // 必须钉到 activeTab：本文件第一个 useState 是 useState<SnapshotData | null>，
  // 泛配会抓到它，反而漏掉真正的 tab 联合类型（自查时此处红过一次）。
  const union = panelSrc.match(/activeTab,\s*setActiveTab\]\s*=\s*useState<([^>]+)>/);
  if (!union) bad("src/client/panel-page.ts 找不到 activeTab 的联合类型，检查 9 本身可能已失效");
  else {
    const tabIds = [...union[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    if (tabIds.length === 0) bad("activeTab 联合类型里没有解析出任何 tab id");
    else {
      const zh = new Map();
      for (const m of i18nSrc.matchAll(/"tab\.([A-Za-z]+)"\s*:\s*"([^"]+)"/g)) {
        if (!zh.has(m[1])) zh.set(m[1], m[2]); // zh 字典在 en 之前
      }
      const missingName = tabIds.filter((id) => !zh.has(id));
      const missingInReadme = tabIds.filter((id) => zh.has(id) && !readme.includes(zh.get(id)));
      if (missingName.length) bad(`i18n 里缺 tab 文案：${missingName.join(", ")}`);
      if (missingInReadme.length) {
        bad(`README 没提到这些 tab（${tabIds.length} 个 tab 必须全覆盖）：` +
          missingInReadme.map((id) => `${id}（面板文案「${zh.get(id)}」）`).join("、"));
      }
      if (!missingName.length && !missingInReadme.length) {
        note(`README 覆盖全部 ${tabIds.length} 个 tab：${tabIds.map((id) => zh.get(id)).join(" / ")}`);
      }
    }
  }
}

// 10) 自述面声明的 UI 位置必须与 client 实际注册的槽位一致
// 同一次事故的另一半：0.4.3 把面板从 sidebar 迁到 plugins.bundle.config，README 三处
// 仍写「侧边栏」，第 31 行「打开侧边栏「积分面板」」让用户找不到入口——操作级失效。
// 双向校验：哪一侧单独改都会红。
//
// 受检面**必须覆盖全部自述文档**，不能只查 README：首次只查 README + cordis.patch.yml 时，
// ARCHITECTURE / SETUP / DSH-PLUGIN / ROADMAP / CONTRIBUTING 里另外 7 处「侧边栏」全部漏网
// （SETUP 那两处还会在用户安装后直接误导操作路径）。CHANGELOG 与 PITFALLS **整file豁免**：
// 它们记录的是历史动作与事故本身（「从侧边栏归位到 Plugins 页」），写「侧边栏」是如实叙述。
{
  const clientDir = join(ROOT, "src", "client");
  // 只剥「整行都是注释」的行（`//`、`*`、`/*` 开头），不动行内 `//`——URL 里的
  // `https://` 若被当注释削掉，一条路由字符串会被截成半个，误判成「没有注册」。
  const stripCommentLines = (src) =>
    src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  let code = "";
  for (const name of readdirSync(clientDir)) {
    if (name.endsWith(".ts")) code += stripCommentLines(readFileSync(join(clientDir, name), "utf8")) + "\n";
  }
  const has = (needle) => code.includes(needle);
  const HISTORY_FILES = new Set(["CHANGELOG.md", "PITFALLS.md"]);
  const surfaces = [
    ...readdirSync(ROOT)
      .filter((n) => n.endsWith(".md") && !HISTORY_FILES.has(n))
      .map((n) => n),
    ...readdirSync(join(ROOT, "docs"))
      .filter((n) => n.endsWith(".md") && !HISTORY_FILES.has(n))
      .map((n) => join("docs", n)),
    "cordis.patch.yml",
  ];
  const claims = [
    { words: ["侧边栏", "sidebar panel"], requires: "sidebar", via: "sidebar" },
    { words: ["Plugins 页", "plugins.bundle.config"], requires: "plugins.bundle.config", via: "plugins.bundle.config" },
  ];
  // 「不在侧边栏」这类否定句是在帮用户纠偏，不该被当成位置声明——只在肯
  // 定行上找槽位词。当初事故那句「打开侧边栏「积分面板」」不含否定词，照样红。
  //
  // 第二类豁免：**谈论「旧 / 原文 / 已过期」的句子**。文档里必须能引用一句失效的
  // 原文来说明它错在哪（例：引 PR 正文的 "for the Harness Web sidebar" 作为
  // 「该描述已过期」的证据；引用 npm 上旧 README 里还写着侧边栏入口）。这类句子
  // 是在描述「别处那份旧文本」，不是声明当前位置。判据词刻意收窄到这五个，
  // 免得把「打开侧边栏…」这种真事故也一并豁免掉。
  const NEGATIONS = [
    "不在", "不是", "并非", "不再", "已从", "迁移出", "移出", "归位",
    "仍含", "原文", "引述", "旧版", "已过期",
    "no longer", "not in the",
  ];
  const affirmative = (text) =>
    text.split(/\r?\n/).filter((l) => !NEGATIONS.some((n) => l.toLowerCase().includes(n))).join("\n");
  let wrong = 0;
  for (const file of surfaces) {
    const text = affirmative(readFileSync(join(ROOT, file), "utf8"));
    for (const claim of claims) {
      if (!claim.words.some((w) => text.toLowerCase().includes(w.toLowerCase()))) continue;
      if (!has(claim.requires)) {
        wrong++;
        bad(`${file} 声称面板在 ${claim.words[0]}，但 src/client/*.ts 里没有 ${claim.via} 槽位注册（"${claim.requires}"）——自述与实际已分头走路`);
      }
    }
  }
  if (wrong === 0) note(`自述面的面板位置与 client 槽位注册一致（受检 ${surfaces.length} 个文件：全量 docs 减 ${HISTORY_FILES.size} 个历史档）`);
}

// 11) screenshots.json 声明的每一张图必须真实存在于磁盘
// 实测事故（2026-10-01）：重截截图时文件名从 panel-credit-pools.png /
// panel-provider-setup.png 换成 panel-credit.png / panel-API-provider.png，
// assets/ 与 git 都已同步新名，**唯独 screenshots.json 还指着两个已不存在的
// 文件**——工作树干净、构建通过、其余十条检查全绿，没有任何东西在报错。
// 而这份清单是市场页取图的唯一依据（也是 npm files 白名单成员），推上去
// 就是四张图全裂。它与检查 10 是同一类病：**自述面与实际分头走路**，
// 只不过这次分头的是「清单」与「资产」。
//
// 判据全部是硬事实（文件是否存在、是不是图片、条目数在 1–8），不猜语义。
{
  const manifest = join(ROOT, "screenshots.json");
  if (!existsSync(manifest)) {
    bad("缺少 screenshots.json——市场页靠它取图，没有它市场条目无截图");
  } else {
    let list;
    try {
      list = JSON.parse(readFileSync(manifest, "utf8"));
    } catch (e) {
      bad(`screenshots.json 不是合法 JSON：${e.message}（它是 npm files 白名单成员，坏掉会让市场取不到图）`);
    }
    if (list !== undefined) {
      if (!Array.isArray(list)) {
        bad(`screenshots.json 顶层必须是数组，实际是 ${typeof list}`);
      } else if (list.length < 1 || list.length > 8) {
        bad(`screenshots.json 有 ${list.length} 条，超出市场允许的 1–8 张`);
      } else {
        const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
        let missing = 0;
        let checked = 0;
        for (const entry of list) {
          if (typeof entry !== "string") {
            bad(`screenshots.json 含非字符串条目：${JSON.stringify(entry)}（每项都必须是路径字符串）`);
            continue;
          }
          const rel = entry.trim();
          if (rel === "") {
            bad("screenshots.json 含空条目——市场读不到路径");
            continue;
          }
          // 必须是仓库根相对路径：绝对路径与 `..` 逃逸在别人机器上解析不到，
          // 市场也读不到。
          if (rel.startsWith("/") || rel.includes("..")) {
            bad(`screenshots.json 的 "${rel}" 不是仓库根相对路径（绝对路径 / .. 逃逸在别人机器上必裂）`);
            continue;
          }
          if (!existsSync(join(ROOT, rel))) {
            missing++;
            bad(`screenshots.json 声明的 ${rel} 不存在——清单指空，市场按它取图必然裂`);
            continue;
          }
          if (!IMAGE_EXT.has(extname(rel).toLowerCase())) {
            bad(`screenshots.json 的 ${rel} 不是图片扩展名（${[...IMAGE_EXT].join("/")}）`);
            continue;
          }
          checked++;
        }
        if (missing === 0) note(`screenshots.json 的 ${checked} 张图全部存在于磁盘且为图片`);
      }
    }
  }
}

// 12) 考古纪律：现行文档不许盖「修订（日期）」式内联补丁——决策沿革只进账本
{
  // 账本与档案类天生带历史，豁免扫描；要豁免一篇现行文档，必须在这里有意识地
  // 加名字——新文档默认受检。为什么这样设计：§5 曾叠出三层「修订」沉积，新读者
  // 把历史读成现行规则；2026-10 起裁定沿革一律进 docs/ADR.md，正文只写现状。
  const LEDGERS = new Set([
    "ADR.md",
    "ARCHIVE-BOUNDARY-DECISIONS.md",
    "CHANGELOG.md",
    "PITFALLS.md",
    "IMPROVEMENTS.md"
  ]);
  const archeo = /(?:\d{4}-\d{2}-\d{2}\s*修订|修订（[一二三四五六七八九]|本节裁定已失效)/;
  let scanned = 0;
  for (const f of mdFiles) {
    if (LEDGERS.has(basename(f))) continue;
    scanned++;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const hit = line.match(archeo);
      if (hit) bad(`${f}:${i + 1} 内联考古层「${hit[0]}」——现行正文只写现状，裁定沿革进 docs/ADR.md`);
    });
  }
  // 账本自身的最小形状：存在、有条目、每条目带日期与状态——账本缺行等于没记账。
  const adrPath = join(ROOT, "docs", "ADR.md");
  if (!existsExact(adrPath)) {
    bad("docs/ADR.md（决策账本）不存在——历次裁定无处登记");
  } else {
    const adr = readFileSync(adrPath, "utf8");
    const heads = [...adr.matchAll(/^## (ADR-\d{3}[^\n]*)/gm)];
    if (heads.length === 0) bad("docs/ADR.md 没有任何「## ADR-NNN」条目");
    for (const [head, title] of heads) {
      const at = adr.indexOf(head);
      const next = adr.indexOf("\n## ADR-", at + 1);
      const block = adr.slice(at, next === -1 ? adr.length : next);
      if (!/日期/.test(block) || !/状态/.test(block)) bad(`ADR 条目缺日期/状态行：${title.trim()}`);
    }
    note(`考古纪律：受检 ${scanned} 篇现行文档零内联补丁；账本 ${heads.length} 条目形状合格（日期/状态齐）`);
  }
}

// 13) peer 边界：静态 `@deepseek-ai/*` import 只许出现在 llm adapter 壳
{
  // 「peer 缺席 → 该模块缺席、面板照常用」（AGENTS.md 三条事实 2、ARCHITECTURE §5
  // 不变量 1）只有在内核不**静态**依赖 peer 时才成立：任何内核文件一碰静态 import，
  // peer 解析失败炸的就是整个 bundle 的装载——缺席降级当场变成缺席全机。动态
  // `import()` 恰是惰性机制本体，不在打击面；这里只钉静态边。豁免名单就是机制：
  // 两个 llm adapter 壳（它们缺席才是「该模块缺席」的那个「该模块」）。
  const ALLOW_STATIC_PEER = new Set(["llm-adapter.ts", "agnescode-llm-adapter.ts"]);
  const collectTs = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectTs(p));
      else if (entry.name.endsWith(".ts")) out.push(p);
    }
    return out;
  };
  const staticPeer = /(?:^|\n)(?:import|export)\b[^;]*?from\s*["'](@deepseek-ai\/[^"']+)/g;
  let scanned = 0;
  let offenders = 0;
  for (const f of collectTs(join(ROOT, "src", "host"))) {
    if (ALLOW_STATIC_PEER.has(basename(f))) continue;
    scanned++;
    const text = readFileSync(f, "utf8");
    staticPeer.lastIndex = 0;
    const hit = staticPeer.exec(text);
    if (hit) {
      offenders++;
      bad(`peer 静态边界：${relative(ROOT, f)} 静态 import 了 "${hit[1]}"——内核不得静态依赖 Host peer（缺席降级只允许发生在 llm adapter 壳；惰性接入请走动态 import()`);
    }
  }
  if (offenders === 0) note(`peer 边界：${scanned} 个内核文件零静态 peer import（adapter 壳 2 个豁免）`);
}

// 14) 活文档硬编码计数护栏：现行文档不得断言会随代码漂移的模块数/规模/行数
// 同源病（PITFALLS §25）：形式全绿、语义已漂。本检查钉的是「活文档里写死代码
// 形状数字」——加一个模块 / 做一次重构，文档就失真，逼出一次纯文档提交。
// 历史·账本·研究档整 file 豁免（它们本就是定格快照，写死数字是如实记录）；
// 其中 ARCHITECTURE §5.4（上游对照）与 ROADMAP（历史重构记录）刻意保留「行数」
// 叙述，故只对这两篇豁免 N 行 子检查，模块数/规模子检查仍生效。
{
  const COUNT_EXEMPT = new Set([
    "ADR.md", "ARCHIVE-BOUNDARY-DECISIONS.md", "CHANGELOG.md",
    "PITFALLS.md", "IMPROVEMENTS.md", "TOKEN-STORE-SPLIT.md",
  ]);
  // 这两篇活文档保留「上游/历史行数」叙述，只对它们豁免 N 行 子检查
  const LINE_COUNT_OK = new Set(["ARCHITECTURE.md", "ROADMAP.md"]);
  // 路由条数同样随代码漂移（每加一条路由就陈旧一次）。ROADMAP 是历史重构记录，
  // 它的「N 条路由」是那次重构的范围快照而非现行断言——与 N 行 同理豁免。
  const ROUTE_COUNT_OK = new Set(["ROADMAP.md"]);
  const moduleRe = /\d+\s*个(?:Host |Client |前端|服务端)?模块/g;
  const wanRe = /\d+(?:\.\d+)?\s*万行/g;
  // 中文「N 条路由」在汉语里既可能是计数断言（「六条写路由改接审计版」），也可能是
  // 泛指（「两条路由共用一份处理器实现」）——两者同形，正则无法区分。所以这里只锚定
  // 无歧义的断言写法：阿拉伯数字、`N 条写路由`、括号夹注式计数（「（六条，都在…」）。第三个
  // 分支的「条」后必须是「路由」或紧跟「，、都、均」，否则会把「（37 条）」（PITFALLS
  // 条目数，另有专门检查兜着）误伤——那正是本护栏第一版踩过的坑。
  // 已知边界（故意不拦，靠 review）：无括号的无歧义中文计数（「七条路由都经过…」）、
  // 以及括号内只有数字的「路由（六条）」（与「（37 条）」同形，无法区分）。
  const routeCountRe = /(?:\d+\s*条(?:写)?路由)|(?:[二两三四五六七八九十百]+\s*条写路由)|(?:（\s*[0-9二两三四五六七八九十百]+\s*条(?:写)?路由)|(?:（\s*[0-9二两三四五六七八九十百]+\s*条(?=[，、都均]))/g;
  // 行数声明：排除「第 N 行」这类引用定位（如「见第 3 行」），只钉裸「N 行」
  const lineRe = /(?<!第)\d{1,}\s*行/g;
  let scanned = 0;
  let hits = 0;
  for (const f of mdFiles) {
    if (COUNT_EXEMPT.has(basename(f))) continue;
    // tmp/ 是临时草稿区（不按活文档标准审查）
    if (relative(ROOT, f).split(sep)[0] === "tmp") continue;
    scanned++;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    const allowLine = !LINE_COUNT_OK.has(basename(f));
    const allowRoute = !ROUTE_COUNT_OK.has(basename(f));
    lines.forEach((line, i) => {
      let m;
      if ((m = line.match(moduleRe))) {
        hits++;
        bad(`${f}:${i + 1} 写死模块数「${m[0].trim()}」——模块数随代码漂移，改由目录为准（参见 ARCHITECTURE.md Client 行）`);
      }
      if ((m = line.match(wanRe))) {
        hits++;
        bad(`${f}:${i + 1} 写死规模「${m[0].trim()}」——源规模随重构漂移，历史档才适合记定格数字`);
      }
      if (allowLine && (m = line.match(lineRe))) {
        hits++;
        bad(`${f}:${i + 1} 写死行数「${m[0].trim()}」——行数随代码漂移，活文档不在此钉死（历史/上游对照档豁免）`);
      }
      if (allowRoute && (m = line.match(routeCountRe))) {
        hits++;
        bad(`${f}:${i + 1} 写死路由条数「${m[0].trim()}」——路由数随代码漂移，改以 \`registerRoutes\` 为准（历史档豁免）`);
      }
    });
  }
  if (hits === 0) note(`活文档计数护栏：受检 ${scanned} 篇现行文档零写死模块数/规模/行数/路由条数（历史·账本·研究档 ${COUNT_EXEMPT.size} 篇豁免；ARCHITECTURE/ROADMAP 的 N 行 子检查豁免）`);
}

if (fails.length) {
  console.error(`\n❌ docs.test.mjs 失败 ${fails.length} 项：`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✅ docs.test.mjs 全部通过\n");
