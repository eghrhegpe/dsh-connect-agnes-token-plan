/**
 * Admission audit —— 让「不带 Origin 的写请求」事后可见。
 *
 * 同源闸（`host-config.ts` 的 `isAdmitted`）在 `Origin` 缺失时放行，这是**刻意**
 * 的：浏览器的同站 GET 不发 `Origin`，而跨站 POST 必然发、发了就被比对拦掉。
 * 所以那条分支上过的是**非浏览器客户端**（脚本 / curl / 本地进程），而它们本来
 * 就能自己伪造 `Origin` 与 `Host`——补一条"写方法必须带 Origin"的规则不会增加
 * 任何安全性，只会给"无源脚本"制造摩擦，外加一个"面板被代理剥掉 Origin 就全站
 * 403"的功能性风险。
 *
 * 真正该做的是**让这条分支上的写请求留下痕迹**：它一旦被滥用（尤其
 * `/agnescode`——一次无凭证 POST 就会触发本机 DPAPI 解密、凭据落库、provider
 * 注册），事后必须能回答"有没有发生过"，而不是靠猜。
 *
 * 记录的内容刻意**不含任何值**：只有次数、最后一次的时间、与一个归一化后的
 * 方法名。没有 Host / Origin / 路径 / 头值/ 凭据——这个文件要能被 `doctor`
 * 读出来贴进工单，所以它必须生来就是可贴的。
 *
 * 与 `throttle-store` 同款：**故意不按 profile 分段**（PITFALLS §23）。这是
 * "这台机器上是否有人打过无源写"的问题，不是某个 profile 的偏好。
 * @module dsh-connect-agnes-token-plan/admission-audit
 */

import { join } from "node:path";
import { isAdmitted, name } from "./host-config.ts";
import { ensureStateDir, readStateJson, stateDir, temporaryOf, writeStateFile } from "./state-store.ts";

/** 载荷形状版本。改动形状时 +1，旧文件按"无记录"读（见 `parse`）。 */
export const ADMISSION_AUDIT_VERSION = 1;

/** 落盘文件名（`doctor` 按显式 home 读它，所以需要可导出）。 */
export const ADMISSION_AUDIT_FILE = "admission-audit.json";
const FILE = ADMISSION_AUDIT_FILE;

/**
 * Where the audit lives: the SHARED directory, `$DSH_HOME/state/<plugin>`.
 *
 * 同 `throttleDir()`——见该文件头注：这是机器级事实，不是 profile 偏好。
 * @returns {string} the directory.
 */
export function admissionAuditDir() {
  return stateDir(name);
}

/**
 * 归一化一个 HTTP 方法名，只保留可信形状。
 *
 * 方法名来自请求头，是**外部输入**：直接落盘等于让别人往我们自己的状态文件里
 * 写任意字符串（长度、编码、换行都能做文章）。所以只接受大写字母，超长截断，
 * 其余一律 `OTHER`——排查只需要知道"是 POST 还是别的"，不需要原文。
 * @param {unknown} method
 * @returns {string}
 */
export function normalizeMethod(method: unknown) {
  if (typeof method !== "string") return "OTHER";
  const upper = method.toUpperCase();
  return /^[A-Z]{3,8}$/.test(upper) ? upper : "OTHER";
}

/**
 * 解析一条审计记录，`null` 表示"无记录"（缺席 / 损坏 / 外来版本）。
 *
 * 与节流同源的取舍方向：认不出来就读作"没发生过"。审计是**排查辅助**，不是闸
 * 的一部分——它坏了不能让路由失败，也不能让 `doctor` 报出一个假的"发生过"。
 * @param {unknown} raw
 * @returns {{version: number, count: number, lastAt: number, lastMethod: string}|null}
 */
export function parseAdmissionAudit(raw: unknown) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (body.version !== ADMISSION_AUDIT_VERSION) return null;
  const count = typeof body.count === "number" && Number.isFinite(body.count) && body.count > 0
    ? Math.floor(body.count)
    : 0;
  const lastAt = typeof body.lastAt === "number" && Number.isFinite(body.lastAt) && body.lastAt > 0
    ? Math.floor(body.lastAt)
    : 0;
  if (count <= 0 && lastAt <= 0) return null;
  return {
    version: ADMISSION_AUDIT_VERSION,
    count,
    lastAt,
    lastMethod: typeof body.lastMethod === "string" ? normalizeMethod(body.lastMethod) : "OTHER"
  };
}

