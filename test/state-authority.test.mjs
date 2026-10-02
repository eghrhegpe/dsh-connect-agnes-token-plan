/**
 * 状态权威判据护栏 —— 「事实判据 vs 预测判据」（PITFALLS §40 的推广）。
 *
 * 为什么有这个套件：§40 的教训是「每一次正确地吞掉一个错误，都可能在调用方
 * 制造一个新的静默面」。它的机制可以一般化为一条**可检查的结构约束**：
 *
 *   一个用于「记住上次做过什么、以决定这次要不要重做」的状态字段，
 *   如果它的写入**不与它所描述的持久化动作同生共死**，它就会在写盘失败后
 *   开始描述一个磁盘上并不存在的世界，而它的用途恰是「相等就跳过」——
 *   于是永久跳过，面板与实际注册分叉。
 *
 * 本套件钉的是这条**形状**，不是某个具体文件：
 *   A. 预测判据（signature 类）的每个写入点，必须**同时**出现在一个已声明的
 *      「同生共死」清单里——清单是显式白名单，新增一处就必须来过这一关。
 *   B. 白名单里的每一处，其上下文必须**邻近一个写盘动作**（catalogStore 的
 *      replace/setEnabledIds/clear 或 writeStateFile），否则它仍然是「内存先行」。
 *   C. 事实判据（registered / isFresh 类）不受此限——它们由动作本身写入，
 *      不存在预测与现实脱节的窗口。这条检查**只盯预测判据**，避免误伤。
 *
 * 纯离线、peer-free：文本扫描 `src/host`，不 import 任何运行时模块。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src", "host");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok" : "  fail"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** 递归收集 src/host 下的 .ts 文件（含 routes/、token-store/ 等子目录）。 */
