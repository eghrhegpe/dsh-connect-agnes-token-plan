/**
 * Peer 契约护栏 —— 把 "peer 改拼接格式就静默漏纠" 变成可见红（docs/IMPROVEMENTS.md §3.3①）。
 *
 * `llm-error-fix.js` 依赖 peer 的 message 拼接格式：非 2xx 时 pi-ai 把整段 JSON body
 * 拼进 `errorMessage`（`<status>: <body>`，见 `@earendil-works/pi-ai/dist/utils/
 * error-body.js:15-30,63-76,111-118`：OpenAI SDK 的 `error.error`（parsed JSON 对象）
 * 经 `safeJsonStringify` 转回 JSON 字符串作 body）。本套件在**真实 peer 可达时**
 * （`findPeerRoot()` 本地解析，见 test/peer-roots.mjs 头注）钉死这条端到端行为契约；
 * peer 缺席（干净检出/CI）则 SKIP——与 `npm test` 离线门禁兼容。有真实 Host 的机器
 * （本机）会真跑。
 *
 * 误判机制（2026-09-29 实测修正原稿 §3.1③）：
 *   - peer 的 `isQuotaExceededError`（`@deepseek-ai/dsh-llm/lib/types/error.js:76-82`）
 *     命中**message 文本里的硬额度措辞**（`quota exceeded` 空格分隔、`out of
 *     credits/budget` 等）；
 *   - **类型名 `quota_exceeded_error` 本身不触发**——末尾 `\b` 词边界不穿透 `_`
 *     （`_` 是 word 字符）：实测 `isQuotaExceededError('quota_exceeded_error') === false`。
 *
 * 三段断言（失败信息都指向下一步该做什么）：
 *   A. 端到端纠正（应恒真）：对 peer 拼好的 message（**额度措辞 + 速率信号** + quota
 *      类型名，即 peer 会误判 QUOTA 的体），`shouldReclassifyQuotaToRate` 为 true、
 *      `reclassifyFinish` 把 QUOTA 纠正回 RATE_LIMIT 且保留原 message；真配额耗尽与
 *      peer 已判 RATE_LIMIT 的体原样放行（引用相等）。
 *   B. 拼接格式漂移护栏：`extractStructuredType(peerMessage)` 必须仍能从 peer 拼好的
 *      message 里回捞 `quota_exceeded_error`。peer 改 error-body.js（不再嵌 body、换
 *      type 字段名、换前缀）时这里红——届时临界体（额度措辞 + 速率信号）回退纯文本
 *      启发会被 `hardQuota` 卡住而静默漏纠（§3.2 场景），需同步更新 `llm-error-fix.js`
 *      的抓取/回退。
 *   C. peer 行为钉：① misjudged 体仍被判 QUOTA（`isQuotaExceededError` true，即
 *      "quota 先于 rate"的死分支前提仍在；上游修正则/调序后这里红 → 按 §3.3②/③ 收紧
 *      peer 范围、llm-error-fix 退化为 no-op 兼容层并更新本契约）；② 类型名本身
 *      **不**误命中（钉住正确机制，防未来正则改动把 `_` 也当边界而误伤）；③ rate 类型
 *      名不误命中。
 *   E. **退出证**（退化闹钟）：直接执行 peer 未导出的 `classifyPiAiError` 源码体，
 *      问「若拆掉本插件的纠正层，peer 会不会自己判对」。当前答案为否 → 补丁承重；
 *      答案为是那天本段转红并在 stdout 打出 `EXIT-PROBE: patch-redundant`。那只是
 *      **退化**为 no-op 兼容层，不是删除——peer 范围 `>=0.1.5 <0.3` 仍跨 bug 版，
 *      本机装了修好的 peer 不等于用户的 Host 修好（§3.3「不删补丁是刻意的」）。
 *      真正的删除闹钟是离线的 `test/error-fix.test.mjs` §5：peer 下界收紧到修后
 *      版本、老 Host 不再被支持时，它才要求整层删除。没有这两条，这层打在不可改
 *      peer 上的补丁就是永久债（docs/IMPROVEMENTS.md §3.3④）。
 *
 * peer 引用按其实际导出选取：`@deepseek-ai/dsh-llm/lib/types/error.js` 导出
 * `isQuotaExceededError` 与 `QUOTA_EXCEEDED_CODE`（= 'QUOTA'）；组合消息优先用 pi-ai
 * 的 `formatProviderError`（存在时），缺 pi-ai 则按文档格式字面拼 `"<status>: <body>"`。
 * 全部按路径 import（绕过 exports 映射），裸 specifier 由 peer 文件自身位置解析到
 * runtime 根。
 */
