/**
 * 开关优先级（switch-precedence）的离线检查。
 *
 * 这条规则此前被手抄在 11 处，且有两种长得几乎一样的方言：
 *   A. `(panel ?? settings.x) === true`  —— 有配置默认（provider / draw / video）
 *   B. `panel === true`                  —— 无配置默认（agnescode）
 * 两者靠肉眼分辨不出来，而混淆它们不是排版问题：把 B 读成 A，AgnesCode 会在
 * 补丁哪天多出一个默认值时自己注册起来。所以本套件钉的是**两种语义的分界**，
 * 而不只是"面板值优先"。
 *
 * 顺带钉住两个被这次收敛暴露出来的真实缺陷：
 *   1. `readPanelValue` 必须能安全接受"缺席的 store"。旧写法
 *      `(store ? store.enabled() : null).catch(() => null)` 在 store 缺席时
 *      是对 `null` 调 `.catch` —— 抛 TypeError，而不是回答 null。它此前没炸
 *      只是因为当前的调用方都恰好传了 store。
 *   2. 快照里 draw / video 各被读了两次（一次取值、一次取来源），两次 await
 *      之间状态一变就会输出 `true` 却标注来源为 config。这里用"每次读返回
 *      不同值"的伪 store 证明新写法只读一次。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installNetworkGuard } from "./peer-roots.mjs";
import {
  SWITCH_SOURCE,
  readPanelValue,
  resolveSwitchEnabled,
  resolveSwitchValue
} from "../src/host/switch-precedence.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail ?? "") });
}

installNetworkGuard();

const SRC = join(import.meta.dirname, "..", "src", "host");

// ── 探测器：`key` 是否被当作开关的 config 实参裁决了 ────────────────────
// 括号配平扫描，从 `resolveSwitchEnabled(` / `resolveSwitchValue(` 起，跨过
// **任意** 括号与换行直到配平的闭括号，在这段实参里找 `key`。
//
// 为什么不用 `resolveSwitch(?:Enabled|Value)\([^)]*<key>`：`[^)]*` 跨不过
// 闭括号，而本仓 6 个调用点的首个实参都是 `await readPanelValue(...)`——内含
// 括号——所以最真实的那个形态恰好是它**唯一**漏掉的形态（`docs.test.mjs`
// 里的 `BRACE_WALK_RE` 是同一个教训的另一处应用：花括号深度比字符类可靠）。
// 负向对照在下方，与本函数同处一段。
function arbitratesSwitchOver(body, key) {
  const OPEN = /resolveSwitch(?:Enabled|Value)\(/g;
  for (let m = OPEN.exec(body); m !== null; m = OPEN.exec(body)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < body.length && depth > 0; i++) {
      const c = body[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    if (body.slice(m.index + m[0].length, i).includes(key)) return true;
    OPEN.lastIndex = i; // 从配平处继续，避免嵌套调用把外层重复扫一遍
  }
  return false;
}

/** 递归列出目录下的 `.ts`（相对路径），子目录一并收——分母不许静默缩小。 */
function walkTs(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkTs(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

// ── 1. A 型：有配置默认 ---------------------------------------------------
// 面板保存的值无论真假都赢，来源一律是 panel —— 面板"关掉"必须能压住配置的"开"。
{
  check("A：面板 true 压住配置 false",
    resolveSwitchEnabled(true, false).enabled === true &&
      resolveSwitchEnabled(true, false).source === SWITCH_SOURCE.PANEL);
  check("A：面板 false 也压住配置 true（关掉必须生效）",
    resolveSwitchEnabled(false, true).enabled === false &&
      resolveSwitchEnabled(false, true).source === SWITCH_SOURCE.PANEL,
    `实到 ${JSON.stringify(resolveSwitchEnabled(false, true))}`);
  check("A：未设置 + 配置 true → 开，来源 config",
    resolveSwitchEnabled(null, true).enabled === true &&
      resolveSwitchEnabled(null, true).source === SWITCH_SOURCE.CONFIG);
  check("A：未设置 + 配置 false → 关，来源 config",
    resolveSwitchEnabled(null, false).enabled === false &&
      resolveSwitchEnabled(null, false).source === SWITCH_SOURCE.CONFIG);
  check("A：undefined 与 null 同义（未设置）",
    resolveSwitchEnabled(undefined, true).source === SWITCH_SOURCE.CONFIG,
    `实到 ${resolveSwitchEnabled(undefined, true).source}`);
}

// ── 2. B 型：无配置默认（AgnesCode）---------------------------------------
// 这才是两种方言的分界：未设置必须落到 off，绝不是回落到某个默认值。
{
  check("B：面板 true → 开，来源 panel",
    resolveSwitchEnabled(true).enabled === true &&
      resolveSwitchEnabled(true).source === SWITCH_SOURCE.PANEL);
  check("B：面板 false → 关，来源 panel",
    resolveSwitchEnabled(false).enabled === false &&
      resolveSwitchEnabled(false).source === SWITCH_SOURCE.PANEL);
  check("B：未设置 → 关，来源 off（不是 config）",
    resolveSwitchEnabled(null).enabled === false &&
      resolveSwitchEnabled(null).source === SWITCH_SOURCE.OFF,
    `实到 ${JSON.stringify(resolveSwitchEnabled(null))}。若来源是 config 就等于凭空认了一个没人声明的默认值`);
  // 反事实：把 B 错写成 A 会怎样。传 undefined 不是传 false —— 传 false 会让
  // 来源变成 config，而 AgnesCode 根本没有配置默认可指。
  check("B：传 undefined 与传 false 不同（后者会伪造出一个来源）",
    resolveSwitchEnabled(null).source === SWITCH_SOURCE.OFF &&
      resolveSwitchEnabled(null, false).source === SWITCH_SOURCE.CONFIG,
    `undefined→${resolveSwitchEnabled(null).source} / false→${resolveSwitchEnabled(null, false).source}`);
  // 非布尔的脏值不能把开关打开：来源必须仍是 off，绝不能"认不出就当真"。
  check("B：脏值（字符串 / 对象）不会被当成 true",
    resolveSwitchEnabled("yes").enabled === false &&
      resolveSwitchEnabled({}).enabled === false &&
      resolveSwitchEnabled(1).enabled === false,
    `实到 ${JSON.stringify(resolveSwitchEnabled("yes"))}`);
}

// ── 3. model 偏好："" 与 null 是两件事 ------------------------------------
// "" 是"自动挑选"，null 是"没设置过"。混为一谈会把"操作员要自动"读成"没设置"。
{
  check("model：面板 '' 是真实值（自动挑选），来源是 panel",
    resolveSwitchValue("", "cfg-model").value === "" &&
      resolveSwitchValue("", "cfg-model").source === SWITCH_SOURCE.PANEL);
  check("model：面板 null → 回落配置默认，来源 config",
    resolveSwitchValue(null, "cfg-model").value === "cfg-model" &&
      resolveSwitchValue(null, "cfg-model").source === SWITCH_SOURCE.CONFIG);
  check("model：面板值压住配置默认",
    resolveSwitchValue("panel-model", "cfg-model").value === "panel-model");
}

// ── 4. readPanelValue：缺席 / 抛错 / 返回 undefined 都得回答 null ----------
{
  const absent = await readPanelValue(undefined);
  const nullish = await readPanelValue(null);
  check("readPanelValue：缺席的 store 回答 null（旧写法会抛 TypeError）",
    absent === null && nullish === null,
    `实到 ${JSON.stringify(absent)} / ${JSON.stringify(nullish)}`);

  // 缺席的 store 用可选链传进来时同样安全（箭头函数返回 undefined）。
  const viaOptional = await readPanelValue(async () => (await undefined) ?? null);
  check("readPanelValue：可选链拿到 undefined 也回答 null", viaOptional === null);

  const throwing = await readPanelValue(async () => {
    throw new Error("state dir unreadable");
  });
  check("readPanelValue：读失败降级为 null（不把请求打挂）", throwing === null,
    `实到 ${JSON.stringify(throwing)}`);

  // 旧写法在这里会崩：store 为 null 时 `null.catch` 是 TypeError。
  let threw = false;
  try {
    await null.catch(() => null);
  } catch {
    threw = true;
  }
  check("对照：旧写法 `(store ? ... : null).catch()` 确实会抛（证明上面那条不是空话）",
    threw === true,
    "若这条变绿说明 JS 语义变了，上面那条的降级才有别的解释");

  const passthrough = await readPanelValue(async () => false);
  check("readPanelValue：false 原样透传（不是被当成未设置）", passthrough === false);
}

// ── 5. 只读一次：值与其来源必须来自同一个读 --------------------------------
{
  let calls = 0;
  let flip = false;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) return true;
    flip = true;
    return null; // 第二次读"失败"了
  };
  const resolved = resolveSwitchEnabled(await readPanelValue(flaky), false);
  check("只读一次：值已读出后不再二次求值", calls === 1 && flip === false,
    `实到 ${calls} 次调用`);
  // 如果还按旧写法读两次，第二次返回 null 会让来源变成 config，而值是 true ——
  // 面板会显示"true（来自配置）"，而配置其实是 false。
  check("只读一次：值与来源不会互相矛盾",
    resolved.enabled === true && resolved.source === SWITCH_SOURCE.PANEL,
    JSON.stringify(resolved));
}

