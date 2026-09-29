/**
 * 状态文件公共原语 —— 把三个 store（throttle / catalog / provider）此前各自
 * 手写的同一段"版本载荷 + temp 文件 + rename 原子 + 0600 + 损坏即忽略"收敛
 * 到这里（docs/IMPROVEMENTS.md §4.1 第一步）。
 *
 * peer-free 与三个 store 同纪律：不 import 任何 Host peer，纯 `node:fs`，
 * 离线可测（store.test.mjs 直接注入 dir 构造即可）。
 *
 * 行为约定（与三个 store 的历史实现逐一对齐）：
 *   - 目录：`$DSH_HOME/state/<name>`——与 Host 自己的目录并列，而不是在
 *     `logs/`（trace 轮转会按日志清扫，状态文件不能跟着被扫走）。
 *   - 写：临时文件（0600，owner-only）→ `rename` 原子落位。**失败抛错**，
 *     是否吞错是各 store 的语义（throttle/catalog 面对只读 Home 选择吞、
 *     provider 面板开关交给调用方的错误路径），原语不做决定。
 *   - 临时名：进程 + 时间戳后缀。固定临时名会让两个 Host 进程的写落到同一
 *     路径、互相 `rename` 掉对方写了一半的文件（catalog-store 早已用此策略，
 *     本次顺手把 throttle/provider 的固定名/各自实现一并统一）。
 *   - 读：缺失、不可读、非 JSON 一律返回 `null`——"损坏即忽略"的方向。
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