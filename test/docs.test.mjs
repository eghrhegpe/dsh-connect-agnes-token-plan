// docs.test.mjs —— 文档与引用一致性钉子（纯文件读取：无网络、无 peer 依赖、干净检出即可跑）
//
// 守住五类「一致性纪律」。每条检查都**有一个名字**（见下方 CHECK_IDS）——文档引用
// 一律写名字、不写序号：序号只存在于本注释里，增删一条检查就会把下游所有「检查 N」
// 静默顶错位；名字增删只增删集合成员，已有名字永不变。
//   文档结构：LINKS 内部链接可解析、TABLES 跨文件表格去重、README_LINES 根 README
//                    行数上限、SNAPSHOT DSH-PLUGIN.md 教学快照同步、API_SNAPSHOT
//                    API.md 快照契约、ORPHAN_DOCS docs/ 孤儿文件
//   事实引用：PITFALLS_REFS 条目数/条号引用有效、SRC_COMMENT_REFS src/ 注释里的模块名引用完整（含伪文件名扫描）
//   自述面与实际一致：README_TABS README 覆盖每个 tab、SELF_DESCRIPTION 声明的 UI 位置
//                    与 client 槽位注册一致、SCREENSHOTS 声明的图真实存在于磁盘。这三条
//                    与前两组有本质区别：前两组验的是「文档格式对不对」，它们验的是
//                    「文档有没有说实话」——形式全绿而语义已漂，是本仓库踩过两次的坑（见 PITFALLS §25）。
//   考古纪律：ARCHAEOLOGY 现行文档不许盖「修订（日期）」式内联补丁——决策沿革只登记
//                    在 docs/ADR.md 账本（规则本体见该文件「使用规则」）
//   peer 边界：PEER_BOUNDARY 静态 `@deepseek-ai/*` import 只许 llm adapter 层——
//                    「内核 peer-free 才能缺席降级」这条自述承诺的静态面（与自述面同族：
//                    验的是文档说的架构纪律在代码里真的成立，不是格式）
//   client 分层：RULE_LAYER_BOUNDARY 规则层纯模块可被 Node 直 import，且规则不得从
//                    client 产物抠文本求值（ADR-006 判据的可执行形态；与 PEER_BOUNDARY 同族）
//   活文档计数护栏：COUNT_GUARD 现行文档不得写死会随代码漂移的模块数/规模/行数/路由条数/套件规模（历史·账本·研究档豁免）
//   检查引用可解析：REF_RESOLVABLE 全仓 md 里的「检查 <名字>」按就近套件名限定作用域后
//                    必须落在 CHECK_IDS 里；docs.test 语境的**数字**序号视为待迁移、报红；
//                    指到别的套件的不越权解析
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, extname, resolve, relative, sep, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];
const note = (m) => console.log(`  ok - ${m}`);
const bad = (m) => fails.push(m);

/**
 * A check's own survival guard: "I looked at N things, and N was not zero."
 *
 * PITFALLS §39's lesson, applied to THIS file rather than to the code it
 * guards: a check whose subject silently shrinks to nothing passes for the
 * wrong reason — a link scan that resolves 0 links, a boundary scan that
 * matches 0 files, a table scan that finds 0 tables all report "clean". Nine of
 * the sixteen checks below had no such floor, so `fails` stayed empty for
 * entirely mechanical reasons.
 *
 * `scanned` is the count the check actually examined. `floor` is the smallest
 * value that still means the check has a subject; pass 0 only where an empty
 * subject is legitimately expected (and say so in the message).
 * @param {string} id - the CHECK_IDS name, so the message points at the check.
 * @param {number} scanned - how many items this check actually examined.
 * @param {number} [floor] - the smallest non-vacuous count; default 1.
 * @returns {void}
 */
const guards = new Map();
const guard = (id, scanned, floor = 1) => {
  if (scanned < floor) {
    bad(`检查 ${id} 可能已失效：本次只受检了 ${scanned} 项（下限 ${floor}）——规则失配、路径改名或扫描面收缩都会让它以完全错误的理由通过`);
  }
  guards.set(id, { scanned, floor });
};

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

/**
 * 不进扫描面的目录。三类，理由各不相同：
 * - `upstream/` / `AGNES-API-docs/`：外部容器与一手信源，逐字抓取、只读，
 *   它们的一致性不归本仓管（见 REFERENCES.md）。
 * - `node_modules/` / `.git/`：不是文档。
 * - **`tmp/`：已被 `.gitignore` 忽略的临时草稿区**。它此前只在 `COUNT_GUARD`
 *   内部被逐条跳过，于是同一个 `tmp/` 在「活文档计数护栏」里被豁免、在断链/
 *   表格去重/考古纪律里却仍受审——**扫描面不一致**。后果是真实的：一次审计
 *   把 PITFALLS 的拟稿写进 `tmp/`，正文落库后拟稿还引用着旧条目数，全量门禁
 *   当场判红，而它审的是一份**不进版本库的草稿**。纪律上 `tmp/` 本就是
 *   「探针产物可以落」的地方（见 PITFALLS §10），在这里统一排除，与那条纪律对齐。
 *   判据：**凡是 gitignored 的目录，都不该进任何「活文档一致性」检查的扫描面。**
 * - **`.zcode/`**：同一条判据的第二个实例，而且是**实测漏网**的——它是本机
 *   代理会话自动写的计划区，`.gitignore:13` 明写「绝不进版本库」，却有一个
 *   文件被一次 `git add -A` 卷进了历史（与 `.gitignore:47-48` 记载的
 *   `probe-asar/` 是同一类事故）。它此前不在本清单里，于是这份本机草稿进了
 *   断链/表格/考古/计数的扫描面：现在全绿只因它碰巧没有链接、没有表格、没有
 *   写死数字，而那是运气不是护栏——代理下次重写这份计划就能让全量门禁判红。
 *   更要紧的是它记的是**已废弃的技术栈**（SenseNova 时代的 `section.pools`
 *   与「连接商汤控制台」，代码早已按 §1/§2/§5 删除），躺在仓库里会被读成现行方案。
 */