// ── 6. 接线钉：手抄的 11 处都已改为调用本模块 ------------------------------
// 这条是"收敛是否到位"的判据：任何一处还在自己写 `?? settings.x` 就会红。
{
  const files = readdirSync(SRC)
    .filter((f) => f.endsWith(".ts"))
    .concat(readdirSync(join(SRC, "routes")).filter((f) => f.endsWith(".ts")).map((f) => `routes/${f}`));

  // 必须剥掉注释再匹配：本次收敛特意在几处注释里留下了"旧写法长什么样"，
  // 那是给后来人看的反例，不是新的手抄。第一版正则就命中了它们。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const handRolled = [];
  for (const rel of files) {
    if (rel === "switch-precedence.ts") continue; // 本模块自己的文档里引了旧写法
    const body = stripComments(readFileSync(join(SRC, rel), "utf8"));
    // 手抄的特征：把面板值与配置默认用 ?? 拼在一起，或单独判 === null 定来源。
    const own = /\?\?\s*(?:settings|effectiveSettings|configEnabled)\b/.test(body) ||
      /panelSwitch === null \?|switchState === null \?|panelEnabled === null \?/.test(body);
    if (own) handRolled.push(rel);
  }
  check("不再有任何文件自己拼装优先级（11 处手抄已收敛）",
    handRolled.length === 0,
    `仍在手抄：[${handRolled.join(", ")}]`);

  const users = files.filter((rel) => {
    // 同样要剥注释：模块头与 `CONFIG_DEFAULTS.writeImageModelIds` 的说明里
    // 引用了本模块的名字（"它刻意不在 switch-precedence.ts 里"），那是给读者
    // 的说明，不是新的依赖边。第一版没剥，把 9 数成了 10。
    const body = stripComments(readFileSync(join(SRC, rel), "utf8"));
    return body.includes("switch-precedence.ts");
  });
  check("改用本模块的消费方至少覆盖曾手抄过的 9 个文件", users.length >= 9,
    `实到 [${users.sort().join(", ")}]`);

  // 这条是**粗筛**，不是"手抄"的守门人（上面那条 `handRolled` 才是，它带
  // 剥注释 + 特征正则，实测把某个消费方改回手抄时由它点名）。这条只在消费方
  // **完全脱离**本模块时红——手抄回退时文件仍然 import 着 `readPanelValue`，
  // 提及数不变，它不响。它的作用是"别把整条收敛删干净"，不是"手抄没回来"。
  check("收敛未整体撤销（消费方没有全部脱离本模块）", users.length >= 9,
    `实到 [${users.sort().join(", ")}]`);

  // 反过来：AgnesCode 的三处必须传"无默认"，否则它哪天会自己注册起来。
  const agnescodeFiles = ["agnescode-publish.ts", "agnescode-lifecycle.ts", "routes/agnescode.ts"];
  const wrongDefault = agnescodeFiles.filter((rel) => {
    const body = readFileSync(join(SRC, rel), "utf8");
    return /resolveSwitchEnabled\([^)]*settings\./.test(body) ||
      /resolveSwitchEnabled\(await readPanelValue\([^)]*\),\s*[a-zA-Z]/.test(body);
  });
  check("AgnesCode 三处都按「无配置默认」解析", wrongDefault.length === 0,
    `传了配置默认：[${wrongDefault.join(", ")}]`);

  // ── 6. `writeImageModelIds` 刻意不在这 9 个消费方里 ──────────────────
  // 上面那 9 个是**有面板一半**的开关：从 `switch-store` 的文件与补丁默认值两处
  // 仲裁，所以需要本模块。`writeImageModelIds` 只有补丁一个来源——面板侧
  // （`src/client/`）零引用，没有 state 文件、没有路由——把它塞进来只会造出一个
  // `panel → null → config` 的空转折叠，看上去齐整、什么也不决定。
  //
  // 它因此**看起来**像第五个开关（同样"默认关、失败降级、只碰自己那一份"），
  // 分类不落地就会有人去"补齐"它。这条检查是那句注释的存活守卫：真去改的那天，
  // 它会在这里红，并要求先想清楚面板 affordance 到底存不存在。
  {
    // 判据是"不经由本模块裁决"，不是"代码里不许读"——`lifecycle.ts` 当然要读
    // `settings.writeImageModelIds`，那正是这个 opt-in 的执行点。要禁的是
    // 把它接进 `resolveSwitchEnabled`（面板 → null → config 的空转折叠）。
    const consumers = users.filter((rel) => rel !== "host-config.ts");
    const arbitrated = consumers.filter((rel) => {
      const body = stripComments(readFileSync(join(SRC, rel), "utf8"));
      return arbitratesSwitchOver(body, "writeImageModelIds");
    });
    check("writeImageModelIds 不经由开关裁决（它没有面板一半）", arbitrated.length === 0,
      `被当开关仲裁了：[${arbitrated.join(", ")}]`);

    // 探测器的存活守卫（PITFALLS §39：点名守护物而不校验守护物本身）。
    //
    // 第一版用 `/resolveSwitch(?:Enabled|Value)\([^)]*writeImageModelIds/`，
    // 而 `[^)]*` **跨不过闭括号**。代码库里 6 个调用点**全是嵌套形态**（首个
    // 实参是 `await readPanelValue(...)`，内含括号），扁平形态一个都没有——所以
    // 最自然的编辑（保留嵌套、只把第二实参换成 `writeImageModelIds`）**漏**，
    // 而提交信息里那条"负向：接进 resolveSwitchEnabled → 守卫点名"是假的。
    //
    // 两条负向对照钉住探测器：嵌套（真实形态）必须命中，扁平也必须命中，且
    // 跨行/跨括号都要命中。对照不是装饰——它是这个探测器唯一的存活证据。
    const nested =
      'resolveSwitchEnabled(\n  await readPanelValue(async () => (await store?.enabled()) ?? null),\n' +
      '  settings.writeImageModelIds as boolean\n);';
    const flat = 'resolveSwitchEnabled(null, settings.writeImageModelIds);';
    const crossLine = 'resolveSwitchEnabled(\n  await readPanelValue(x),\n  settings\n    .writeImageModelIds\n);';
    const unrelated = 'resolveSwitchEnabled(await readPanelValue(panelSwitch), settings.registerProvider);';
    check("探测器：嵌套实参命中（代码库里的唯一真实形态）", arbitratesSwitchOver(nested, "writeImageModelIds"), "nested 漏");
    check("探测器：扁平实参命中", arbitratesSwitchOver(flat, "writeImageModelIds"), "flat 漏");
    check("探测器：跨行 + 跨括号命中", arbitratesSwitchOver(crossLine, "writeImageModelIds"), "crossLine 漏");
    check("探测器：无关调用不误报", arbitratesSwitchOver(unrelated, "writeImageModelIds") === false, "误报");

    // 执行点仍在（`visionPublish` 读它决定是否写回），钉住"没被顺手删掉"。
    const lifecycle = stripComments(readFileSync(join(SRC, "lifecycle.ts"), "utf8"));
    check("它的执行点仍在（visionPublish 仍读这个 opt-in）",
      lifecycle.includes("settings.writeImageModelIds"), "lifecycle.ts 不再读它了");

    // 前提本身也要钉：面板侧真的没有这个开关。没有它，上面那条检查会因为
    // "反正没人用"而恒绿——而那正是它要防的沉默。
    //
    // 递归扫：同仓 `docs.test.mjs` 的 `walk()` 与本文件上面数消费方的
    // `.concat(readdirSync(join(SRC, "routes")))` 都是递归的。`src/client`
    // 今天 20 个 `.ts` 全在顶层（0 子目录），非递归此刻不漏——但那是结构
    // 巧合，不是门禁保证：明天建个子目录，分母会静默缩小（PITFALLS §25）。
    const clientDir = join(import.meta.dirname, "..", "src", "client");
    const clientHits = walkTs(clientDir)
      .filter((rel) => rel !== "switch-precedence.ts")
      .filter((rel) => stripComments(readFileSync(join(clientDir, rel), "utf8")).includes("writeImageModelIds"));
    check("面板确实没有这个开关（递归扫描，所以它没有面板一半）", clientHits.length === 0,
      `面板里出现了：[${clientHits.join(", ")}]`);
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
