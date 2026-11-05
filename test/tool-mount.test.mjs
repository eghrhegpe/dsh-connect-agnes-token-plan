/**
 * 工具挂载阶梯（createToolMount）的离线检查——特别是「tools peer 装载失败」这一档。
 *
 * 这个阶梯此前完全没有离线套件（docs/TOOL-HOT-RELOAD.md §5 明说「disposer 路径尚无
 * 离线套件」），而它偏偏藏着本插件最贵的一次静默失败：`side.loadToolsModule()` 是对
 * `@deepseek-ai/dsh-tools` 的**文件位置解析**，装在 `~/.dsh/plugins` 下的插件永远解析
 * 不到宿主运行时（CLI runtime 在全局 npm 前缀、桌面 runtime 在 app 包内），于是
 * `ERR_MODULE_NOT_FOUND` 每次都抛、旧代码每次都在 catch 里 `return`——开关 visibly
 * 开着，工具静默缺席，一行日志都没有。兄弟插件 workbuddy 之所以「随时能挂」，是因为它
 * 手写 ToolDefinition、根本不需要 peer。
 *
 * 所以本套件钉的是修复后的形状，一条都不能少：
 *   1. peer 抛错 / peer 模块没有 defineTool / 连 seam 都没给 —— 三档全落到
 *      rawDefineTool，工具照样注册，且每个 handle 只警告**一次**（模型换挂不刷屏）；
 *   2. peer 在 —— 走 peer 路径（passthrough 返回原 options），不警告；
 *   3. raw 路径产出的 definition 是宿主认识的形状：parameters 已转成 JSON Schema
 *      （逐属性 `required` 剥掉、收进根 `required` 数组）、output 原样透传、
 *      timeoutMs 按 settings 折算、execute/render 是函数；
 *   4. 阶梯其余档行为不变：off 翻转经 disposer 卸载；register 返回 undefined 即
 *      粘住、不再重复注册；registry 抛错则不挂载也不炸；configError 直接不挂载。
 *   5. 转换器单元：`type:"json"` 与未知 type 都投影为「只留注解」节点、
 *      外来键（minLength）被丢弃、根 required 为空时整个键缺席（peer 的
 *      property-map-tail 语义）、timeoutMs 非法即省略而不是抛。
 */
import { installNetworkGuard } from "./peer-roots.mjs";
import { createToolMount } from "../src/host/lifecycle.ts";
import { defineDrawTool, DRAW_TOOL_NAME, DRAW_DEFAULT_TIMEOUT_MS } from "../src/host/draw.ts";
import { rawDefineTool, parameterSpecsToJsonSchema } from "../src/host/tool-raw-definition.ts";
import { name as PLUGIN_NAME } from "../src/host/host-config.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail ?? "") });
}

installNetworkGuard();

// ── 夹具 ────────────────────────────────────────────────────────────────
/** peer 装载缝：missing = 抛 ERR_MODULE_NOT_FOUND；empty = 模块没有 defineTool；absent = 连 seam 都不给。 */
const peerMissing = () => {
  const error = new Error("Cannot find package '@deepseek-ai/dsh-tools' imported from ...");
  error.code = "ERR_MODULE_NOT_FOUND";
  throw error;
};
const peerPassthrough = () => ({ defineTool: (options) => options });
const peerEmptyModule = () => ({});

/** 假开关 store：面板值可变，异步读。 */
function fakeStore({ enabled = true, modelId = null } = {}) {
  const state = { enabled, modelId };
  return {
    state,
    enabled: async () => state.enabled,
    modelId: async () => state.modelId,
    isSet: async () => true,
    save: async (v) => { state.enabled = v; },
    forget: async () => { state.enabled = null; },
    saveModel: async (v) => { state.modelId = v; },
    forgetModel: async () => { state.modelId = null; }
  };
}

/** 假 tools service：记录每次 register 收到的 definition 与返回策略。 */
function fakeService(registerImpl) {
  const calls = [];
  return {
    calls,
    service: {
      register(definition) {
        calls.push(definition);
        return registerImpl ? registerImpl(definition, calls.length) : () => {};
      }
    }
  };
}