const SKIP_DIRS = new Set(["upstream", ".git", "node_modules", OFFICIAL_DOCS_DIR, "tmp", ".zcode"]);

function collectMd(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP_DIRS.has(name)) continue;
    if (statSync(p).isDirectory()) out.push(...collectMd(p));
    else if (extname(p) === ".md") out.push(p);
  }
  return out;
}

const mdFiles = collectMd(ROOT).sort();
console.log(`docs.test.mjs —— 检查 ${mdFiles.length} 个 markdown 文件`);

/**
 * docs.test 的检查名册——顶部注释那串描述的机器可解析形式。**文档引用写名字、不写
 * 序号**：序号只存在于注释里，增删一条检查（比如插入一个「检查 7」）就会把下游所有
 * 「检查 N」静默顶错位；名字增删只增删集合成员，已有名字永不变。值是一句话说明，
 * 让 `REF_RESOLVABLE` 的红报直接说「检查 <名>」而非让人去反查序号。
 *
 * 注意旧的序号体系里**没有 7**（文档结构到 6，事实引用从 8 起），而「检查 7」属于
 * `test/package.test.mjs` 自己的一套编号——同一个 7，在不同套件语境下指空/存在。
 * `REF_RESOLVABLE` 只解析 docs.test 语境的引用，指到别的套件的不越权。
 */
const CHECK_IDS = new Map([
  ["LINKS", "内部链接可解析"],
  ["TABLES", "跨文件表格去重"],
  ["README_LINES", "根 README 行数上限"],
  ["SNAPSHOT", "DSH-PLUGIN.md 教学快照与 package.json 同步"],
  ["API_SNAPSHOT", "API.md 快照契约"],
  ["ORPHAN_DOCS", "docs/ 孤儿文件"],
  ["PITFALLS_REFS", "PITFALLS 条目数/条号引用有效"],
  ["SRC_COMMENT_REFS", "src/ 注释里的模块名引用完整"],
  ["README_TABS", "README 覆盖面板每一个 tab"],
  ["SELF_DESCRIPTION", "自述 UI 位置与 client 槽位注册一致"],
  ["SCREENSHOTS", "screenshots.json 声明的图真实存在于磁盘"],
  ["ARCHAEOLOGY", "现行文档禁「修订（日期）」式内联补丁"],
  ["PEER_BOUNDARY", "内核零静态 `@deepseek-ai/*` import"],
  ["RULE_LAYER_BOUNDARY", "client 规则层 Node 可直 import，规则不得从产物抠取（ADR-006）"],
  ["COUNT_GUARD", "活文档计数护栏：不得写死会漂移的规模"],
  ["PUBLISHED_VERSION", "发布版本陈述不得低于 package.json（CONTRIBUTING.md）"],
  ["REF_RESOLVABLE", "检查引用可解析（本条自己）"]
]);

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
  guard("LINKS", checked, 50);
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
  guard("TABLES", seen.size, 10);
}

// 3) 根 README 行数上限
{
  const lines = readFileSync(join(ROOT, "README.md"), "utf8").split(/\r?\n/).length;
  const cap = 140;
  if (lines > cap) bad(`README.md 共 ${lines} 行，超过上限 ${cap}：根 README 只做索引与快速上手，细节下沉 docs/`);
  else note(`README.md ${lines} 行（上限 ${cap}）`);
  guard("README_LINES", 1, 1);
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
      // 契约：快照成功响应的顶层键，**从 Host 的构建函数派生**，不在这里手写。
      //
      // 这里原本是一行手写字面量（13 个键）。它让本检查自己成了 API.md 与代码
      // 之外的「第三个事实源」：断言是 `docKeys === canonical`，于是「Host 加了
      // 第 14 个键、wire.ts 也声明了、只有 API.md 没跟」这一类漂移它看不见——
      // 文档仍然等于 canonical，照样绿。而那恰恰是 API.md 会过期的方式。
      //
      // 现在两端都从同一个源读：键集从 `buildSnapshotBody` 的返回字面量按花括号
      // 深度取（与 contract.test.mjs §10 同一套锚点和缩进规则），文档示例必须与它
      // 逐键相等。任何一侧加了键而另一侧没跟，都会红在其中一条上。
      const hostSrc = readFileSync(join(ROOT, "src", "host", "snapshot-aggregate.ts"), "utf8");
      const lines = hostSrc.split(/\r?\n/);
      const at = lines.findIndex((l) => /^export async function buildSnapshotBody\b/.test(l));
      const open = at < 0 ? -1 : lines.findIndex((l, i) => i > at && /^ {2}return \{$/.test(l));
      const derived = new Set();
      if (open >= 0) {
        for (let i = open + 1; i < lines.length; i++) {
          const line = lines[i];
          if (/^ {2}\};/.test(line)) break;
          // `...(cond ? { key } : {})` —— 条件字段同样是服务出去的键。
          let m = line.match(/^ {4}\.\.\..*\{\s*(\w+)\s*\}/);
          // 普通键以 `:` 或 `,` 结尾，也可以什么都没有——那是字面量最后一个字段
          // 的写法。要求分隔符会漏掉 `shapeWarnings`，把它变成幽灵「客户端声明了
          // Host 从不服务的键」（contract.test.mjs 记录过这个解析器 bug）。
          if (!m) m = line.match(/^ {4}(\w+)\s*(?::|,|$)/);
          if (m) derived.add(m[1]);
        }
      }

      // 解析器判活优先：正则一旦因重排/改名失效，derived 会缩水成空集，而
      // 「集合相等」在两边同时缩水时**可能仍然成立**（空 === 空）。锚点是面板
      // 没有就渲染不出来的块，外加 `shapeWarnings`——字面量的最后一个键，所以
      // 只读「有分隔符的行」的解析器也会被抓住。
      const ANCHORS = ["ok", "now", "quota", "usage", "llm", "shapeWarnings"];
      const parserLive = ANCHORS.every((k) => derived.has(k));
      if (!parserLive) bad(`快照键解析器失效（锚点缺失）：得到 [${[...derived].join(", ")}]`);
      else {
        const canonical = [...derived].sort().join(",");
        const docKeys = Object.keys(parsed).sort().join(",");
        if (docKeys !== canonical) bad(`API.md 快照示例顶层键与 Host 派生的契约不符：\n  文档：${docKeys}\n  契约：${canonical}`);
        else note(`API.md 快照示例顶层键与 Host 派生的契约一致（${derived.size} 键）`);
      }
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
    guard("ORPHAN_DOCS", total, 5);
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
  guard("PITFALLS_REFS", actual, 20);
}