function collectTs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectTs(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = collectTs(SRC).sort();

/**
 * 「预测判据」的写法特征：把某个 signature/记忆字段赋成「当前内容的摘要」。
 * 只匹配**赋值点**，不匹配读取点（读取点无需与写盘同生共死）。
 */
const PREDICTIVE_ASSIGN = /(?:providerState|publisher\.state|state)\.signature\s*=|\.state\.signature\s*=/;

/**
 * 显式白名单：预测判据的每一个允许存在的写入点。
 *
 * 每一处都必须满足：**赋值语句的邻近行里有一个写盘动作**，或该赋值本身
 * 就是对「已落盘事实」的镜像（如 seed 从磁盘读回后同步内存）。
 * key 为仓库相对路径（正斜杠），value 为允许的处数。
 */
const SANCTIONED = new Map([
  // §40 方案②已落地：`replace()`/`setEnabledIds()` 返回「是否真的落盘」，两处签名
  // 只在落盘成功后才推进——写盘失败时签名停在旧值，下一次轮询会重试写盘并重发。
  ["src/host/snapshot-aggregate.ts", { count: 1, why: "轮询去抖；仅 replace 落盘成功才推进签名（PITFALLS §40 方案②）" }],
  ["src/host/routes/models.ts", { count: 1, why: "save 后采用刚下发的签名；仅 setEnabledIds 落盘成功才推进（§40 方案②）" }],
  ["src/host/routes/api-key.ts", { count: 1, why: "清除 key 时置空签名，强制下次重注册" }],
  // seed 是「从磁盘读回后同步内存」——方向相反，不是预测。
  ["src/host/provider-publish.ts", { count: 1, why: "seed：从磁盘读回事实，方向与预测相反" }],
]);

/** 邻近行内是否出现写盘动作。 */
const WRITE_ACTION = /catalogStore\.(replace|setEnabledIds|clear)\s*\(|writeStateFile\s*\(|publisher\.publish\s*\(/;

const found = [];
for (const file of files) {
  // 仓库相对路径一律正斜杠，供 SANCTIONED 白名单比对——但归一化必须**跨平台**：
  // `relative()` 在 Windows 给 `\`、在 Linux 给 `/`，只换 `\` 在两边都成立。
  const rel = relative(ROOT, file).split(/[\\/]/).join("/");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!PREDICTIVE_ASSIGN.test(line)) return;
    if (/^\s*(\*|\/\/)/.test(line)) return; // 注释里的示例不算
    const near = lines.slice(Math.max(0, i - 4), i + 5).join("\n");
    found.push({ rel, line: i + 1, near, hasWrite: WRITE_ACTION.test(near) });
  });
}

// ── A. 每个写入点都必须在白名单里（新增一处即来此过堂） ──────────────────
{
  const byFile = new Map();
  for (const hit of found) byFile.set(hit.rel, (byFile.get(hit.rel) ?? 0) + 1);

  const unknown = [...byFile.keys()].filter((rel) => !SANCTIONED.has(rel));
  check(
    "预测判据的每个写入点都在已声明清单里",
    unknown.length === 0,
    unknown.length ? `未登记：${unknown.join(", ")}（新增预测判据请先来本套件说明其权威归属与失败取向）` : `${found.length} 处全部在册`
  );

  for (const [rel, spec] of SANCTIONED) {
    const n = byFile.get(rel) ?? 0;
    check(
      `${rel} 的写入处数未漂移`,
      n === spec.count,
      `期望 ${spec.count} 处，实到 ${n} 处${n === spec.count ? "" : "（改了这个文件就更新清单，别让清单变成过期承诺）"}`
    );
  }
}

// ── B. 白名单里每一处的上下文必须可见或邻近写盘 ──────────────────────────
// 「可见或可自愈」的判据：邻近要么有写盘动作（同生共死），要么有显式降级注释。
{
  let visible = 0;
  for (const hit of found) {
    if (!SANCTIONED.has(hit.rel)) continue;
    const commented = /\/\/|\*/.test(hit.near);
    const ok = hit.hasWrite || commented;
    if (ok) visible += 1;
    check(
      `${hit.rel}:${hit.line} 的权威归属可辨`,
      ok,
      ok
        ? hit.hasWrite ? "邻近写盘动作" : "有显式注释说明降级取向"
        : "既无写盘动作、也无注释——读者无法判断它是「预测」还是「事实」"
    );
  }
  if (visible === found.length) {
    console.log(`  note  ${found.length} 处预测判据的权威归属全部可辨`);
  }
}

// ── C. 事实判据不得被本检查牵连（负向：确认它没被误伤） ──────────────────
// `registered` 由注册动作在成功路径写入（publish-core.ts），是事实判据；
// 若它出现在 PREDICTIVE_ASSIGN 的命中里，说明正则写宽了。
{
  const misfired = found.filter((hit) => /\.registered\s*=/.test(hit.near) && !/signature/.test(hit.near));
  check(
    "事实判据未被误伤（registered 不在预测判据命中里）",
    misfired.length === 0,
    misfired.length ? `误伤：${misfired.map((h) => `${h.rel}:${h.line}`).join(", ")}` : "零误伤"
  );
}

// ── E. 身份判据：推进必须可恢复（PITFALLS §42） ──────────────────────────
// `signature` 是「预测判据」，权威在磁盘。但两个 publisher 的 state 里还有另一
// 类字段——entries / enabledIds / unavailableIds / rows / bffBase——它们是
// **「当前在服务的注册是什么」**，权威在注册动作本身，不在磁盘。
//
// 这一族的病与 §40 同形但判据不同：把它们推进到新值之后，任何「没有产生新
// 注册」的路径都必须把它们放回去，否则快照（直接读 `state.entries`）会报出一
// 份从未注册过的目录，而 `registered` 仍为 true —— 把分叉伪装成在服务。
//
// 机械判据锚在**机制**上而非函数名：`describeBuildFailure(` 与 `warnBuildFailure(`
// 之间那段就是「构建失败」的 catch 体（两者只在该处成对出现），它必须恢复身份。
// 锚函数名会随改名静默失效，锚「描述失败 → 告警」这对真实动作不会。
{
  const IDENTITY_PUBLISHERS = {
    "src/host/provider-publish.ts": ["entries", "enabledIds", "unavailableIds"],
    "src/host/agnescode-publish.ts": ["rows", "bffBase"]
  };
  for (const [rel, fields] of Object.entries(IDENTITY_PUBLISHERS)) {
    const lines = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
    const text = lines.join("\n");

    // E1. 每个身份字段都必须有唯一的恢复出口，且它恢复全部字段。
    //
    // 块体用**缩进扫描**取，不用 `[\s\S]*?\n {2}\};` 这类正则：那一版会从
    // 多余空格的第 3 位开始匹配，把闭括号之后、函数体外的推进赋值一起吞进
    // 「恢复体」——于是删掉 restoreIdentity 里的一行，字段检查仍靠外面那行
    // 推进赋值而假绿。这正是 PITFALLS §39 的形状（守护物失配后以错误理由
    // 通过），只不过这次是护栏自己得的。缩进扫描对 2/4 空格都成立。
    const startAt = lines.findIndex((l) => /const restoreIdentity = \(\) => \{/.test(l));
    check(`${rel}: 身份有单一恢复出口 restoreIdentity`, startAt !== -1);
    if (startAt === -1) continue;
    const declIndent = (lines[startAt].match(/^\s*/) ?? [""])[0].length;
    const body = [];
    for (let i = startAt + 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "") continue;
      if ((lines[i].match(/^\s*/) ?? [""])[0].length <= declIndent) break;
      body.push(lines[i]);
    }
    const bodyText = body.join("\n");
    // 存活守卫：块体必须闭在函数内，且**不含**闭括号之后的任何内容。少了它，
    // 缩进扫描一旦失配就会退化成「扫全文」，而下面那条覆盖检查照样全绿。
    check(`${rel}: 恢复体止于函数内（块提取未越界吞入推进赋值）`,
      body.length > 0 && !body.some((l) => /^\s*(state\.\w+\s*=|const |return |if )/.test(l) && (l.match(/^\s*/) ?? [""])[0].length <= declIndent),
      `块体 ${body.length} 行，最大缩进 ${Math.max(0, ...body.map((l) => (l.match(/^\s*/) ?? [""])[0].length))}（声明级 ${declIndent}）`);
    const uncovered = fields.filter((f) => !new RegExp(`state\\.${f}\\s*=`).test(bodyText));
    check(`${rel}: restoreIdentity 覆盖全部身份字段`, uncovered.length === 0,
      uncovered.length ? `未覆盖：${uncovered.join(", ")}` : fields.join(", "));

    // E2. 构建失败的 catch 体必须调用它。`describeBuildFailure(` 与
    // `warnBuildFailure(` 只在这段成对出现，所以这是一个机制锚。
    const catchStart = text.indexOf("describeBuildFailure(");
    const warnAt = text.indexOf("warnBuildFailure(", catchStart);
    check(`${rel}: 找得到构建失败 catch 体（机制锚存活）`, catchStart !== -1 && warnAt > catchStart,
      `describe@${catchStart} warn@${warnAt}`);
    if (catchStart === -1 || warnAt === -1) continue;
    const catchBody = text.slice(catchStart, warnAt);
    check(`${rel}: 构建失败时恢复身份（否则快照报出未注册的目录）`,
      /restoreIdentity\(\)/.test(catchBody),
      /restoreIdentity\(\)/.test(catchBody)
        ? "已恢复"
        : "这段 catch 只写了 state.error —— 旧 adapter 还在服务，而 state.entries 指向新目录");
  }
}

// ── F. 护栏自身的存活守卫（PITFALLS §39：守护物失效时谁会喊） ────────────
// 若正则失配、扫描面为空，以上断言会以完全错误的理由通过——这里把它顶掉。
{
  check("扫描面非空（护栏自身存活）", files.length > 10, `扫到 ${files.length} 个 .ts`);
  check("预测判据命中数非零（正则未失配）", found.length > 0, `命中 ${found.length} 处`);
  // 分隔符归一化：本仓在 Windows 开发、在 Linux runner 上跑 CI，`relative()`
  // 给出的分隔符随平台变（`\` vs `/`）。第一版硬切 `"\\"`，于是 Linux 上
  // 整条 `routes/account.ts` 不被切开、集合里没有 `routes` 这一项，这条存活
  // 守卫在**本机绿、CI 红**——正是 PITFALLS §32 说「本机全绿不算门禁」的活体。
  const topOf = (abs) => relative(SRC, abs).split(/[\\/]/)[0];
  const scannedDirs = new Set(files.map(topOf));
  check(
    "递归覆盖子目录（routes/ 等未被漏掉）",
    scannedDirs.has("routes"),
    `顶层项：${[...scannedDirs].join(", ")}`
  );
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