import { findPeerRoot, installNetworkGuard } from "./peer-roots.mjs";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractStructuredType,
  shouldReclassifyQuotaToRate,
  reclassifyFinish,
  CODE
} from "../src/host/llm-error-fix.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail ?? "") });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

// 任何逃过 stub 的网络请求立即红：本套件必须是纯离线的。
installNetworkGuard();

const root = findPeerRoot();
if (root === undefined) {
  console.log("SKIP: 未找到 Host peer 根（干净检出/CI 常态）——契约无法验证，跳过且不红。");
  console.log("SKIP: 需 $DSH_HOME 或已解包的 DSH runtime 才会真跑（见 test/peer-roots.mjs）。");
  process.exit(0);
}

// --- 装载真实 peer（root 在却装不上 = 环境不完整，按失败处理，不是 SKIP）-----------
let dshLlm;
try {
  dshLlm = await import(pathToFileURL(join(root, "@deepseek-ai", "dsh-llm", "lib", "types", "error.js")).href);
} catch (error) {
  fail("load @deepseek-ai/dsh-llm/lib/types/error.js from peer root", error);
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
}

// pi-ai 的 formatProviderError：真实组合消息（peer 缺席时退化为字面拼）。
let compose = (status, body) => `${status}: ${body}`;
const piErrorBody = join(root, "@earendil-works", "pi-ai", "dist", "utils", "error-body.js");
if (existsSync(piErrorBody)) {
  try {
    const { formatProviderError } = await import(pathToFileURL(piErrorBody).href);
    compose = (status, body) =>
      formatProviderError({ status, body, message: "", messageCarriesBody: false });
  } catch {
    // 保持字面拼：格式按 error-body.js 文档注释（`"<status>: <body>"`）一致。
  }
}

const { isQuotaExceededError, QUOTA_EXCEEDED_CODE } = dshLlm;

// --- 代表性商汤 429 体 -------------------------------------------------------
// 误判体：message 文本含硬额度措辞（触发 isQuotaExceededError → peer 判 QUOTA）+
// 同时含速率信号（结构化 type 分支的 rateCapWords 可判为限频）→ 插件应纠正 RATE_LIMIT。
const MISJUDGED_BODIES = [
  JSON.stringify({ message: "quota exceeded, too many requests per minute, retry later", type: "quota_exceeded_error", code: "8" }),
  // rpm quota exhausted：文本启发会被 hardQuota（"quota exhausted"）卡住，只有结构化
  // type 分支（rateCapWords 命中 "rpm"）能纠正——B 段护栏的精确触发面。
  JSON.stringify({ message: "rpm quota exhausted, retry after 1s", type: "quota_exceeded_error", code: "8" })
];
// 真配额耗尽：额度措辞 + 无任何速率信号 → 必须保留 QUOTA（peer 不重试是对的）。
const HARD_BODY = JSON.stringify({ message: "monthly quota exceeded, no credits left", type: "quota_exceeded_error", code: "8" });
// peer 已正确判限频的体（类型即 rate_limit）：插件只防御、不纠正。
const RATE_TYPE_BODY = JSON.stringify({ message: "slow down", type: "rate_limit_error" });
// 类型名不误命中（机制钉）与无额度措辞的限频体（peer 会正确判 RATE_LIMIT）：
const TYPE_NAME_ONLY = '"type":"quota_exceeded_error"';
const NO_QUOTA_WORDING_BODY = JSON.stringify({ message: "rpm exhausted", type: "quota_exceeded_error", code: "8" });