// 7b) 归档文件的顶层节数不得超过其拆分明细表登记的节数
//
// 这条是 PITFALLS §55 教训①的**闸门**，而 §55 立的那条教训是「档案身份靠声明维持
// 而声明约束不了追加」。改名 + 加警告建立了身份，**但没有闸门**——本条之前，
// 任何人往 `ARCHIVE-*.md` 里加一章新内容，`docs.test.mjs` 的现有检查一条都不会红
// （套件规模以 `package.json scripts.test` 为准，此处不写死数字）。
// 那条档案正是这么从「2026-09 的快照」长成「一半档案一半活文档」的（§1–§6 商汤时代、
// §7–§9 追加于 09-30 / 10-02 / 10-05），所以缺闸门不是假设的风险，是已发生过的事实。
// 判据是**明细表 vs 正文**的节数对账：明细表逐节列了去向（删 / 留档 / → ADR / → 归档），
// 正文里的顶层 `## ` 节数超过登记数，就说明有人在归档文件里新增了节——而新增内容
// 按 §55 的纪律应当升进活文档或账本，不是就地追加。
{
  const ARCHIVES = mdFiles.filter((f) => basename(f).startsWith("ARCHIVE-IMPROVEMENTS"));
  if (ARCHIVES.length === 0) {
    bad("未找到 ARCHIVE-IMPROVEMENTS 存档文件（改名后本检查失效，请更新本检查）");
  } else {
    // 判据：**最大节号单调**——正文二级标题的最大原节号不得超过明细表登记的最大原节号。
    //
    // 为什么不是「两侧集合对账」：明细表按**不统一粒度**登记（有整节 `§2`、有子节
    // `§4.1`、还有「§5 / §6」一行两节），而正文是二级标题的整节——**粒度不可比**。
    // 实测连折三次都误报：① 按「行数 vs 节数」比 → 报 10 vs 9（两套编号天然不等）；
    // ② 按「同粒度集合差」比 → 报「1.3/2.1/2.3/3.2/3.3/8.3/8.4/8.5 未登记」（那是原文
    // 本来就有的子节），而真正的追加 `## 10.` **因粒度不匹配溜过去了**；
    // ③ 改二级标题粒度 → 仍把「§5 / §6」的第二组漏读（§6 是登记过的）。
    // **判据比错的更危险**：三次都在报不存在的错，唯一该抓的那个反而漏了。
    //
    // 单调闸门只问一个可无条件判定的问题：**有人在归档里加新章了吗？** 新章的节号必然
    // 大于所有已登记的节号（它是「更后面」的内容），所以上限卡住即等价于「无新章」。
    // 删节/改名不由此检查管——那是 `ORPHAN_DOCS` 与导航表链接检查的职责，不叠加。
    let overDeclared = [];
    let maxDeclared = 0;
    for (const f of ARCHIVES) {
      const body = readFileSync(f, "utf8");
      // 明细表每行 `| §N…` 的第一个原节号；`/ §M` 那一侧由下面这行单独收。
      const declared = [...body.matchAll(/^\|\s*§(\d+)/gm)].map((m) => Number(m[1]));
      const alsoOf = [...body.matchAll(/^\|\s*§\d+(?:\.\d+)?\s*[/／]\s*§?(\d+)/gm)].map((m) => Number(m[1]));
      maxDeclared = Math.max(maxDeclared, ...declared, ...alsoOf);
      const present = [...body.matchAll(/^##\s+(\d+)\./gm)].map((m) => Number(m[1]));
      const maxPresent = present.length > 0 ? Math.max(...present) : 0;
      if (maxPresent > maxDeclared) {
        overDeclared.push(`§${maxPresent}（登记上限 §${maxDeclared}）`);
      }
    }
    if (overDeclared.length === 0) {
      note(`归档文件无新章追加（正文最大节号未超明细表登记上限 §${maxDeclared}）`);
    } else {
      bad(`归档文件出现比明细表更靠后的新章：${overDeclared.join(", ")}——有人在归档里就地追加内容。按 PITFALLS §55，新内容应升进 ADR / PITFALLS 或现行文档，不是就地追加`);
    }
    guard("ARCHIVE_NO_GROWTH", ARCHIVES.length, 1);
  }
}

// 8) src/ 注释里的模块名引用完整性
// 事故教训：注释里 `indexts`（少了点的 index.ts）这种伪文件名曾在 21 个文件里繁殖 66 处，
// 修完 42 处又长回来——注释里的引用没人校验就不会红。这里钉两条：
//   a) 反引号里的 `Xts` / `dir/Xts` 伪文件名，若 `X.ts`/`X.js` 在 src 里真实存在，直接报错
//      （候选存在判定天然放过 hosts / attempts 这类正常英文词）；
//   b) 反引号里的 `X.ts` 式正引用必须能解析到真实文件，否则断链。
// 两个白名单名词是架构事实而非源码引用，跳过但留痕：
//   - `client.js`        根构建产物（tsdown 从 src/client 构建，随库提交，干净检出即在）
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
  guard("SRC_COMMENT_REFS", checked, 50);
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
        guard("README_TABS", tabIds.length, 1);
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
  guard("SELF_DESCRIPTION", surfaces.length, 5);
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
        guard("SCREENSHOTS", checked, 1);
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
    // 2026-09 的研究档案，已改名归档。它是**混合体**（§1–§6 商汤时代、§7–§9 Agnes 线），
    // 按原样保留了大量已被推翻的原文（§1.2 的撤销论断、§2 的过期行号清单、§5 里 8 项已
    // 落地的待办），故豁免考古层检查。
    //
    // 豁免的**理由是身份而非需要**：改动前它就已在本名单里（当时自称"研究上游"，
    // 属勉强豁免），改名后它是真档案，豁免名副其实。这个检查要防的是"现行文档内联
    // 考古层"，而它已不是现行文档。
    //
    // 附注（2026-10-05 实测）：把它移出名单后 `docs.test.mjs` **仍全绿**——归档正文
    // 用的写法是「核验修订（2026-09-29 实测）」，而正则要求 `YYYY-MM-DD 修订`（日期在前）
    // 或 `修订（一）`（中文数字），两者都不匹配，故当前 0 命中。豁免是**预置**而非按命中
    // 豁免——别把它读成"删掉这个名字会红"。真正会红的是 `COUNT_EXEMPT` 那边（9 处写死
    // 规模：§2 的 778/342 行、"1.7 万行"等）。
    "ARCHIVE-IMPROVEMENTS-2026-09.md"
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
    guard("ARCHAEOLOGY", scanned, 10);
  }
}