/**
 * 会改变状态的方法（除了这几个都算）。
 *
 * 判断是"不安全的才算写"，而不是"POST/PUT/DELETE 才算"：方法名是外部输入，
 * 且账号路由（`routes/account.ts`）把**缺失**方法也当 POST 处理（那是为了照顾不带 method 的
 * 客户端）。用黑名单（只放行安全的）能保证"没有方法"也被记成一次写——审计宁可
 * 多记，不可漏记。
 * @param {unknown} method
 * @returns {boolean}
 */
function isStateChanging(method: unknown) {
  if (typeof method !== "string" || method === "") return true;
  return !["GET", "HEAD", "OPTIONS", "TRACE"].includes(method.toUpperCase());
}

/**
 * 同源闸 + 审计：写路由用这个替代直接调 `isAdmitted`。
 *
 * 放行结论与 `isAdmitted` **逐位相同**——审计挂在旁边，不改变任何一次请求的
 * 命运。它只在"放行 + 未声明 Origin + 会改状态"这三个条件同时成立时落一笔；
 * 那正是"非浏览器客户端在写"的分支，也是本机进程唯一能无声无息改掉凭据的入口。
 * @param {{headers: {host?: string, origin?: unknown}, method?: string}} request
 * @param {Set<string>} allowedHosts
 * @param {{dir?: string, now?: () => number}} [options] - 透传给 `recordOriginlessWrite`
 *   （测试用它指向临时目录，避免写进真实 state）。
 * @returns {boolean} whether the request may be served（同 `isAdmitted`）。
 */
export function isAdmittedWithAudit(request: any, allowedHosts: Set<string>, options: { dir?: string; now?: () => number } = {}) {
  const admitted = isAdmitted(request, allowedHosts);
  if (admitted && isStateChanging(request?.method)) {
    const origin = request?.headers?.origin;
    const stated = typeof origin === "string" && origin !== "" && origin !== "null";
    if (!stated) void recordOriginlessWrite(request?.method, options);
  }
  return admitted;
}

/** Read the persisted audit, or `null`. */
export async function readAdmissionAudit(dir = admissionAuditDir()) {
  try {
    return parseAdmissionAudit(await readStateJson(join(dir, FILE)));
  } catch {
    return null;
  }
}

/**
 * 记一次"不带 Origin 的写请求"。
 *
 * Fire-and-forget 且**永不抛**：审计是旁路的，它不能影响请求本身——写文件失败、
 * 目录不可建、并发写撞车，一律吞掉。计数采用"读-改-写"并且**不重试**：丢一次
 * 计数只是让数字偏小，而为了精确去加重试/加锁会把一个诊断件变成热路径上的
 * 竞争源，代价与收益不成比例。
 * @param {unknown} method - 请求方法（会被 `normalizeMethod` 收敛）。
 * @param {{dir?: string, now?: () => number}} [options]
 * @returns {Promise<void>}
 */
export async function recordOriginlessWrite(method: unknown, options: { dir?: string; now?: () => number } = {}) {
  const dir = options.dir ?? admissionAuditDir();
  const now = options.now ?? Date.now;
  const lastMethod = normalizeMethod(method);
  try {
    await ensureStateDir(dir);
    const file = join(dir, FILE);
    const previous = parseAdmissionAudit(await readStateJson(file).catch(() => null));
    const payload = {
      version: ADMISSION_AUDIT_VERSION,
      count: (previous?.count ?? 0) + 1,
      lastAt: now(),
      lastMethod
    };
    const temporary = temporaryOf(dir, FILE);
    // `writeStateFile` 要的是**已序列化**的字符串（它内部是 `${payload}`）——
    // 直接传对象会静默落一个 "[object Object]" 文件，读回来是 null，看起来
    // 就像"从没发生过"。这正是审计最危险的失败方向。
    await writeStateFile(file, JSON.stringify(payload), { temporary });
  } catch {
    // 审计失败就当没记：见上。
  }
}