const misjudgedMessages = MISJUDGED_BODIES.map((body) => compose(429, body));
const hardMessage = compose(429, HARD_BODY);
const rateTypeMessage = compose(429, RATE_TYPE_BODY);
const noQuotaWordingMessage = compose(429, NO_QUOTA_WORDING_BODY);

// --- C. peer 行为钉 ----------------------------------------------------------
check(
  "peer 仍把『额度措辞 + 429』误判为 QUOTA（死分支前提仍在）",
  MISJUDGED_BODIES.every((body) => isQuotaExceededError(body)),
  "上游若修了 dsh-llm（正则收紧或 429 短路率优先），这里红：按 §3.3②/③ 收紧 peer 范围、llm-error-fix 退化为 no-op 兼容层并更新本契约"
);
check(
  "机制钉：quota_exceeded_error 类型名本身不误命中（\\b 不穿透 _）",
  !isQuotaExceededError(TYPE_NAME_ONLY) && !isQuotaExceededError('quota_exceeded_error'),
  "若上游正则改动（把 _ 当边界）后这里红：类型名开始误伤，需复审 llm-error-fix 与 §3.1③ 的表述"
);
check(
  "peer 正控制：rate_limit_error 类型名不误命中 isQuotaExceededError",
  !isQuotaExceededError(RATE_TYPE_BODY),
  "该类型名不应触发配额正则"
);
check(
  "peer 正控制：无额度措辞的限频体（rpm exhausted）不误判 QUOTA",
  !isQuotaExceededError(NO_QUOTA_WORDING_BODY),
  "该体 peer 正确走到 RATE_LIMIT 分支"
);

// --- B. 拼接格式漂移护栏 ------------------------------------------------------
// peer 若不再把 body 拼进 message（换字段、换前缀、不嵌 JSON），这里红；届时临界体
// （额度措辞 + 速率信号）回退纯文本启发会被 hardQuota 卡住 → 静默漏纠（§3.2 场景）。
check(
  "extractStructuredType 仍能从 peer 拼好的 message 回捞 quota_exceeded_error",
  misjudgedMessages.every((m) => extractStructuredType(m) === "quota_exceeded_error") &&
    extractStructuredType(hardMessage) === "quota_exceeded_error",
  JSON.stringify(misjudgedMessages.map((m) => extractStructuredType(m)))
);
check(
  "extractStructuredType 区分 rate_limit_error 型体",
  extractStructuredType(rateTypeMessage) === "rate_limit_error",
  String(extractStructuredType(rateTypeMessage))
);

// --- A. 端到端纠正 -----------------------------------------------------------
for (const message of misjudgedMessages) {
  const failure = { code: QUOTA_EXCEEDED_CODE, message };
  check(
    `shouldReclassifyQuotaToRate true（额度措辞 + 速率信号 + quota 类型名）: ${message.slice(0, 60)}`,
    shouldReclassifyQuotaToRate(failure) === true
  );
  const out = reclassifyFinish({
    type: "finish",
    reason: { kind: "error", failure }
  });
  check(
    "reclassifyFinish 把 peer 误判的 QUOTA 纠正回 RATE_LIMIT",
    out !== null && out.reason?.failure?.code === CODE.RATE_LIMIT,
    JSON.stringify(out?.reason?.failure)
  );
  check(
    "纠正时保留原始 message（供排查）",
    out?.reason?.failure?.message === message
  );
}

// 真配额耗尽：不纠正（保留 QUOTA，peer 不重试、面板按 exhaustedModelIds 下线是对的）。
{
  const hard = { type: "finish", reason: { kind: "error", failure: { code: QUOTA_EXCEEDED_CODE, message: hardMessage } } };
  check("真配额耗尽原样放行（引用相等，QUOTA 不重试）", reclassifyFinish(hard) === hard);
  check("真配额耗尽不应被判为可纠正限频", shouldReclassifyQuotaToRate(hard.reason.failure) === false);
}
// peer 已判 RATE_LIMIT：幂等放行（无额度措辞的限频体与 rate 类型体）。
{
  const rate = { type: "finish", reason: { kind: "error", failure: { code: CODE.RATE_LIMIT, message: rateTypeMessage } } };
  check("peer 已判 RATE_LIMIT 的体幂等放行", reclassifyFinish(rate) === rate);
  const rate2 = { type: "finish", reason: { kind: "error", failure: { code: CODE.RATE_LIMIT, message: noQuotaWordingMessage } } };
  check("无额度措辞的限频体幂等放行", reclassifyFinish(rate2) === rate2);
}