// 13) peer 边界：静态 `@deepseek-ai/*` import 只许出现在 llm adapter 壳
{
  // 「peer 缺席 → 该模块缺席、面板照常用」（AGENTS.md 三条事实 2、ARCHITECTURE §5
  // 不变量 1）只有在内核不**静态**依赖 peer 时才成立：任何内核文件一碰静态 import，
  // peer 解析失败炸的就是整个 bundle 的装载——缺席降级当场变成缺席全机。动态
  // `import()` 恰是惰性机制本体，不在打击面；这里只钉静态边。豁免名单就是机制：
  // 两个 llm adapter 壳（它们缺席才是「该模块缺席」的那个「该模块」）加上两者共用
  // 的组装核心——核心同样只经动态 `import()` 抵达，且由壳静态引入，缺席面与壳一致。
  const ALLOW_STATIC_PEER = new Set(["llm-adapter.ts", "agnescode-llm-adapter.ts", "pi-ai-adapter-core.ts"]);
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
  if (offenders === 0) note(`peer 边界：${scanned} 个内核文件零静态 peer import（adapter 壳与共享组装核心共 ${ALLOW_STATIC_PEER.size} 个豁免）`);
  guard("PEER_BOUNDARY", scanned, 20);
}

// 14) client 规则层边界（ADR-006）：能算的进纯模块，规则名不得从产物抠取
// 与 PEER_BOUNDARY 同族——验的是「文档说的架构纪律在代码里真的成立」。ADR-006 把
// client 的可测边界钉在「能算的 vs 画出树」：纯规则模块必须能被 Node 直接 import，
// 规则层不得以「抓产物文本 + 在测试里抄一遍」兜底（那是双重真源换地方放，源码一漂
// 照样绿——PITFALLS §39「点名守护物而不校验守护物」的同源病）。
// 本检查上线前 ADR-006 只是文字纪律：没有任何门禁会拦住「从产物抠规则函数」。
{
  const CLIENT_DIR = join(ROOT, "src", "client");
  // 「值位置」import runtime.ts 才算耦合：`import type {...}` 编译期擦除，纯模块
  // 完全可以带它（snapshot.ts 就带），把它算进来会误伤。
  const importsRuntimeAsValue = (text) => {
    // 副作用式 `import "./runtime.ts"` 与动态 import() 都算耦合
    if (/(?:^|\n)\s*import\s*["']\.\/runtime\.ts["']/.test(text)) return true;
    if (/import\s*\(\s*["']\.\/runtime\.ts["']\s*\)/.test(text)) return true;
    for (const m of text.matchAll(/(?:^|\n)\s*import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']\.\/runtime\.ts["']/g)) {
      if (m[1]) continue; // `import type {…}` —— 类型位置，不算耦合
      const named = m[2].split(",").map((s) => s.trim()).filter(Boolean);
      if (named.some((s) => !/^type\s/.test(s))) return true; // 有非 type 项即值位置
    }
    return false;
  };

  const clientFiles = readdirSync(CLIENT_DIR).filter((n) => n.endsWith(".ts")).sort();
  const pure = [];
  const coupled = [];
  for (const name of clientFiles) {
    const text = readFileSync(join(CLIENT_DIR, name), "utf8");
    (importsRuntimeAsValue(text) ? coupled : pure).push(name);
  }
  // 钉住 ADR-006 点名的那层：它们一旦开始值位置 import runtime.ts，边界就塌了。
  const PINNED_PURE = ["snapshot.ts", "models.ts", "format.ts"];
  for (const name of PINNED_PURE) {
    if (!clientFiles.includes(name)) bad(`规则层边界：${name} 不存在——ADR-006 点名的纯模块被改名/删除，请同步 ADR 与本节`);
    else if (coupled.includes(name)) bad(`规则层边界：src/client/${name} 值位置 import 了 runtime.ts——它必须是 Node 可直 import 的纯模块（ADR-006 判据 1；类型位置 import 不受影响）`);
  }

  // 判据 1 的可执行形态：纯模块要真的能被 Node import（不只是「没写 runtime」）。
  let imported = 0;
  for (const name of pure) {
    try {
      await import(pathToFileURL(join(CLIENT_DIR, name)).href);
      imported++;
    } catch (e) {
      bad(`规则层边界：src/client/${name} 无 runtime 耦合却 import 失败（${String(e.message).split("\n")[0]}）——纯模块必须能被 Node 直接加载`);
    }
  }

  // 判据 2：不得**从产物文本抠规则函数**。探测器锚在「抽取器惯用法」而非函数名清单——
  // 按名清单既会误伤合法用法（build-gate 把 `viewOf` 当 surface 键断言，那是**引用
  // 模块面**，不是抠源码），又会随规则改名而失效。三家同族插件里该惯用法完全同形：
  // 用模板串 `function ${name}(...) {` 定位，再走花括号配平切出函数体。这才是签名。
  const testDir = join(ROOT, "test");
  const SELF = "docs.test.mjs"; // 见下方 self-scan 说明
  const testFiles = readdirSync(testDir).filter((n) => n.endsWith(".mjs")).sort();
  // 「读了 client 产物」＝真的 readFileSync 了它，而不是注释里提一句。裸 `BUNDLE`
  // 会让「注释里出现 BUNDLE」也算数，所以要求 readFileSync 与产物名同时出现。
  const readsArtifact = (text) =>
    /readFileSync/.test(text) && /(?:client\.js|\bBUNDLE\b|\bclientBundle\b)/.test(text);
  // 惯用法指纹（三家同族插件完全同形）：模板串里嵌 `function ${…}` 定位函数头，
  // 再用花括号配平切出函数体。**不锚函数名**——按名清单会误伤合法用法
  // （build-gate 把 `viewOf` 当 surface 键断言是引用模块面，不是抠源码），
  // 也会随规则改名而静默失效。
  const TEMPLATE_HEADER_RE = /function\s+\$\{/;
  const BRACE_WALK_RE = /depth\s*(?:\+\+|--|[-+]=)/;
  let scrapes = 0;
  let evals = 0;
  let artifactReaders = 0;
  for (const name of testFiles) {
    if (name === SELF) continue; // 本文件的负向对照必须含有被打击的形状
    const text = readFileSync(join(testDir, name), "utf8");
    if (!readsArtifact(text)) continue;
    artifactReaders++;
    if (TEMPLATE_HEADER_RE.test(text) && BRACE_WALK_RE.test(text)) {
      scrapes++;
      bad(`规则层边界：test/${name} 用「模板串定位函数头 + 花括号配平」从 client 产物里抠函数体——规则要 import 真模块，产物只做装载/新鲜度检查（ADR-006 判据 2；同形先例见 qoder 的 extract/extractFromBundle）`);
    }
    if (/new Function\s*\(/.test(text)) {
      evals++;
      bad(`规则层边界：test/${name} 既读 client 产物又用 new Function 求值其片段——规则必须从真模块 import（ADR-006 判据 2）`);
    }
  }

  // 反空转：探测器必须被证明有效。用 qoder 三处真实残留的同形代码做负向对照——
  // 没有这一段，上面两条断言可能在「正则永远不匹配」时全绿通过（那正是 §39 的病）。
  // 对照是本检查**唯一的**自我证明手段，故 SELF 从扫描面排除（否则本文件因含此
  // 对照而自报违规），排除带来的盲区由这一段补上。
  const FIXTURE = [
    "const header = new RegExp(`function ${name}\\([^)]*\\) \\{`).exec(BUNDLE)",
    "let depth = 0",
    "for (let i = BUNDLE.indexOf('{', header.index); i < BUNDLE.length; i++) {",
    "  if (BUNDLE[i] === '{') depth++",
    "}",
    "const fn = new Function('model', source)",
  ].join("\n");
  const fixtureHit = readsArtifact("const BUNDLE = readFileSync(u, 'utf8')\n" + FIXTURE)
    && TEMPLATE_HEADER_RE.test(FIXTURE)
    && BRACE_WALK_RE.test(FIXTURE)
    && /new Function\s*\(/.test(FIXTURE);
  if (!fixtureHit) bad("规则层边界：本检查的负向对照未命中——探测器已失效（正则改坏了），上面的全绿不算数");
  // 上一行只证明了**指纹**认得这份 fixture；它没证明 **gate**（readsArtifact）
  // 能在真实世界里认出读产物的测试文件。而 gate 一旦因命名漂移而失配，被审
  // 文件集就静默缩到 0，上面两条断言随即以「没有任何文件违规」的正确理由
  // 全绿——正是 §39 第一版那个坑（两侧集合双双缩水）。实测：把产物变量名
  // 从 BUNDLE 改成 bundle / clientJs / text / src / code，gate 全部失配。
  // 所以这里按**惯用法的多种合理命名**逐个喂，gate 必须都认得。
  const GATE_NAMES = ["BUNDLE", "bundle", "clientBundle", "clientJs", "text", "code", "src"];
  const gateMisses = GATE_NAMES.filter((n) => !readsArtifact(`const ${n} = readFileSync(u, 'utf8')\n${FIXTURE}`));
  if (gateMisses.length > 0) {
    bad(`规则层边界：gate（readsArtifact）只认得 ${GATE_NAMES.length - gateMisses.length}/${GATE_NAMES.length} 种产物变量命名，认不得 ${gateMisses.join(", ")}——换个变量名，被审文件集就缩到 0，本检查会以「零违规」通过（PITFALLS §39）`);
  }
  // 反过来也要成立：不含「读产物」的文件不得被 gate 选中，否则检查会退化成
  // 「扫所有测试文件」，把 build-gate 之类合法读产物做新鲜度检查的用法也判红。
  const gateFalsePositives = [
    "const BUNDLE = 'not read from disk';",
    "const fixture = `function ${name}(x) {`; let depth = 0; depth++; new Function('a', fixture);"
  ].filter((t) => readsArtifact(t));
  if (gateFalsePositives.length > 0) {
    bad(`规则层边界：gate 误选了 ${gateFalsePositives.length} 个不读产物的样本——gate 必须要求 readFileSync 与产物名同时出现，不能只认其一`);
  }
  if (gateMisses.length === 0 && gateFalsePositives.length === 0) {
    guard("RULE_LAYER_BOUNDARY", testFiles.length - 1, 20);
  }
  if (fixtureHit && gateMisses.length === 0 && gateFalsePositives.length === 0 && scrapes === 0 && evals === 0) {
    note(`规则层边界：${pure.length} 个纯模块可 Node 直 import（含 ${PINNED_PURE.join("/")}），${coupled.length} 个含 runtime 耦合；${testFiles.length - 1} 个受检测试文件零「产物抠函数」、零 new Function 求值产物（读产物的 ${artifactReaders} 个仅做装载/新鲜度检查；负向对照命中，gate 7/7 命名均认得）`);
  }
}

// 15) 活文档硬编码计数护栏：现行文档不得断言会随代码漂移的模块数/规模/行数/路由条数/套件规模
// 同源病（PITFALLS §25）：形式全绿、语义已漂。本检查钉的是「活文档里写死代码
// 形状数字」——加一个模块 / 做一次重构，文档就失真，逼出一次纯文档提交。
// 历史·账本·研究档整 file 豁免（它们本就是定格快照，写死数字是如实记录）；
// 其中 ARCHITECTURE §5.4（上游对照）与 ROADMAP（历史重构记录）刻意保留「行数」
// 叙述，故只对这两篇豁免 N 行 子检查，模块数/规模子检查仍生效。
{
  const COUNT_EXEMPT = new Set([
    "ADR.md", "ARCHIVE-BOUNDARY-DECISIONS.md", "CHANGELOG.md",
    // 存档保留「当时 778 行」这类规模快照（§2 的行号清单已随二次拆分全失效），
    // 所以豁免写死数字的检查——但它已**不是**活文档，别据此认为现行规模是那些数。
    "PITFALLS.md", "ARCHIVE-IMPROVEMENTS-2026-09.md", "TOKEN-STORE-SPLIT.md",
  ]);
  // 这两篇活文档保留「上游/历史行数」叙述，只对它们豁免 N 行 子检查
  const LINE_COUNT_OK = new Set(["ARCHITECTURE.md", "ROADMAP.md"]);
  // 路由条数同样随代码漂移（每加一条路由就陈旧一次）。ROADMAP 是历史重构记录，
  // 它的「N 条路由」是那次重构的范围快照而非现行断言——与 N 行 同理豁免。
  const ROUTE_COUNT_OK = new Set(["ROADMAP.md"]);
  // 套件项数**不在**豁免之列，ROADMAP 亦然。与上面两个子检查的区别是承重的：
  // 「那次重构改了哪几条路由」「某段上游对照多少行」是**一次动作的范围快照**，
  // 删掉数字这段历史就说不清；而「某个套件多少项」不是任何一次动作的范围，它是
  // **持续增长的现行规模**，与 `N 万行` 同类。它必然漂、且已经漂过——ROADMAP
  // 同一份文件里同一个套件的项数曾出现两个互相矛盾的值（一次计划估算、一次落地
  // 实测，各自都是当下的真值，却让读者无从判定哪个是终态）。CHANGELOG.md 早有同款
  // 裁定：「消灭『离线 N 套件』
  // 数字漂移源……文档不再背书套件数量与枚举，事实源收敛到 package.json scripts.test」；
  // 本子检查就是把那条规矩变成机器可验的。
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
  // 套件规模：`N 项` / `N checks` / `N 套件`（后者即 CHANGELOG.md 那句「文档不再
  // 背书套件数量与枚举」的另一半），但**仅当同行出现测试语境词**才判红。单看
  // `N 项` 会误伤正常叙述——`docs/API.md` 的「超过 500 项返回 400」是接口限额，
  // 与测试无关（本护栏靠这个合取避开它）。同理只认「项」/「checks」，不认
  // 「N/N 通过」这种分数式实跑结果（那是定格记录，且探针结果本就随真机而变）；
  // 也只用阿拉伯数字，避开「四条路由套件全绿」这种**指定**某几个套件的写法。
  //
  // `N checks` 曾漏过带形容词的形式：token-store 两处注释里的「N live checks」因此
  // 从护栏眼皮底下漂成了假数（`live` 夹在数字与 `checks` 之间，原正则只认紧邻的
  // `N checks`）。这里把形容词设为可选，让任何「N <adj> checks」都被点名——它是
  // 活文档/注释里会漂的计数，被点名正是本护栏的目的。
  // 已知边界（故意不拦）：被换行拆开的计数（如 `N live` 在行尾、`checks` 在下一行）
  // 因逐行匹配而漏检——修法不是把护栏改成跨行，而是别把这种数写进活文档。
  const suiteCountRe = /(?<![A-Za-z0-9])(?:\d+\s*项|\d+\s*(?:[A-Za-z]+\s+)?checks?\b|\d+\s*套件)/g;
  const testCtxRe = /(?:\.test\.mjs|\.mjs|\bchecks?\b|套件|离线|门禁|全绿|npm test|单测|测试)/;
  let scanned = 0;
  let hits = 0;
  for (const f of mdFiles) {
    if (COUNT_EXEMPT.has(basename(f))) continue;
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
      if ((m = line.match(suiteCountRe)) && testCtxRe.test(line)) {
        hits++;
        bad(`${f}:${i + 1} 写死套件规模「${m[0].trim()}」——项数/套件数随测试增补漂移，规模以 \`package.json scripts.test\` 实跑为准，活文档只点名套件与其覆盖面`);
      }
    });
  }
  // 代码注释里同样会点名套件规模，而且这里正是「点名守护物却不校验守护物」
  // （PITFALLS §39）的高发区——本次审计抓到的三处假/漂声明有两处就在代码注释里
  // （client/wire.ts 声称存在而实不存在的门禁、host/llm-models.ts 指错的套件、
  // test/e2e.mjs 注释里那个早已过期的 "all N checks"）。只扫 md 等于只堵一半。代码文件
  // **只跑这一条子检查**：`N 个模块` / `N 行` 在代码注释里语义完全不同
  // （「见第 3 行」「3 个模块参数」），那三条照搬进来必误伤。
  const codeFiles = [];
  const walkCode = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === "node_modules" || name === "lib" || name === "upstream") continue;
      if (statSync(p).isDirectory()) walkCode(p);
      else if (/\.(?:ts|mjs)$/.test(name)) codeFiles.push(p);
    }
  };
  walkCode(join(ROOT, "src"));
  walkCode(join(ROOT, "test"));
  for (const f of codeFiles) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = line.match(suiteCountRe);
      if (m && testCtxRe.test(line)) {
        hits++;
        bad(`${f}:${i + 1} 写死套件规模「${m[0].trim()}」——注释里的项数与真实项数会各自漂移，改以 \`package.json scripts.test\` 实跑为准（同源病：PITFALLS §39 点名守护物却不校验它）`);
      }
    });
  }
  if (hits === 0) note(`活文档计数护栏：受检 ${scanned} 篇现行文档 + ${codeFiles.length} 个代码文件零写死模块数/规模/行数/路由条数/套件规模（历史·账本·研究档 ${COUNT_EXEMPT.size} 篇豁免；ARCHITECTURE/ROADMAP 的 N 行 子检查豁免）`);
  guard("COUNT_GUARD", scanned + codeFiles.length, 30);
}

