// @ts-check
/**
 * 状态文件公共原语 —— 把四个 store（throttle / catalog / provider / draw）此前
 * 各自手写的同一段"版本载荷 + temp 文件 + rename 原子 + 0600 + 损坏即忽略"
 * 收敛到这里（docs/IMPROVEMENTS.md §4.1 第一步）。
 *
 * 第二步收敛的是**读缓存**：provider / draw 早有 1s TTL，而 catalog 完全没有
 * （进程内永不失效）——同一个「两个进程共享一个 state 目录」的问题修了两个、
 * 漏了第三个。现在统一走 {@link createStateReadCache}，一个 TTL 三个调用方。
 *
 * peer-free 与四个 store 同纪律：不 import 任何 Host peer，纯 `node:fs`，
 * 离线可测（store.test.mjs 直接注入 dir 构造即可）。
 *
 * 行为约定（与四个 store 的历史实现逐一对齐）：
 *   - 目录：`$DSH_HOME/state/<name>`——与 Host 自己的目录并列，而不是在
 *     `logs/`（trace 轮转会按日志清扫，状态文件不能跟着被扫走）。
 *   - 写：临时文件（0600，owner-only）→ `rename` 原子落位。**失败抛错**，
 *     是否吞错是各 store 的语义（throttle/catalog 面对只读 Home 选择吞、
 *     provider 面板开关交给调用方的错误路径），原语不做决定。
 *   - 临时名：进程 + 时间戳后缀。固定临时名会让两个 Host 进程的写落到同一
 *     路径、互相 `rename` 掉对方写了一半的文件（catalog-store 早已用此策略，
 *     本次顺手把 throttle/provider 的固定名/各自实现一并统一）。
 *   - 读：缺失、不可读、非 JSON 一律返回 `null`——"损坏即忽略"的方向。是否
 *     缓存、缓存多久由 {@link createStateReadCache} 决定，不是每个 store 各自的
 *     即兴实现。
 *
 * @module dsh-connect-sensenova-token-plan/state-store
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { str } from "./util.js";

/**
 * Where this plugin keeps state: `$DSH_HOME/state/<name>`.
 * @param {string} name - the plugin's own state directory name
 *   (`host-config.js`'s `name`).
 * @returns {string} the directory.
 */
export function stateDir(name) {
  const home = str(process.env.DSH_HOME, join(homedir(), ".dsh"));
  return join(home, "state", name);
}

/**
 * Make the state directory exist (owner-only), created on demand.
 *
 * A read-only Home throws — callers wrap this in their own policy (the
 * throttle/catalog writers swallow it, the provider switch does not).
 * @param {string} dir - the state directory.
 * @returns {Promise<void>}
 */
export async function ensureStateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * A unique temporary path per write.
 *
 * Two Host processes can share one state directory, so a fixed temp name would
 * let both writes land on the same path and each `rename` could move the
 * other's half-written file. A process-plus-clock suffix keeps concurrent
 * writers off each other; the rename itself stays atomic per path.
 * @param {string} dir - the state directory.
 * @param {string} base - the final file name, e.g. `"throttle.json"`.
 * @param {() => number} [now] - clock source; injected by the tests.
 * @returns {string} `dir/<base>.<pid>.<now>.tmp`.
 */
export function temporaryOf(dir, base, now = Date.now) {
  return join(dir, `${base}.${process.pid}.${now()}.tmp`);
}

/**
 * Write one state file atomically: a 0600 temporary file, then a rename.
 *
 * The payload string is written with a trailing newline, exactly as every
 * store wrote before this module existed. Failures PROPAGATE — the callers
 * decide whether a read-only Home breaks their flow.
 * @param {string} file - the final file path.
 * @param {string} payload - the serialized body (JSON text).
 * @param {{temporary: string}} options - the temp path to write first.
 * @returns {Promise<void>}
 */
export async function writeStateFile(file, payload, { temporary }) {
  await writeFile(temporary, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

/**
 * How long a parsed state file may be reused without going back to disk.
 *
 * Two Host processes share one state directory (see PITFALLS §22), so this is
 * the upper bound on "how stale this process's view can be" — long enough to
 * keep one poll self-consistent, short enough that a change made anywhere else
 * is picked up on the next tick rather than after a restart.
 */
export const STATE_READ_TTL_MS = 1000;

/**
 * 状态文件的短生命周期读缓存 —— 把 catalog / provider / draw 三个 store
 * 各自手写的「近期读过就不再读盘」收敛到这里（§22：两个 Host 进程共享同一
 * 个状态目录，缓存期就是「另一个进程的写入多久可见」的上界）。
 *
 * 为什么要有 TTL 而不是不缓存：每次轮询都重读一遍小 JSON 本身不贵，但快照
 * 聚合在一次请求内会多次问同一个 store（目录条目、允许清单、开关），缓存让
 * 一次请求内的答案自洽。为什么 TTL 必须短：超过了就是「另一个 profile 改了
 * 允许清单，本机要重启才看得见」——这正是 catalog-store 早前的形态（无 TTL，
 * 进程内永不失效），而现在三者共用一份 `ttlMs`。
 *
 * `null` 也是一个合法的缓存值（"文件不存在/损坏，读作无记录"），所以"从未
 * 读过"用 `undefined` 表示，两者不可混。
 *
 * peer-free，与其余原语同纪律（不 import Host peer、离线可测）。时钟与 TTL
 * 都可注入，便于测试把缓存推进过期。
 *
 * @template T
 * @param {() => Promise<T>} readThrough - 真正的读盘 + 解析；返回 `null` 表示无可用记录。
 * @param {object} [options]
 * @param {number} [options.ttlMs] - 缓存有效期，默认 {@link STATE_READ_TTL_MS}。
 * @param {() => number} [options.now] - 时钟源；测试注入。
 * @returns {{read: () => Promise<T>, remember: (value: T) => void}}
 */
export function createStateReadCache(readThrough, { ttlMs = STATE_READ_TTL_MS, now = Date.now } = {}) {
  let cached = undefined;
  let cachedAt = 0;
  return {
    /**
     * 读值：TTL 内返回缓存，过期则穿透到 `readThrough`。
     * @returns {Promise<T>}
     */
    async read() {
      if (cached !== undefined && now() - cachedAt < ttlMs) return cached;
      cached = await readThrough();
      cachedAt = now();
      return cached;
    },
    /**
     * 写路径用：把刚写入的值直接放进缓存，省掉下一次读盘，并保证自己的写入
     * 立刻对自己可见（不必等 TTL）。语义与 `read()` 一致，只是来源可信。
     * @param {T} value - 刚写入并解析后的值。
     * @returns {void}
     */
    remember(value) {
      cached = value;
      cachedAt = now();
    }
  };
}

/**
 * Read a state file as JSON, or `null` when it is absent, unreadable, or not
 * JSON. Anything unrecognised reads as "nothing stored" — the safe direction
 * for every consumer (one extra attempt / one re-fetch / the config default
 * rules again), never a crash.
 * @param {string} file - the file path.
 * @returns {Promise<unknown>} the parsed value, or `null`.
 */
export async function readStateJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}