// --- D. credentialKey 双轨契约：shim 必须等于 peer 函数 ----------------
// `index.ts` 手写的 `credentialKey(scope, id)` 与 DSH 凭据服务的真实
// `credentialKey` 是同一契约的两份实现：shim 让插件在干净 checkout 上
// 可运行，peer 函数是运行时实际使用的权威。这里把两份实现对齐钉死——
// peer 改 key 格式（如加版本号或换分隔符）时此段红，提示同步更新 shim。
// 此段在 dsh-credentials 库入口可达时运行；不可达时 SKIP（与套件头部一致）。
{
  const peerCredPath = join(root, "@deepseek-ai", "dsh-credentials", "lib", "index.js");
  if (existsSync(peerCredPath)) {
    const { credentialKey: peerKey } = await import(pathToFileURL(peerCredPath).href);
    const { credentialKey: shim } = await import("../src/host/index.ts");
    check(
      "credentialKey shim 与 peer 函数逐一对齐",
      shim("dsh-connect-agnes-token-plan", "agnes-console") ===
        peerKey("dsh-connect-agnes-token-plan", "agnes-console"),
      `shim="${shim("dsh-connect-agnes-token-plan", "agnes-console")}" peer="${peerKey("dsh-connect-agnes-token-plan", "agnes-console")}"`
    );
  } else {
    console.log("SKIP (D): dsh-credentials 库入口不在标准路径——由 test/store.test.mjs 18 段检查兜底。");
  }
}