// === PUBLISHED_VERSION) 发布版本陈述不得低于 package.json ====================
// CONTRIBUTING.md 记着「registry 上最新为 0.4.3」，而 registry 早已是 0.8.1——
// 漂了四个版本，16 条检查一条都不报。它正好落在两条门禁的缝里：`SNAPSHOT` 只读
// docs/DSH-PLUGIN.md 的教学快照，`COUNT_GUARD` 只管「N 行/N 条」这类规模数字、
// 不管版本号。同源病（PITFALLS §39「点名守护物而不校验守护物」）：文档点名了一个
// 每次发版都会变的量，却没有任何东西校验它。
//
// 这里刻意**只做单向判定**：文档声称的版本不得**低于** package.json。理由有两条——
//   - 高于是合法的：0.4.1/0.4.2 打了 tag 未发布、0.8.1 已在 registry 而源码正在
//     往 0.9.0 走，两个方向都有真实的合法情形，双向比对会产生误报；
//   - **npm 上的真实版本必须联网查**，离线门禁不能依赖 registry（CI 也未必有网）。
//     本检查因此不是「registry 的镜像」，它只兜住「文档忘了更新」这一种真实漂移，
//     权威仍然是 registry 本身——CONTRIBUTING.md 已改成让人自己 `npm view` 去查。
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const doc = readFileSync(join(ROOT, "docs", "CONTRIBUTING.md"), "utf8");
  const claimed = [...doc.matchAll(/registry 上最新为\s*\*\*(\d+)\.(\d+)\.(\d+)\*\*/g)];
  if (claimed.length === 0) {
    bad("docs/CONTRIBUTING.md 找不到「registry 上最新为 X.Y.Z」陈述——本检查靠它兜底，该陈述消失时必须同步处理本检查");
  } else {
    const [maj, min, pat] = String(pkg.version).split(".").map(Number);
    let stale = 0;
    for (const m of claimed) {
      const [cmaj, cmin, cpat] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const behind = cmaj < maj || (cmaj === maj && cmin < min) || (cmaj === maj && cmin === min && cpat < pat);
      if (behind) {
        stale += 1;
        bad(`docs/CONTRIBUTING.md 称 registry 最新为 ${cmaj}.${cmin}.${cpat}，低于 package.json 的 ${pkg.version}——发版后忘了同步。以 \`npm view dsh-connect-agnes-token-plan version --registry=https://registry.npmjs.org\` 为权威`);
      }
    }
    if (stale === 0) note(`发布版本陈述 ${claimed.map((m) => `${m[1]}.${m[2]}.${m[3]}`).join("、")} 不低于 package.json ${pkg.version}（registry 真相仍以 npm view 为准）`);
  }
  guard("PUBLISHED_VERSION", claimed.length, 1);
}