function makeWiring({ settings = null, configError = null, logs = [] } = {}) {
  return {
    settings: settings ?? { drawEnabled: true, drawModelId: "", videoEnabled: false, videoModelId: "" },
    configError,
    providerState: { entries: null },
    catalogStore: { list: async () => [] },
    resolveApiKey: async () => "",
    publisher: { isDisposed: () => false },
    logger: { warn: (message) => logs.push(message) }
  };
}

const neverFetch = () => {
  throw new Error("test fetch must not be called");
};

/** 挂一个以真实 defineDrawTool 为 factory 的 mount，返回 { mount, calls, logs, store, wiring }。 */
async function mountDraw({ loadToolsModule = peerMissing, registerImpl, settings, configError = null, store = fakeStore() } = {}) {
  const logs = [];
  const { service, calls } = fakeService(registerImpl);
  const wiring = makeWiring({ settings, configError, logs });
  const mount = createToolMount({
    ctx: { get: (which) => (which === "tools" ? service : null) },
    wiring,
    side: { loadToolsModule, drawFetch: neverFetch, videoFetch: neverFetch },
    store,
    enabledKey: "drawEnabled",
    modelKey: "drawModelId",
    fetchImpl: neverFetch,
    factory: defineDrawTool
  });
  await mount.sync();
  return { mount, calls, logs, store, wiring };
}

// ── 1. peer 三档缺失 → raw 兜底照样挂载 + 只警告一次 ─────────────────────
{
  const a = await mountDraw({ loadToolsModule: peerMissing });
  check("peer 抛 ERR_MODULE_NOT_FOUND：工具仍挂载", a.mount.isMounted() === true && a.calls.length === 1,
    `mounted=${a.mount.isMounted()} calls=${a.calls.length}`);
  check("peer 缺失：警告一行且含降级说明", a.logs.length === 1 &&
    a.logs[0].includes(`${PLUGIN_NAME}: drawEnabled:`) &&
    a.logs[0].includes("tools peer unavailable") &&
    a.logs[0].includes("raw tool definition") &&
    a.logs[0].includes("Cannot find package"),
    JSON.stringify(a.logs));

  const b = await mountDraw({ loadToolsModule: peerEmptyModule });
  check("peer 模块没有 defineTool：同样落到 raw 兜底", b.mount.isMounted() === true && b.logs.length === 1 &&
    b.logs[0].includes("exports no defineTool"), JSON.stringify(b.logs));

  const c = await mountDraw({ loadToolsModule: undefined });
  check("连 seam 都没给（deps 未注入）：同样挂载 + 警告", c.mount.isMounted() === true && c.logs.length === 1);
}

// ── 2. peer 在 → 走 peer 路径，不警告 ────────────────────────────────────
{
  const p = await mountDraw({ loadToolsModule: peerPassthrough });
  check("peer 可用：走 peer 路径", p.mount.isMounted() === true && p.calls.length === 1);
  check("peer 可用：不产生降级警告", p.logs.length === 0, JSON.stringify(p.logs));
  // passthrough 返回原 options：parameters 还是作者 spec 形态（逐属性 required:true 在）
  const def = p.calls[0];
  check("peer 路径下 parameters 未被本插件预转换（spec 形态原样进 peer）",
    def?.parameters?.prompt?.required === true, JSON.stringify(def?.parameters?.prompt));
}