// --- E. 退出证：peer 自己会不会判对（llm-error-fix 的删除闹钟）------------
// 抽取 peer 未导出的 `classifyPiAiError` 源码体并注入它的两个依赖后执行，
// 而不是在测试里重抄一份分支顺序——重抄的副本一旦与 peer 漂移，这个"到期日"
// 就会给出错误答案（要么永不响，要么误响）。执行的是 peer 自己的代码，peer
// 调序/收紧正则时本段的答案自动跟着变，无需维护副本。
{
  const classifierPath = join(root, "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js");

  /** 按花括号配平取出 `function <name>(...)` 的函数体；找不到返回 null。 */
  function extractFunctionBody(source, name) {
    const at = source.indexOf(`function ${name}(`);
    if (at < 0) return null;
    const open = source.indexOf("{", at);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(open + 1, i);
      }
    }
    return null;
  }

  let classify = null;
  let extractError = "";
  if (!existsSync(classifierPath)) {
    extractError = `peer 分类器文件不在预期路径：${classifierPath}`;
  } else {
    try {
      const body = extractFunctionBody(readFileSync(classifierPath, "utf8"), "classifyPiAiError");
      if (body === null) throw new Error("未能在 peer 源码里定位 classifyPiAiError");
      // 注入 peer 自己的两个依赖，其余全是字面正则，不需要外部符号。
      classify = new Function("message", "isQuotaExceededError", "QUOTA_EXCEEDED_CODE", body);
      classify("warmup", isQuotaExceededError, QUOTA_EXCEEDED_CODE);
    } catch (error) {
      classify = null;
      extractError = String(error?.message ?? error);
    }
  }

  check(
    "退出证探针可用：能定位并执行 peer 的 classifyPiAiError",
    classify !== null,
    extractError === ""
      ? ""
      : `${extractError}。peer 结构已变 → 人工复核 llm-error-fix.ts 是否仍必要（这是本补丁唯一的到期日，不可用 SKIP 糊过去）`
  );

  if (classify !== null) {
    const peerCode = (message) => classify(message, isQuotaExceededError, QUOTA_EXCEEDED_CODE);

    // 控制组：探的是**配额检测器本身是否还活着**，不是"硬配额体最终被判成什么"。
    // 后者会误伤一次合法的上游语义修正——若 peer 按 Agnes 官方语义把 429 一律判
    // 限频（配额改由 402 表达），硬配额体（也是 429 体）自然变 RATE_LIMIT，那是
    // 修好了而不是回归；用分支结果当控制会把真正的到期日压住。检测器失效才是
    // 需要压住的情形：那时 canary 会因"什么都匹不上"而落到 RATE_LIMIT，敲响的
    // 是假闹钟。所以这里直接喂一段不含 429 的纯额度文本给 isQuotaExceededError。
    const quotaDetectorAlive = isQuotaExceededError("monthly quota exceeded, no credits left");
    check(
      "退出证控制：peer 的配额检测器仍活着（防到期日因检测失效而假响）",
      quotaDetectorAlive === true,
      // 只在失败时带文案：这条的 detail 是"该怎么办"，通过时打印它会让人以
      // 为检测器已经死了（套件仍绿，但读日志的人被误导）。
      quotaDetectorAlive === true
        ? ""
        : "isQuotaExceededError('monthly quota exceeded, no credits left') 为 false —— 检测器失效，canary 落到的 RATE_LIMIT 不代表上游已修好"
    );

    const stillWrong = misjudgedMessages.filter((m) => peerCode(m) !== CODE.RATE_LIMIT);
    const patchRedundant = stillWrong.length === 0 && quotaDetectorAlive === true;

    // 一行可 grep 的结论，无论红绿都打出来：日志里能回溯"到期日何时敲响"。
    // 三态而非两态——"canary 全对但检测器死了"既不是承重也不是可删，把它说成
    // "仍误判 0/2" 是自相矛盾的噪声，会让人照着一行错的话去删补丁。
    console.log(
      patchRedundant
        ? "EXIT-PROBE: patch-redundant —— peer 已能自己判对，本层对当前 peer 空转（按 §3.3 退化为 no-op 兼容层，勿删）"
        : stillWrong.length === 0
          ? "EXIT-PROBE: inconclusive —— canary 已全判对，但 peer 配额检测器已失效：这是回归不是修复，勿删（人工复核 peer 的 isQuotaExceededError）"
          : `EXIT-PROBE: patch-needed —— peer 仍误判 ${stillWrong.length}/${misjudgedMessages.length} 条 canary`
    );

    // 转红 = **退化**闹钟，不是删除闹钟。本层是"老 Host + bug 版 peer"的兜底
    // （docs/IMPROVEMENTS.md §3.3 明写"不删补丁是刻意的"）：peer 范围
    // `>=0.1.5 <0.3` 仍跨 bug 版，本机装了修好的 peer 不代表用户的 Host 修好了。
    // 所以此刻该做的是确认它对新 peer 已成为 no-op，再走 §3.3③ 收紧下界；
    // **真正的删除闹钟是离线的那条**（test/error-fix.test.mjs §5）：下界提到
    // 修后版本、老 Host 不再被支持时，它才要求整层删除。
    check(
      "补丁仍承重：peer 尚未自己判对 canary（转假 = 退化为 no-op 兼容层，非删除）",
      !patchRedundant,
      patchRedundant
        ? [
            "peer 的 classifyPiAiError 已能把这些体判为 RATE_LIMIT，本纠正层对新 peer 成为空转。",
            "此刻的动作（不是删除 —— 老 Host 仍需它）：",
            "  1. 确认 reclassifyFinish 对新 peer 是 no-op（failure.code 已是 RATE_LIMIT，引用相等）",
            "  2. 走 §3.3③ 把 @deepseek-ai/dsh-llm / dsh-llm-pi-ai 的下界收紧到修后版本，README 注明所需 Host",
            "  3. 下界收紧之后才删：src/host/llm-error-fix.ts + 挂钩点一处（pi-ai-adapter-core.ts，两条路由共用的组装核心）",
            "     —— 删除闹钟由 test/error-fix.test.mjs §5 在下界变化时敲响"
          ].join("\n")
        : stillWrong
            .map((m) => `peer 判为 ${String(peerCode(m))}：${m.slice(0, 80)}`)
            .join("\n")
    );
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);