// === REF_RESOLVABLE) 文档对「检查 <名>」的引用必须可解析 ====================
// 检查名只存在于本文件的 CHECK_IDS 里，增删一条检查就改集合、不改已有名字。本检查
// 扫全仓 md 把每处「检查 <名>」按同一行上就近的套件名限定作用域：
//   - 指到 docs.test（显式 `docs.test.mjs` 或裸「检查 <名>」）→ 名字必须在名册里；
//   - docs.test 语境出现**数字序号**（如「检查 9」）→ 报红，请改引名字——序号是
//     历史遗留，会随增删漂移（REF_RESOLVABLE 自己就是从数字迁过来的）；
//   - 指到别的套件（如 `test/package.test.mjs 检查 7`）→ 那套件的合法编号不归我们
//     维护，本检查**不越权解析、直接跳过**（否则会拿 package.test 的 7 误判）。
// 形如 `检查 docs/DSH-PLUGIN.md` 不是检查引用，静默跳过（名字只认全大写下划线形、
// 且至少 2 字符——单字母如「检查 N」是占位短语，不是引用）。
const scopeRe = /([A-Za-z0-9_.-]+\.test\.mjs)/g;
const refRe = /检查\s*([`'"\[\]A-Za-z0-9_/／、]+)/g;
const CHECK_NAMES = new Set(CHECK_IDS.keys());
{
  const dangling = [];
  let resolved = 0;
  let deprecated = 0;
  let skipped = 0;
  for (const f of mdFiles) {
    const text = readFileSync(f, "utf8");
    refRe.lastIndex = 0;
    let m;
    while ((m = refRe.exec(text)) !== null) {
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const lineEnd = text.indexOf("\n", m.index);
      const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
      const scoped = [...line.matchAll(scopeRe)].pop();
      if (scoped && scoped[1] !== "docs.test.mjs") { skipped++; continue; }
      const tokens = m[1].replace(/[`"'\[\]]/g, "").split(/[/／、]/).map((t) => t.trim()).filter(Boolean);
      for (const tok of tokens) {
        // 名字只在 docs.test 名册里，见到即确定作用域——同一行若也提到别的套件
        // （如 PITFALLS §39 那句既写 `contract.test.mjs` 又写「检查 14」），就近匹配
        // 会误判，所以**名字不看作用域**、只有数字序号才靠就近套件名判定。
        if (CHECK_NAMES.has(tok)) { resolved++; continue; }
        const inDocsScope = !scoped || scoped[1] === "docs.test.mjs";
        if (!inDocsScope) { skipped++; continue; }
        if (/^\d+$/.test(tok)) {
          deprecated++;
          dangling.push(`${f} 用数字序号「检查 ${tok}」——docs.test 的检查请改引名字（如 \`检查 LINKS\`），序号会随增删漂移`);
          continue;
        }
        if (/^[A-Z][A-Z0-9_]{1,}$/.test(tok)) {
          dangling.push(`${f} 引用「检查 ${tok}」——不在 docs.test 检查名册（${[...CHECK_NAMES].join("/")}）里：要么是增删检查后没同步，要么指错了套件`);
        }
      }
    }
  }
  if (dangling.length) dangling.forEach(bad);
  else note(`检查引用可解析：${resolved} 处 docs.test 语境命名引用命中、数字序号 0 处（${deprecated} 处数字已全部迁移；另 ${skipped} 处指到别的套件，本检查不越权）`);
  guard("REF_RESOLVABLE", resolved, 5);
}