// ── 3. raw 路径的 definition 是宿主认识的形状 ────────────────────────────
{
  const { calls } = await mountDraw({ settings: { drawEnabled: true, drawModelId: "", drawTimeoutMs: 60000 } });
  const def = calls[0];
  check("raw definition：name 为 agnes_draw_image", def?.name === DRAW_TOOL_NAME, String(def?.name));
  const params = def?.parameters ?? {};
  check("raw definition：parameters 已是 JSON Schema 根节点", params.type === "object" && params.properties &&
    typeof params.properties === "object", JSON.stringify(Object.keys(params)));
  check("raw definition：逐属性 required 被剥掉、prompt 收进根 required",
    params.properties?.prompt && !("required" in params.properties.prompt) &&
    Array.isArray(params.required) && params.required.length === 1 && params.required[0] === "prompt",
    JSON.stringify({ p: params.properties?.prompt, r: params.required }));
  check("raw definition：数组属性带 items.type", params.properties?.image?.type === "array" &&
    params.properties?.image?.items?.type === "string", JSON.stringify(params.properties?.image));
  check("raw definition：数值/布尔属性带 type", params.properties?.n?.type === "number" &&
    params.properties?.return_base64?.type === "boolean");
  check("raw definition：描述随属性投影", typeof params.properties?.size?.description === "string" &&
    params.properties.size.description.includes("1K"));
  check("raw definition：output 原样透传（render 是函数、schema 保持声明）",
    typeof def?.output?.render === "function" && def?.output?.schema?.type === "object" &&
    def.output.schema.additionalProperties === false &&
    def.output.schema.properties?.url?.type === "string", JSON.stringify(def?.output?.schema));
  check("raw definition：timeoutMs 按 settings 折算（60000+10000）", def?.timeoutMs === 70000, String(def?.timeoutMs));
  check("raw definition：execute 是函数", typeof def?.execute === "function");
  // 默认超时档
  const d2 = await mountDraw({ settings: { drawEnabled: true, drawModelId: "" } });
  check("raw definition：缺省 timeoutMs = DRAW_DEFAULT_TIMEOUT_MS+10000",
    d2.calls[0]?.timeoutMs === DRAW_DEFAULT_TIMEOUT_MS + 10000, String(d2.calls[0]?.timeoutMs));
}

// ── 4. 换模型重挂：警告不重复，注册收敛到新值 ────────────────────────────
{
  const store = fakeStore({ enabled: true, modelId: null });
  const { mount, calls, logs } = await mountDraw({ store, settings: { drawEnabled: true, drawModelId: "" } });
  const firstDef = calls[0];
  store.state.modelId = "agnes-image-2.5-flash";
  await mount.sync();
  check("面板换模型：重新注册一次（第二次 sync 后 calls=2）", calls.length === 2, String(calls.length));
  check("面板换模型：降级警告仍只有一行", logs.length === 1, JSON.stringify(logs));
  check("面板换模型：目标模型经 effectiveSettings 传进 factory（两次注册产物不同）",
    firstDef !== calls[1], "两次注册 definition 不同");
  // 同值再 sync 不重复注册
  await mount.sync();
  check("同模型同开关再 sync：不重复注册", calls.length === 2, String(calls.length));
}

// ── 5. off 翻转经 disposer 卸载 ──────────────────────────────────────────
{
  let disposed = 0;
  const store = fakeStore({ enabled: true, modelId: null });
  const { mount, calls } = await mountDraw({
    store,
    registerImpl: () => () => { disposed += 1; }
  });
  check("off 之前已挂载", mount.isMounted() === true && calls.length === 1);
  store.state.enabled = false;
  await mount.sync();
  check("off 翻转：disposer 被调用且状态卸载", disposed === 1 && mount.isMounted() === false);
  // 重新打开 → 再注册
  store.state.enabled = true;
  await mount.sync();
  check("重新打开：再次挂载（calls=2）", calls.length === 2 && mount.isMounted() === true);
}

// ── 6. register 返回 undefined → 粘住，绝不重复注册 ─────────────────────
{
  const store = fakeStore({ enabled: true, modelId: null });
  const { mount, calls, logs } = await mountDraw({ store, registerImpl: () => undefined });
  check("无 disposer：首次注册成功且标记挂载", mount.isMounted() === true && calls.length === 1);
  store.state.modelId = "agnes-image-2.5-flash";
  await mount.sync();
  await mount.sync();
  check("粘住（无 disposer）：换模型也不重复注册", calls.length === 1, String(calls.length));
  store.state.enabled = false;
  await mount.sync();
  check("粘住：off 翻转清掉登记位（isMounted=false）", mount.isMounted() === false);
  store.state.enabled = true;
  await mount.sync();
  check("粘住后重新打开：重新注册（calls=2），警告仍一行", calls.length === 2 && logs.length === 1,
    `calls=${calls.length} logs=${logs.length}`);
}

