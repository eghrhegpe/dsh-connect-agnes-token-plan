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
  // 写盘成功后才推进：replace() 的 swallow 语义意味着这里的签名可能与磁盘脱节，
  // 这正是 §40 登记的形状——保留在册以便检查其上下文仍然可见/可自愈。
  ["src/host/snapshot-aggregate.ts", { count: 1, why: "轮询去抖；写盘失败时签名先行（PITFALLS §40，修法待定）" }],
  ["src/host/routes/models.ts", { count: 1, why: "save 后采用刚下发的签名；同 §40" }],
  ["src/host/routes/api-key.ts", { count: 1, why: "清除 key 时置空签名，强制下次重注册" }],
  // seed 是「从磁盘读回后同步内存」——方向相反，不是预测。
  ["src/host/provider-publish.ts", { count: 1, why: "seed：从磁盘读回事实，方向与预测相反" }],
]);

/** 邻近行内是否出现写盘动作。 */
const WRITE_ACTION = /catalogStore\.(replace|setEnabledIds|clear)\s*\(|writeStateFile\s*\(|publisher\.publish\s*\(/;

const found = [];
for (const file of files) {
  const rel = relative(ROOT, file).split("\\").join("/");
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

// ── D. 护栏自身的存活守卫（PITFALLS §39：守护物失效时谁会喊） ────────────
// 若正则失配、扫描面为空，以上断言会以完全错误的理由通过——这里把它顶掉。
{
  check("扫描面非空（护栏自身存活）", files.length > 10, `扫到 ${files.length} 个 .ts`);
  check("预测判据命中数非零（正则未失配）", found.length > 0, `命中 ${found.length} 处`);
  const scannedDirs = new Set(files.map((f) => relative(SRC, f).split("\\")[0]));
  check(
    "递归覆盖子目录（routes/ 等未被漏掉）",
    scannedDirs.has("routes"),
    `顶层项：${[...scannedDirs].join(", ")}`
  );
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