// 本文件自己的存活守卫（PITFALLS §39：守护物失效时谁会喊）
//
// `guard()` 给每条检查配了「受检量下限」，但下限本身要有人守：一条**新增**的
// 检查若没声明自己的受检面，就等于回到「扫到 0 条也算通过」的老形状，而
// 「它没登记」这件事本身是可机械查的。新增检查必须同时登记受检量，或在此
// 显式豁免并写明理由——不允许静默缺失。
{
  const EXEMPT = new Map([
    ["SNAPSHOT", "锚点判活写在检查体内（snipFiles 非空 + 与 package.json 对比）"],
    ["API_SNAPSHOT", "锚点判活由 ANCHORS + parserLive 承担（§39 第一版教训的修复处）"]
  ]);
  const missing = [...CHECK_IDS.keys()].filter((id) => !guards.has(id) && !EXEMPT.has(id));
  if (missing.length > 0) {
    bad(`新增检查未声明存活守卫：${missing.join(", ")}——请在该检查后调用 guard("<名字>", <受检量>, <下限>)，或在本段 EXEMPT 里写明理由（PITFALLS §39）`);
  }
  const declared = [...guards.entries()].map(([id, g]) => `${id}:${g.scanned}/${g.floor}`);
  note(`存活守卫覆盖 ${guards.size}/${CHECK_IDS.size} 条检查（${declared.join(" ")}）；另 ${EXEMPT.size} 条由各自锚点断言承担`);
}

if (fails.length) {
  console.error(`\n❌ docs.test.mjs 失败 ${fails.length} 项：`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✅ docs.test.mjs 全部通过\n");