// ── 7. registry 抛错 → 不挂载也不炸 ─────────────────────────────────────
{
  let threw = null;
  try {
    await mountDraw({ registerImpl: () => { throw new Error("registry refusal"); } });
  } catch (error) {
    threw = error;
  }
  check("registry 抛错：sync 不炸、工具不登记挂载", threw === null, String(threw?.message));
}

// ── 8. configError → 阶梯第一道闸，永不注册 ─────────────────────────────
{
  const { mount, calls } = await mountDraw({ configError: "patch is broken" });
  check("configError：不注册、不挂载", calls.length === 0 && mount.isMounted() === false);
}

// ── 9. 转换器单元（peer 语义的分界） ────────────────────────────────────
{
  const converted = parameterSpecsToJsonSchema({
    prompt: { type: "string", required: true, description: "p" },
    size: { type: "string" },
    flags: { type: "json", description: "f" },
    bogus: { type: "string", required: true, minLength: 3 },
    list: { type: "array", items: { type: "integer", enum: [1, 2] } },
    nested: { type: "object", additionalProperties: false, properties: { a: { type: "string", required: true } }, required: true },
    ghost: { type: "quantum", description: "未知类型" }
  });
  check("转换：根 required 只收 required:true 的键且剥掉逐属性标记",
    JSON.stringify(converted.required) === JSON.stringify(["prompt", "bogus", "nested"]),
    JSON.stringify(converted.required));
  check("转换：type:json 投影为注解-only 节点", converted.properties.flags.description === "f" &&
    !("type" in converted.properties.flags), JSON.stringify(converted.properties.flags));
  check("转换：未知 type 也只留注解、绝不抛", converted.properties.ghost.description === "未知类型" &&
    Object.keys(converted.properties.ghost).length === 1, JSON.stringify(converted.properties.ghost));
  check("转换：外来键（minLength）被丢弃", !("minLength" in converted.properties.bogus) &&
    !("required" in converted.properties.bogus), JSON.stringify(converted.properties.bogus));
  check("转换：数组 items 递归编译（enum 保留）",
    converted.properties.list.items.type === "integer" &&
    JSON.stringify(converted.properties.list.items.enum) === JSON.stringify([1, 2]),
    JSON.stringify(converted.properties.list));
  check("转换：嵌套 object 带 additionalProperties 与子 required",
    converted.properties.nested.additionalProperties === false &&
    JSON.stringify(converted.properties.nested.required) === JSON.stringify(["a"]) &&
    !("required" in converted.properties.nested.properties.a),
    JSON.stringify(converted.properties.nested));

  const noneRequired = parameterSpecsToJsonSchema({ a: { type: "string" } });
  check("转换：无 required 时根 required 键整个缺席（peer property-map-tail）",
    !("required" in noneRequired), JSON.stringify(noneRequired));

  const def = rawDefineTool({
    name: "t",
    parameters: { a: { type: "string", required: true } },
    output: { schema: { type: "object", properties: { x: { type: "string" } } } },
    timeoutMs: -5,
    execute: async () => ({})
  });
  check("rawDefineTool：非法 timeoutMs 省略而非抛（peer 会抛，降级不许崩）",
    !("timeoutMs" in def), JSON.stringify(Object.keys(def)));
  const def2 = rawDefineTool({ name: "t", timeoutMs: 1500 });
  check("rawDefineTool：合法 timeoutMs 原样带上", def2.timeoutMs === 1500);
  const def3 = rawDefineTool({ name: "t", parameters: {} });
  check("rawDefineTool：parameters 空映射也产出根对象", def3.parameters?.type === "object" &&
    JSON.stringify(def3.parameters.properties) === JSON.stringify({}), JSON.stringify(def3.parameters));
  const def4 = rawDefineTool({ name: "t", description: undefined });
  check("rawDefineTool：description 缺席时键不出现（exactOptionalPropertyTypes 形状）",
    !("description" in def4), JSON.stringify(Object.keys(def4)));
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
