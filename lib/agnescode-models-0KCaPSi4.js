import { A as obj, D as num, F as str, i as PROBED_VISION, k as numZeroOk, w as name } from "./llm-models-Bep2p7Tp.js";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createDecipheriv } from "node:crypto";

//#region src/host/state-store.ts
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

* @module dsh-connect-agnes-token-plan/state-store

*/
/**

* The DSH home: `$DSH_HOME` when the operator exported one, else `~/.dsh`.

* @returns {string} the home directory.

*/
function dshHome() {
	return str(process.env.DSH_HOME, join(homedir(), ".dsh"));
}
/**

* Where this plugin keeps state: `$DSH_HOME/state/<name>`.

* @param {string} name - the plugin's own state directory name

*   (`host-config.ts`'s `name`).

* @returns {string} the directory.

*/
function stateDir(name) {
	return join(dshHome(), "state", name);
}
/**

* 单个 profile 名的形态约束。它会直接成为磁盘路径的一段，所以这里按

* **外部输入**处理，而不是信任 Host 给的值。

*

* 规则与它的用途一一对应：

*   - 字符集限制（`[A-Za-z0-9._-]`）——排除路径分隔符与任何 traversal 形状；

*   - 不以点开头——顺带排掉 `.` 与 `..` 这两个唯一能让单段路径逃逸的名字；

*   - 长度上限——防超长目录名（Windows 路径上限、以及某些文件系统的 NAME_MAX）。

*

* 为什么不用白名单枚举已知 profile 名：集合是开放的（用户可以任意新建

* profile，本插件不该认识它们），白名单会把新 profile 错判成"拿不到名字"。

*/
const PROFILE_SEGMENT_MAX = 64;
const PROFILE_SEGMENT_RE = /^(?!\.)[A-Za-z0-9._-]+$/;
/**

* Is this string safe to use as ONE path segment?

* @param {unknown} value - candidate profile name.

* @returns {boolean} true when it survives {@link PROFILE_SEGMENT_RE}.

*/
function isProfileSegment(value) {
	if (typeof value !== "string") return false;
	const name = value.trim();
	if (name === "" || name.length > PROFILE_SEGMENT_MAX) return false;
	return PROFILE_SEGMENT_RE.test(name);
}
/**

* 当前这台 Host 跑在哪个 profile 下，取不到就返回 `null`。

*

* **怎么读它**：`ctx.get(name)` —— Cordis 自己的 "read a service without the

* inject requirement" 入口，未提供时安静返回 `undefined`。注意**别用属性访问**

* 去探：`ctx.profileContext` 会在服务缺失时**抛错**（`cannot get property

* "profileContext" without inject`，cordis `lib/index.js:676`）——这是本插件

* 实测踩到的，不是推测。`readOptionalService` 把两个入口都包了，属性访问只作为

* 测试桩的兜底留在最后。

*

* **为什么不用 `inject` 声明它**：`inject` 里的是**硬依赖**（`lib/index.js:688`

* 的报错文案就叫 "cannot get required service"），缺了 Cordis 根本不加载本插件。

* 而 `profileContext` 在官方 runtime 里是**可选**的（`@linxin666/

* dsh-client-ui-plugin-manager` 明确处理了"host 隐藏了它"的情形，

* `dsh-better-sidebar` 同理）。把它变成硬依赖，会让那些主机上整个插件消失

* （面板、额度、provider 全挂），代价远大于收益。

*

* **为什么不读 `DSH_PROFILE`**：在那个 runtime 里它是 OUTPUT 而非输入——由

* `runProfile()` 派生给子进程（`dsh-shell-env` 做的事），"no runtime module

* reads it to choose a profile"。手设或陈旧的值会把状态写进一个"这台 Host

* 根本不读"的 profile。

*

* 取到 = 调用方据此分段；取不到 = **退回今天的全局路径**，行为零漂移。

*

* @param {object} [ctx] - the Cordis context the Host handed `apply()`.

* @returns {string|null} the profile name, or `null` when unavailable/unsafe.

*/
function profileSegment(ctx) {
	if (ctx === null || typeof ctx !== "object") return null;
	const raw = readOptionalService(ctx, "profileContext");
	if (raw === null || typeof raw !== "object") return null;
	const name = raw.name;
	return isProfileSegment(name) ? name.trim() : null;
}
/**

* 读一个**可选**服务，三种入口依次尝试。

*

* 1. `ctx.get(name)` —— Cordis 的官方无 inject 读法（`ReflectService.get`），也是

*    `startSideEffects` 读可选 `settings` 服务用的同一入口。首选。

* 2. `ctx.reflect.get(name, false)` —— 底层等价物，宿主未把 mixin 挂出来时用。

* 3. `ctx[name]` 直接取属性 —— 手写测试桩的形状。**留在最后**：在真 Cordis 上

*    访问一个未声明且未提供的服务会抛（`... without inject`），必须包着 try。

*

* 三者都拿不到就是"这台 Host 没有这个服务"，调用方据此降级；这里永不抛错，

* 因为一个探测不到的可选服务不该让插件挂掉。

* @param {object} ctx - the Cordis context.

* @param {string} name - the service name.

* @returns {unknown} the service value, or `undefined`.

*/
function readOptionalService(ctx, name) {
	if (typeof ctx.get === "function") try {
		return ctx.get(name);
	} catch {}
	const reflect = ctx.reflect;
	if (reflect && typeof reflect.get === "function") try {
		return reflect.get(name, false);
	} catch {}
	try {
		return ctx[name];
	} catch {
		return;
	}
}
/**

* Per-profile state directory: `$DSH_HOME/state/<profile>/<name>`.

*

* Which states use this and which keep {@link stateDir} is a deliberate split,

* not an inconsistency — see PITFALLS §23. Briefly: the three switch-shaped

* states (catalog / provider / draw) answer "what does THIS profile want", so

* two profiles must not overwrite each other; the throttle answers "how long

* did the upstream tell US to wait" and the credentials grant answers "who are

* you", both of which are per-machine and are INTENDED to cross profiles.

*

* `profile` being `null` degrades to the shared directory, so every old host,

* every test and every in-process construction behaves exactly as before.

* @param {string} name - the plugin's own state directory name.

* @param {string|null} [profile] - the profile name; `null` means shared.

* @returns {string} the directory.

*/
function profileStateDir(name, profile) {
	return profile ? join(dshHome(), "state", profile, name) : stateDir(name);
}
/**

* Make the state directory exist (owner-only), created on demand.

*

* A read-only Home throws — callers wrap this in their own policy (the

* throttle/catalog writers swallow it, the provider switch does not).

* @param {string} dir - the state directory.

* @returns {Promise<void>}

*/
async function ensureStateDir(dir) {
	await mkdir(dir, {
		recursive: true,
		mode: 448
	});
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
function temporaryOf(dir, base, now = Date.now) {
	return join(dir, `${base}.${process.pid}.${now()}.tmp`);
}
/**

* Write one state file atomically: a 0600 temporary file, then a rename.

*

* The payload string is written with a trailing newline, exactly as every

* store wrote before this module existed. Failures PROPAGATE — the callers

* decide whether a read-only Home breaks their flow.

* @param {string} file - the final file path.

* @param {string|object} payload - serialized JSON text, or a JSON-able object
*   (the string form is written verbatim; an object is `JSON.stringify`-ed, which
*   makes the documented `[object Object]` trap, PITFALLS §36, impossible here;
*   `null` / `undefined` / a bare primitive throw rather than land as literal text)

* @param {{temporary: string}} options - the temp path to write first.

* @returns {Promise<void>}

*/
async function writeStateFile(file, payload, { temporary }) {
	let body;
	if (typeof payload === "string") body = payload;
	else if (payload !== null && typeof payload === "object") body = JSON.stringify(payload);
	else throw new Error(`writeStateFile(${file}): payload must be a JSON string or an object, got ${payload === null ? "null" : typeof payload}`);
	await writeFile(temporary, `${body}\n`, {
		encoding: "utf8",
		mode: 384
	});
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
const STATE_READ_TTL_MS = 1e3;
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

* `inheritFrom` 是 §23 的一次性迁移缝：按 profile 分段后，本 profile 的新文件

* 一开始并不存在，而旧版把值放在**所有 profile 共享**的目录里。给了它以后，

* 读穿透发现自己的记录缺失时会去旧路径取一次、回填、再返回——**只尝试一次**

* （`adopted` 标志），所以它不会变成每个 TTL 周期都多读一个文件。

*

* 为什么让缓存原语承担这件事，而不是在外面先跑一遍迁移脚本：迁移就有了时序，

* 而"先迁移、再 seed"在 `apply()` 的同步构造里排不出确定顺序。挂在读穿透上

* 则天然正确——任何读到"空"的地方都会自动拿到旧值，且与并发进程无关（读到

* 同一份旧值、写同一份结果）。

*

* @template T

* @param {() => Promise<T|null>} readThrough - 真正的读盘 + 解析；返回 `null` 表示无可用记录。

* @param {object} [options]

* @param {number} [options.ttlMs] - 缓存有效期，默认 {@link STATE_READ_TTL_MS}。

* @param {() => number} [options.now] - 时钟源；测试注入。

* @param {{read: () => Promise<T|null>, write: (value: T) => Promise<void>}|null} [options.inheritFrom]

*   - 旧版共享布局（`read`）与把它回填到本 profile（`write`）；`null` = 不迁移。

* @returns {{read: () => Promise<T|null>, remember: (value: T|null) => void}}

*/
function createStateReadCache(readThrough, { ttlMs = STATE_READ_TTL_MS, now = Date.now, inheritFrom = null } = {}) {
	let cached = void 0;
	let cachedAt = 0;
	/** Whether the one-shot legacy adoption has already been attempted. */
	let adopted = false;
	/**
	
	* 读穿透：自己的记录优先；缺失且还有旧布局可继承时，取一次旧值并回填。
	
	* @returns {Promise<T|null>}
	
	*/
	const load = async () => {
		const own = await readThrough();
		if (own !== null || inheritFrom === null || adopted) return own;
		adopted = true;
		const inherited = await inheritFrom.read();
		if (inherited === null) return null;
		try {
			await inheritFrom.write(inherited);
		} catch {}
		return inherited;
	};
	return {
		/**
		
		* 读值：TTL 内返回缓存，过期则穿透到 `load()`。
		
		* @returns {Promise<T|null>}
		
		*/
		async read() {
			if (cached !== void 0 && now() - cachedAt < ttlMs) return cached;
			cached = await load();
			cachedAt = now();
			return cached;
		},
		/**
		
		* 写路径用：把刚写入的值直接放进缓存，省掉下一次读盘，并保证自己的写入
		
		* 立刻对自己可见（不必等 TTL）。语义与 `read()` 一致，只是来源可信。
		
		* @param {T|null} value - 刚写入并解析后的值。
		
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
async function readStateJson(file) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

//#endregion
//#region src/host/catalog-store.ts
/**
* The persisted model catalog — this plugin's OWN state file, never the Host's
* configuration.
*
* Why a file at all: the directly-registered LLM provider needs a model list
* before the first snapshot poll completes (and after a restart with no console
* login), so the last catalog the API key fetched is cached under
* `$DSH_HOME/state/<plugin>/catalog.json`. It is deliberately NOT written into
* the settings row (`cordis.patch.yml`): a catalog is operational state, not an
* operator decision, and writing volatile arrays into the patch layer is the
* shape the WorkBuddy catalog drift warned about.
*
* Integrity follows `throttle-store.ts`: a versioned payload, a temp file plus
* an atomic rename (two Host processes can share the directory), owner-only
* modes, and "anything unrecognised reads as no catalog" — a corrupted or
* downgraded file costs one re-fetch, never a crash.
*
* @module dsh-connect-agnes-token-plan/catalog-store
*/
/** Shape version, bumped when the persisted form changes incompatibly. */
const CATALOG_VERSION = 1;
/**
* Normalize a model-id allow-list.
*
* An EMPTY list means "no filter" (the WorkBuddy convention): a fresh install
* has curated nothing and must still be offered every model. Once non-empty it
* is an allow-list. Junk entries are dropped rather than stored.
* @param {unknown} raw - the persisted or posted list.
* @returns {string[]} unique string ids in first-seen order.
*/
function normalizeEnabledIds(raw) {
	if (!Array.isArray(raw)) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const item of raw) {
		const id = str(item, "");
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}
/**
* The directory this plugin's state lives in — per-profile when the Host names
* one, shared otherwise (PITFALLS §23).
* @param {string|null} [profile] - the profile name; `null` means shared.
* @returns {string} the directory.
*/
function catalogDir(profile) {
	return profileStateDir(name, profile);
}
/**
* Normalize a raw catalog into unique, whole entries.
*
* Mirrors `console-client.fetchModelCatalog`: keep every field the platform
* sent (vision identification reads `input_modalities`), normalize `id`, and
* drop entries without one. Duplicate ids keep the LAST occurrence — the
* freshest read wins — and stay in first-seen order.
* @param {unknown} raw - the raw `body.data` array or persisted entries.
* @returns {object[]} normalized entries.
*/
function normalizeEntries(raw) {
	if (!Array.isArray(raw)) return [];
	const byId = /* @__PURE__ */ new Map();
	for (const item of raw) {
		const source = obj(item);
		const id = str(source.id, "");
		if (id === "") continue;
		byId.set(id, {
			...source,
			id
		});
	}
	return [...byId.values()];
}
/**
* Parse a persisted catalog, or `null` when it is absent, stale, or foreign.
*
* The safe direction for a cache is "absent": the next snapshot re-fetches.
*
* **Exported so there is exactly one reader of this file's meaning.** The
* doctor survey used to keep a second copy (PITFALLS §34's "extract the
* primitive is not extracting it to this layer": the four switch stores were
* re-exported, this one was missed because `parse` was private). The two
* copies disagreed — this gate is a whole-record verdict, while the doctor's
* fell back to `fetchedAt:0` and asked only whether the entry list was empty,
* so a record this function rejects could be reported as a healthy catalogue.
* @param {unknown} raw - the parsed file contents.
* @returns {{version: number, fetchedAt: number, entries: object[], enabledModelIds: string[]}|null}
*/
function parseCatalogPayload(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const body = raw;
	if (num(body.version, 0) !== 1) return null;
	const fetchedAt = num(body.fetchedAt, 0);
	if (fetchedAt <= 0) return null;
	const entries = normalizeEntries(body.entries);
	const enabledModelIds = normalizeEnabledIds(body.enabledModelIds);
	return {
		version: 1,
		fetchedAt,
		entries,
		enabledModelIds
	};
}
/**
* The store contract both the file-backed and in-memory factories satisfy:
* one cached catalog of model entries plus a curated id allow-list.
* @typedef {object} CatalogStore
* @property {() => Promise<object[]>} list - stored entries, `[]` when none usable.
* @property {() => Promise<string[]>} listEnabledIds - allow-list; `[]` means "no filter".
* @property {(entries: object[], enabledModelIds?: string[]) => Promise<boolean>} replace - swap the catalog, preserving the allow-list unless given a new one; returns whether the record actually reached disk.
* @property {(ids: string[]) => Promise<boolean>} setEnabledIds - swap ONLY the allow-list; same return contract.
* @property {() => Promise<void>} clear - remove the stored catalog.
*/
/**
* A catalog store backed by one atomically-written file.
* @param {object} [options] - wiring.
* @param {string} [options.dir] - directory; overrides {@link options.profile}.
* @param {string|null} [options.profile] - the profile name, so two profiles
*   each get their own catalog instead of overwriting one shared allow-list;
*   defaults to `null` (the shared directory, i.e. today's behaviour).
* @param {() => number} [options.now] - clock source; injected by the tests.
* @param {number} [options.ttlMs] - how long a parsed record may be reused
*   before disk is consulted again; defaults to {@link STATE_READ_TTL_MS}.
* @returns {CatalogStore} the store.
*/
function createFileCatalogStore(options = {}) {
	const { dir, profile = null, now = Date.now, ttlMs = STATE_READ_TTL_MS } = options;
	const stateDir$1 = dir ?? catalogDir(profile);
	const file = join(stateDir$1, "catalog.json");
	/**
	* Last known record, mirrored from {@link cache} so the writers can reuse the
	* allow-list without a second read. `undefined` means "never synced from
	* disk", `null` means "synced, nothing usable stored".
	* @type {{version: number, fetchedAt: number, entries: object[], enabledModelIds: string[]}|null|undefined}
	*/
	let held;
	const legacyFile = dir === void 0 && profile ? join(stateDir(name), "catalog.json") : null;
	const cache = createStateReadCache(async () => parseCatalogPayload(await readStateJson(file)), {
		ttlMs,
		now,
		inheritFrom: legacyFile === null ? null : {
			/** The pre-§23 record, if this machine ever wrote one. */
			read: async () => parseCatalogPayload(await readStateJson(legacyFile)),
			/** Re-persist an inherited record under this profile's own directory. */
			write: async (record) => {
				held = record;
				await persist();
			}
		}
	});
	/** Sync `held` with disk (through the TTL cache) and return it. */
	const seen = async () => {
		held = await cache.read();
		return held;
	};
	/**
	* Persist the held record atomically; a write failure only loses the cache.
	*
	* The temp path is process-plus-clock unique (`state-store.ts`'s
	* `temporaryOf`), so two Host processes sharing this directory never write
	* the same temp name and `rename` each other's half-written file away.
	*
	* Returns whether the record actually reached disk. The failure is still
	* swallowed — a read-only Home must not break the panel — but the caller has
	* to know it happened: an in-memory record the disk does not hold must not
	* be treated as settled (PITFALLS §40).
	* @returns {Promise<boolean>} `true` when disk now holds `held`, `false` when the write failed.
	*/
	const persist = async () => {
		if (held === null) return true;
		const temporary = temporaryOf(stateDir$1, "catalog.json", now);
		try {
			await ensureStateDir(stateDir$1);
			await writeStateFile(file, JSON.stringify(held), { temporary });
			return true;
		} catch {
			await rm(temporary, { force: true }).catch(() => {});
			return false;
		}
	};
	return {
		/**
		* The stored entries, or `[]` when nothing usable is stored.
		* @returns {Promise<object[]>}
		*/
		async list() {
			const record = await seen();
			return record === null ? [] : record.entries;
		},
		/**
		* The curated model-id allow-list; an EMPTY array means "no filter".
		* @returns {Promise<string[]>}
		*/
		async listEnabledIds() {
			const record = await seen();
			return record === null ? [] : record.enabledModelIds;
		},
		/**
		* Atomically replace the stored catalog.
		*
		* A read-only Home must not break the panel: the write failing only means
		* the catalog is re-fetched after the next restart, so the error is
		* swallowed after the in-memory copy is updated. The curated allow-list is
		* PRESERVED across a catalog refresh unless a new one is supplied.
		* @param {object[]} entries - the fresh catalog entries.
		* @param {string[]} [enabledModelIds] - an optional replacement allow-list.
		* @returns {Promise<boolean>} whether the record reached disk.
		*/
		async replace(entries, enabledModelIds) {
			const current = await seen();
			const kept = current === null ? [] : current.enabledModelIds;
			held = {
				version: 1,
				fetchedAt: now(),
				entries: normalizeEntries(entries),
				enabledModelIds: enabledModelIds === void 0 ? kept : normalizeEnabledIds(enabledModelIds)
			};
			cache.remember(held);
			return persist();
		},
		/**
		* Replace ONLY the curated allow-list, keeping the cached catalog.
		* @returns {Promise<boolean>} whether the record reached disk.
		*/
		async setEnabledIds(ids) {
			const current = await seen();
			const entries = current === null ? [] : current.entries;
			const fetchedAt = current === null ? now() : current.fetchedAt;
			held = {
				version: 1,
				fetchedAt,
				entries,
				enabledModelIds: normalizeEnabledIds(ids)
			};
			cache.remember(held);
			return persist();
		},
		/** Remove the stored catalog (used when the API key is forgotten). */
		async clear() {
			held = null;
			cache.remember(null);
			try {
				await rm(file, { force: true });
				return true;
			} catch {
				return false;
			}
		}
	};
}

//#endregion
//#region src/host/agnescode.ts
/**
* The AgnesCode（爱思编程）protocol layer — the pure, peer-free API half of the
* third upstream provider (ROADMAP §6.3 "third upstream").
*
* This is the plugin's FIRST "local-login-state harvest" line (the workbuddy /
* qoder / trae precedent family, §5.3): the credential is NOT obtained by a
* login this plugin performs — the user signs into the AgnesCode desktop App
* (WeChat scan, `app_id: agnes`), the App encrypts its session file with
* Chromium os_crypt, and this module reads THAT file. Nothing here writes to
* the App's directory; the harvested JWT lands in the DSH credentials service
* (`agnescode-store.ts`), never in this plugin's directory, git, or logs
* (red line 1).
*
* Wire facts this module encodes (all probed live 2026-10-01, ROADMAP §6.3):
*   - the session file is `%APPDATA%/AgnesCode/code-auth-session.cn.v1`,
*     Chromium os_crypt: `v10` prefix + AES-256-GCM, key = DPAPI-unwrapped
*     `os_crypt.encrypted_key` from the sibling `Local State` JSON;
*   - the decrypted JSON carries `accessToken` (JWT, ~28-day `exp`), the user
*     object, and `bffPublicBaseUrl` — the per-account API base, which is why
*     NO base URL is hardcoded here (the reference reverse-proxy pins the
*     INTERNATIONAL `.com` host as a constant — the same trap video.ts hit);
*   - chat is plain OpenAI-compatible `{bff}/chat/completions`; models list at
*     `{bff}/models` (needs `X-App-Id: 1` + `X-Platform: 1`); the credit pool
*     lives OUTSIDE the `/v1` prefix at `{origin}/api/v2/subscription/
*     credits-balance` (a subscription-pool envelope, NOT Token Plan semantics).
*
* Safety stance for third-party data: `bffPublicBaseUrl` is PINNED to the
* Agnes origin family (https + `*.agnes-ai.cn` / `*.agnes-ai.com`) before any
* Authorization header is aimed at it — a corrupted or hostile session file
* must not be able to redirect the stored token to a foreign host.
*
* Everything here takes injected io/fetchers and pure data, so the offline
* suites exercise it without a network or a real DPAPI call; no Host peer is
* imported.
*
* @module dsh-connect-agnes-token-plan/agnescode
*/
/** The model-catalogue request headers the BFF gates on (probed: required). */
const AGNESCODE_CATALOG_HEADERS = Object.freeze({
	"X-App-Id": "1",
	"X-Platform": "1"
});
/** The request-language header the desktop client sends. */
const AGNESCODE_LANGUAGE_HEADER = "X-User-Language";
/**
* The session-file name pattern, matched case-insensitively against the App's
* roaming directory. The CN build ships `code-auth-session.cn.v1`; other
* region variants (`code-auth-session.v1`, a future `.com` tag) share the
* shape, so the harvest matches the FAMILY rather than one literal — but each
* match is diagnosed individually and the first usable one wins.
*/
const AGNESCODE_SESSION_FILE_PATTERN = /^code-auth-session[^/\\]*\.v1$/i;
/** Where the desktop App keeps its Chromium profile, per platform. */
const AGNESCODE_APP_DATA_CANDIDATES = Object.freeze([
	{
		platform: "win32",
		dirEnv: "APPDATA",
		leaf: "AgnesCode"
	},
	{
		platform: "darwin",
		dirEnv: "HOME",
		leaf: "Library/Application Support/AgnesCode"
	},
	{
		platform: "linux",
		dirEnv: "HOME",
		leaf: ".config/AgnesCode"
	}
]);
/**
* The LOOSE family pattern — anything that reads like the session file. When
* no strict match exists but a loose one does, the App has moved to a new file
* shape: that is the FORMAT_DRIFT fact, not「文件不存在」. Shared by the walk
* and the doctor survey so the two never disagree about what「像会话文件」means.
*/
const AGNESCODE_SESSION_FAMILY_PATTERN = /^code-auth-session/i;
/**
* The App-data candidate directories for one env + platform, in walk order.
* A candidate whose env base is unset drops out. Single source of truth —
* the harvest walk and the doctor survey must resolve the same dirs.
* @param {any} env - the process env.
* @param {string} platform - `process.platform`.
* @returns {string[]} candidate directory paths (empty = platform unknown).
*/
function resolveAgnescodeAppDirs(env, platform) {
	return AGNESCODE_APP_DATA_CANDIDATES.filter((candidate) => candidate.platform === platform).map((candidate) => {
		const base = str(env[candidate.dirEnv], "");
		return base === "" ? null : `${base.replace(/[\\/]+$/, "")}/${candidate.leaf}`;
	}).filter(Boolean);
}
/**
* Classify one directory listing against the session file family.
* `drift` is only read when `matched` is empty: a strict match wins, and an
* unrecognizable sibling next to a readable file is noise (an App-kept backup),
* not evidence of format change.
* @param {string[]} fileNames - names from one app-directory listing.
* @returns {{matched: string[], drift: string[]}} harvestable vs unreadable-shape family members.
*/
function classifyAgnescodeSessionFiles(fileNames) {
	const names = Array.isArray(fileNames) ? fileNames : [];
	const matched = names.filter((name) => AGNESCODE_SESSION_FILE_PATTERN.test(name));
	return {
		matched,
		drift: matched.length === 0 ? names.filter((name) => AGNESCODE_SESSION_FAMILY_PATTERN.test(name)) : []
	};
}
/**
* The tiers of a failed harvest, one per row of the panel's diagnosis list
* (the workbuddy five-tier discipline, restated for this file family). The
* tiers deliberately split "the App is not here" from "the App is here but we
* cannot read its crypto" — they want different user advice.
*
* FORMAT_DRIFT exists for the week-scale silent failure this reverse-engineered
* format makes possible: when the desktop App updates its session file to a
* new shape, a strict-pattern miss reads as FILE_MISSING — indistinguishable
* from "signed out" — while the JWT harvested earlier keeps working for up to
* 28 days, and every「重新登录再检测」round trips back to the same row. Naming
* the orphaned family member turns「你没登录」into「格式变了，升级插件」at the
* FIRST detection click instead of at the day the token finally dies.
*/
const AGNESCODE_HARVEST_TIER = Object.freeze({
	FILE_MISSING: "file_missing",
	FORMAT_DRIFT: "format_drift",
	UNREADABLE: "unreadable",
	MALFORMED: "malformed",
	NO_KEY: "no_key",
	DECRYPT_FAILED: "decrypt_failed",
	NO_TOKEN: "no_token",
	UNTRUSTED_BASE: "untrusted_base",
	UNSUPPORTED_PLATFORM: "unsupported_platform",
	OK: "ok"
});
/**
* Catalogue rows that are NOT models and must never reach the roster.
*
* `/v2/models` adds an `auto` row that `/v1/models` does not have. It is a
* routing alias (no vendor, no `points_cost_multiplier`, and the only row the
* platform omits the price on), so offering it as a selectable model would put
* a non-model in the picker. Keyed by id on purpose: a rule tied to "has no
* multiplier" would silently start leaking `auto` back in the day the platform
* prices it.
*/
const AGNESCODE_CATALOGUE_EXCLUDED_IDS = Object.freeze(["auto"]);
/**
* Whether a BFF base may carry the account's Authorization header. Pinned to
* the Agnes origin family over https — see the module header. Anything else
* reads as `UNTRUSTED_BASE` and the harvest keeps walking.
* @param {unknown} value - the `bffPublicBaseUrl` from the session file.
* @returns {string|null} the normalized base (no trailing slash), or `null`.
*/
function trustAgnescodeBffBase(value) {
	if (typeof value !== "string" || value.trim() === "") return null;
	let url;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	if (url.port !== "") return null;
	const host = url.hostname.toLowerCase();
	if (!(host === "agnes-ai.cn" || host === "agnes-ai.com" || host.endsWith(".agnes-ai.cn") || host.endsWith(".agnes-ai.com"))) return null;
	return url.origin + url.pathname.replace(/\/+$/, "");
}
/**
* Parse one DECRYPTED session document into the shape the store persists.
* Malformed input reads as `null`, never throws — one re-harvest, never a
* crash. Only secret-FREE facts plus the token itself survive; the raw user
* object (avatar URL, provider ids) is dropped, not stored.
* @param {unknown} raw - the decrypted JSON value.
* @returns {{accessToken: string, userId: string, nickname: string, bffBase: string}|null}
*/
function parseAgnescodeSession(raw) {
	const source = obj(raw);
	const accessToken = str(source.accessToken, "");
	if (accessToken === "") return null;
	const bffBase = trustAgnescodeBffBase(source.bffPublicBaseUrl);
	if (bffBase === null) return null;
	const user = obj(source.userInfo);
	return {
		accessToken,
		userId: str(user.id, ""),
		nickname: str(user.username, ""),
		bffBase
	};
}
/**
* Derive the API root the account-scoped (`/api/...`) endpoints address —
* the BFF base WITHOUT its `/v1` suffix. The credits endpoint does NOT live
* under `/v1` (probed: `{origin}/api/v2/...`), so a caller that concatenated
* the full base would 404.
* @param {string} bffBase - a {@link trustAgnescodeBffBase}-normalized base.
* @returns {string} the origin (plus any non-`/v1` prefix, preserved).
*/
function agnescodeApiRoot(bffBase) {
	const base = str(bffBase, "").replace(/\/+$/, "");
	return base.endsWith("/v1") ? base.slice(0, -3) : base;
}
/** Decode a JWT's `exp` claim to MILLISECONDS; `undefined` on any failure. */
function decodeAgnescodeJwtExpMs(token) {
	if (typeof token !== "string" || token.length === 0) return void 0;
	const parts = token.split(".");
	if (parts.length < 2) return void 0;
	try {
		const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return void 0;
		const seconds = num(payload.exp);
		return typeof seconds === "number" ? seconds * 1e3 : void 0;
	} catch {
		return;
	}
}
/**
* The header set one AgnesCode BFF request carries. The catalogue headers
* (`X-App-Id` / `X-Platform`) were probed REQUIRED on the catalogue endpoint
* and are harmless elsewhere; the language header mirrors the desktop client.
* The catalogue moved from `/v1/models` to `{origin}/v2/models` on 2026-10-04
* and the same header set answers 200 there (re-probed live, so this map did
* not need to change with the endpoint).
* @param {object} credential - `{ accessToken }`.
* @returns {object} the header map.
*/
function agnescodeHeaders(credential) {
	return {
		Accept: "application/json",
		"Content-Type": "application/json",
		Authorization: `Bearer ${str(obj(credential).accessToken, "")}`,
		...AGNESCODE_CATALOG_HEADERS,
		[AGNESCODE_LANGUAGE_HEADER]: "zh-Hans"
	};
}
/**
* Chromium os_crypt blob → plaintext: strip the `v10` prefix, AES-256-GCM with
* a 12-byte nonce and a trailing 16-byte auth tag.
* @param {Buffer|Uint8Array} blob - the raw session-file bytes.
* @param {Buffer|Uint8Array} key - the 32-byte os_crypt key (already unwrapped).
* @returns {Buffer} the decrypted bytes.
* @throws when the prefix, the key size, or the auth tag does not match.
*/
function decryptAgnescodeSessionBlob(blob, key) {
	const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob ?? []);
	const keyBytes = Buffer.isBuffer(key) ? key : Buffer.from(key ?? []);
	if (keyBytes.length !== 32) throw new Error(`os_crypt key must be 32 bytes, got ${keyBytes.length}`);
	const prefix = bytes.subarray(0, 3).toString("latin1");
	if (prefix !== "v10") throw new Error(`unexpected session-blob prefix ${JSON.stringify(prefix)}`);
	const body = bytes.subarray(3);
	if (body.length < 28) throw new Error("session blob too short for nonce + tag");
	const nonce = body.subarray(0, 12);
	const tag = body.subarray(body.length - 16);
	const ciphertext = body.subarray(12, body.length - 16);
	const decipher = createDecipheriv("aes-256-gcm", keyBytes, nonce);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
/**
* Unwrap the os_crypt key from a `Local State` document. The stored value is
* base64 of `DPAPI` + the DPAPI-protected key bytes; the DPAPI call itself is
* injected (the real one is a PowerShell child process — no native deps).
* @param {unknown} localStateRaw - the parsed (or raw) `Local State` JSON.
* @param {(wrapped: Buffer) => Promise<Buffer>} dpapiUnprotect - injected DPAPI.
* @returns {Promise<Buffer>} the 32-byte os_crypt key.
* @throws on any shape mismatch — the caller maps it to `NO_KEY`/`DECRYPT_FAILED`.
*/
async function unwrapAgnescodeLocalStateKey(localStateRaw, dpapiUnprotect) {
	let source;
	if (typeof localStateRaw === "string" || Buffer.isBuffer(localStateRaw) || localStateRaw instanceof Uint8Array) {
		const text = typeof localStateRaw === "string" ? localStateRaw : Buffer.from(localStateRaw).toString("utf8");
		try {
			source = JSON.parse(text);
		} catch {
			throw new Error("Local State is not valid JSON");
		}
	} else source = obj(localStateRaw);
	const encryptedKeyB64 = str(obj(obj(source).os_crypt).encrypted_key, "");
	if (encryptedKeyB64 === "") throw new Error("Local State carries no os_crypt.encrypted_key");
	const wrapped = Buffer.from(encryptedKeyB64, "base64");
	if (wrapped.length < 6 || wrapped.subarray(0, 5).toString("latin1") !== "DPAPI") throw new Error("os_crypt.encrypted_key lacks the DPAPI prefix");
	return dpapiUnprotect(wrapped.subarray(5));
}
/**
* The production DPAPI unwrap: a PowerShell child process. No native addon and
* no build step (the Host half is build-free, ROADMAP §6.2), and the unwrapped
* key transits the stdout pipe IN MEMORY — it is never printed, logged, or
* written anywhere. Runs only on win32; every other platform maps to
* `UNSUPPORTED_PLATFORM` upstream of this call.
* @param {Buffer} wrapped - the DPAPI-protected key bytes.
* @returns {Promise<Buffer>} the unwrapped key bytes.
*/
async function defaultDpapiUnprotect(wrapped) {
	const { spawn } = await import("node:child_process");
	const script = [
		"Add-Type -AssemblyName System.Security",
		"$in = [Console]::OpenStandardInput()",
		"$ms = New-Object IO.MemoryStream",
		"$in.CopyTo($ms)",
		"$pt = [Security.Cryptography.ProtectedData]::Unprotect($ms.ToArray(), $null, 'CurrentUser')",
		"[Console]::OpenStandardOutput().Write($pt, 0, $pt.Length)"
	].join("; ");
	return new Promise((resolve, reject) => {
		const child = spawn("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		], {
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		const chunks = [];
		let failure = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(/* @__PURE__ */ new Error("DPAPI unprotect timed out (10s)"));
		}, 1e4);
		child.stdout.on("data", (chunk) => chunks.push(chunk));
		child.stderr.on("data", (chunk) => {
			failure += chunk.toString();
		});
		child.stdin.on("error", () => {});
		child.on("error", (why) => {
			clearTimeout(timer);
			reject(why);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(/* @__PURE__ */ new Error(`DPAPI unprotect failed (exit ${code})${failure ? `: ${failure.slice(0, 200)}` : ""}`));
				return;
			}
			resolve(Buffer.concat(chunks));
		});
		child.stdin.write(wrapped);
		child.stdin.end();
	});
}
/**
* Harvest the AgnesCode session from the local desktop App — the walk behind
* the panel's「重新检测」. One diagnostic row per candidate file, in the order
* the candidates were tried; the FIRST usable session wins and the walk stops.
* A walk that finds nothing usable returns `ok: false` WITH the rows, so the
* panel can show exactly what was probed and why it failed (the workbuddy
* discipline: never a bare "not logged in" when the App state is the problem).
*
* The token appears ONLY in the return value's `session` — the `attempts` rows
* carry tier codes and shape facts (lengths, file sizes), never values.
* @param {object} [options]
* @param {object} [options.env] - the process env (defaults to `process.env`).
* @param {object} [options.platform] - `process.platform` (defaults to real).
* @param {(path: string) => Promise<Buffer>} [options.readFile] - injected reader.
* @param {(path: string) => Promise<string[]>} [options.readDir] - injected lister.
* @param {(wrapped: Buffer) => Promise<Buffer>} [options.dpapiUnprotect] - injected DPAPI.
* @returns {Promise<{ok: boolean, session?: object, attempts: object[]}>}
*/
async function harvestAgnescodeLocalSession(options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const readFile = options.readFile ?? (async (path) => (await import("node:fs/promises")).readFile(path));
	const readDir = options.readDir ?? (async (path) => (await import("node:fs/promises")).readdir(path));
	const dpapiUnprotect = options.dpapiUnprotect ?? defaultDpapiUnprotect;
	/** One tier row: {file, tier, detail?} — detail carries shapes, never values. */
	const attempts = [];
	if (platform !== "win32") return {
		ok: false,
		attempts: [{
			file: null,
			tier: AGNESCODE_HARVEST_TIER.UNSUPPORTED_PLATFORM,
			detail: `no verified harvest path for ${platform} yet (Windows only; macOS reads state.vscdb — unimplemented)`
		}]
	};
	const appDirs = resolveAgnescodeAppDirs(env, platform);
	if (appDirs.length === 0) return {
		ok: false,
		attempts: [{
			file: null,
			tier: AGNESCODE_HARVEST_TIER.UNSUPPORTED_PLATFORM,
			detail: `no app-data candidate for platform ${platform}`
		}]
	};
	for (const appDir of appDirs) {
		let fileNames = [];
		let driftNames = [];
		try {
			const classified = classifyAgnescodeSessionFiles(await readDir(appDir));
			fileNames = classified.matched;
			driftNames = classified.drift;
		} catch {
			attempts.push({
				file: appDir,
				tier: AGNESCODE_HARVEST_TIER.FILE_MISSING,
				detail: "the AgnesCode app directory is absent"
			});
			continue;
		}
		if (fileNames.length === 0) {
			if (driftNames.length > 0) attempts.push({
				file: `${appDir}/${driftNames[0]}`,
				tier: AGNESCODE_HARVEST_TIER.FORMAT_DRIFT,
				detail: `unrecognized session-family file${driftNames.length > 1 ? `s (${driftNames.slice(0, 3).join(", ")})` : ""} — the desktop App may have changed its storage format; update this plugin, then re-detect`
			});
			else attempts.push({
				file: appDir,
				tier: AGNESCODE_HARVEST_TIER.FILE_MISSING,
				detail: "no code-auth-session*.v1 in the app directory"
			});
			continue;
		}
		fileNames.sort((a, b) => a.endsWith(".cn.v1") === b.endsWith(".cn.v1") ? a.localeCompare(b) : a.endsWith(".cn.v1") ? -1 : 1);
		for (const fileName of fileNames) {
			const filePath = `${appDir}/${fileName}`;
			let blob;
			try {
				blob = await readFile(filePath);
			} catch (why) {
				attempts.push({
					file: filePath,
					tier: AGNESCODE_HARVEST_TIER.UNREADABLE,
					detail: why instanceof Error ? why.message : String(why)
				});
				continue;
			}
			let localStateRaw;
			try {
				localStateRaw = await readFile(`${appDir}/Local State`);
			} catch {
				attempts.push({
					file: filePath,
					tier: AGNESCODE_HARVEST_TIER.NO_KEY,
					detail: "the sibling Local State is absent"
				});
				continue;
			}
			let key;
			try {
				key = await unwrapAgnescodeLocalStateKey(localStateRaw, dpapiUnprotect);
			} catch (why) {
				attempts.push({
					file: filePath,
					tier: AGNESCODE_HARVEST_TIER.NO_KEY,
					detail: why instanceof Error ? why.message : String(why)
				});
				continue;
			}
			let plain;
			try {
				plain = decryptAgnescodeSessionBlob(blob, key);
			} catch (why) {
				attempts.push({
					file: filePath,
					tier: AGNESCODE_HARVEST_TIER.DECRYPT_FAILED,
					detail: `${why instanceof Error ? why.message : String(why)} (blob ${blob.length} B)`
				});
				continue;
			}
			let parsed;
			try {
				parsed = JSON.parse(plain.toString("utf8"));
			} catch {
				attempts.push({
					file: filePath,
					tier: AGNESCODE_HARVEST_TIER.MALFORMED,
					detail: "decrypted bytes are not JSON"
				});
				continue;
			}
			const session = parseAgnescodeSession(parsed);
			if (session === null) {
				attempts.push({
					file: filePath,
					tier: str(obj(parsed).accessToken, "") === "" ? AGNESCODE_HARVEST_TIER.NO_TOKEN : AGNESCODE_HARVEST_TIER.UNTRUSTED_BASE,
					detail: "the decrypted session lacks a usable token or a pinned Agnes base"
				});
				continue;
			}
			attempts.push({
				file: filePath,
				tier: AGNESCODE_HARVEST_TIER.OK,
				detail: `JWT ${session.accessToken.length} chars`
			});
			return {
				ok: true,
				session,
				attempts
			};
		}
	}
	return {
		ok: false,
		attempts
	};
}
/**
* Fetch the live model catalogue, or `null` when it cannot be read. The
* adapter falls back to the static roster on `null` (the `console-client`
* silent-fallback discipline).
*
* **Endpoint: `/v2/models`, not `/v1/models`** (switched 2026-10-04). The two
* are different directories on the same host, not the same data: v1 carries 8
* rows and NO credit multiplier, v2 carries 9 rows and the platform's own
* `points_cost_multiplier` on 8 of them (measured live, same token/headers;
* see ROADMAP §6.3.1 「倍率字段正记」). The desktop App reads v2 — that is why
* its picker shows `1.20x` / `1.85x` while this plugin showed nothing.
*
* The member fact MOVES FIELDS between the two: v1 declares
* `is_member_only: bool`, v2 declares `allowed_subscription: string[]`. The
* mapping `memberOnly = allowed_subscription.length > 0` was verified against
* v1 across all 8 shared rows with zero mismatches — so this is a re-encoding,
* not a reinterpretation.
*
* `auto` is DROPPED: it exists only in v2, is a routing alias rather than a
* real model, and carries no multiplier. Dropping by explicit id (not by
* "no multiplier") keeps the filter honest if the platform later prices it.
*
* The rows carry a per-model credit multiplier — a fact about billing, not
* gating, so it is KEPT and travels to the panel and the descriptor's display
* name (see `agnescodeToDescriptor`).
* @param {object} credential - `{ accessToken, bffBase }`.
* @param {typeof fetch} [fetcher] - injected fetch.
* @returns {Promise<object[]|null>} `[{id, name, vision, memberOnly, multiplier, contextWindow, maxOutputLength}]`, or `null`.
*/
async function fetchAgnescodeCatalog(credential, fetcher) {
	const effective = fetcher ?? globalThis.fetch;
	const source = obj(credential);
	const bffBase = trustAgnescodeBffBase(source.bffBase);
	if (bffBase === null) return null;
	try {
		const response = await effective(`${agnescodeApiRoot(bffBase)}/v2/models`, {
			headers: agnescodeHeaders(source),
			signal: AbortSignal.timeout(3e4)
		});
		if (!response.ok) return null;
		const body = obj(await response.json().catch(() => ({})));
		const models = Array.isArray(body.data) ? body.data : [];
		const seen = /* @__PURE__ */ new Set();
		const out = [];
		for (const raw of models) {
			const model = obj(raw);
			const id = str(model.id, "");
			if (id === "" || seen.has(id)) continue;
			if (id === AGNESCODE_CATALOGUE_EXCLUDED_IDS[0]) continue;
			if (str(model.model_type, "text") !== "text") continue;
			seen.add(id);
			const allowed = Array.isArray(model.allowed_subscription) ? model.allowed_subscription : [];
			const multiplier = numZeroOk(model.points_cost_multiplier);
			out.push({
				id,
				name: str(model.name, id),
				vision: false,
				memberOnly: allowed.length > 0,
				...multiplier === void 0 ? {} : { multiplier },
				contextWindow: num(model.max_input_tokens),
				maxOutputLength: num(model.max_output_tokens)
			});
		}
		return out.length > 0 ? out : null;
	} catch {
		return null;
	}
}
/**
* Read the account's credit pool. Read-only; the envelope is a SUBSCRIPTION
* pool (level / time-sensitive vs permanent credits), NOT a Token Plan
* usage-overview — the panel must not render it with quota semantics.
* @param {object} credential - `{ accessToken, bffBase }`.
* @param {typeof fetch} [fetcher] - injected fetch.
* @returns {Promise<object|null>} `{totalBalance, timeSensitiveBalance, permanentBalance, subscriptionCredits, dailyFreeCredits, level}` or `null`.
*/
async function fetchAgnescodeBalance(credential, fetcher) {
	const effective = fetcher ?? globalThis.fetch;
	const source = obj(credential);
	const bffBase = trustAgnescodeBffBase(source.bffBase);
	if (bffBase === null) return null;
	try {
		const response = await effective(`${agnescodeApiRoot(bffBase)}/api/v2/subscription/credits-balance`, {
			headers: agnescodeHeaders(source),
			signal: AbortSignal.timeout(3e4)
		});
		if (!response.ok) return null;
		const envelope = obj(await response.json().catch(() => ({})));
		if (str(envelope.code, "") !== "000000" || envelope.data === null || typeof envelope.data !== "object") return null;
		const data = obj(envelope.data);
		const total = numOrNullSafe(data.total_balance);
		if (total === null) return null;
		return {
			totalBalance: total,
			timeSensitiveBalance: numOrNullSafe(data.time_sensitive_balance) ?? 0,
			permanentBalance: numOrNullSafe(data.permanent_balance) ?? 0,
			subscriptionCredits: numOrNullSafe(data.subscription_credits) ?? 0,
			dailyFreeCredits: numOrNullSafe(data.daily_free_credits) ?? 0,
			level: num(data.level)
		};
	} catch {
		return null;
	}
}
/** Read a finite non-negative number, else `null`. */
function numOrNullSafe(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
/**
* The static fallback roster: the eight models the CN BFF listed at probe time
* (2026-10-01 night re-probe, ROADMAP §6.3.1). All `model_type: text`, no
* multiplier concept — confirmed by that re-probe: no model row carries a
* credit/rate/price/cost key and all five rate-candidate endpoints 404
* (billing is the account-level credit pool, not per-model rates). Used ONLY
* when `fetchAgnescodeCatalog` comes back empty; a fresh catalogue always wins.
*/
const AGNESCODE_FALLBACK_MODELS = Object.freeze([
	{
		id: "agnes-3.0-flash",
		name: "Agnes 3.0 Flash",
		memberOnly: false,
		vision: false,
		multiplier: 0,
		contextWindow: 512e3,
		maxOutputLength: 65536
	},
	{
		id: "agnes-2.5-flash",
		name: "Agnes 2.5 Flash",
		memberOnly: false,
		vision: false,
		multiplier: 0,
		contextWindow: 512e3,
		maxOutputLength: 65536
	},
	{
		id: "agnes-2.5-pro",
		name: "Agnes 2.5 Pro",
		memberOnly: false,
		vision: false,
		multiplier: 1,
		contextWindow: 512e3,
		maxOutputLength: 65536
	},
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		memberOnly: true,
		vision: false,
		multiplier: 1.2,
		contextWindow: 1e6,
		maxOutputLength: 393216
	},
	{
		id: "agnes-2.0-flash",
		name: "Agnes 2.0 Flash",
		memberOnly: false,
		vision: false,
		multiplier: 0,
		contextWindow: 512e3,
		maxOutputLength: 65536
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		memberOnly: true,
		vision: false,
		multiplier: 1.85,
		contextWindow: 1e6,
		maxOutputLength: 131072
	},
	{
		id: "kimi-k3",
		name: "Kimi K3",
		memberOnly: true,
		vision: false,
		multiplier: 5.3,
		contextWindow: 1048576,
		maxOutputLength: 131072
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		memberOnly: true,
		vision: false,
		multiplier: 1.5,
		contextWindow: 1e6,
		maxOutputLength: 393216
	}
]);

//#endregion
//#region src/host/agnescode-models.ts
/**
* AgnesCode catalogue entry → pi-ai model descriptor mapping — the peer-free
* half of the desktop-app upstream provider. Same peer-free
* discipline: plain objects only (no Host peer import); `agnescode-llm-adapter.ts`
* is the peer-dependent half.
*
* Three decisions carried here:
*   1. `reasoning: true` + a BFF-specific `thinkingLevelMap` — probed LIVE on
*      2026-10-03 against the per-account BFF (`agnes-3.0-flash`,
*      `{bffBase}/v1/chat/completions`): the OpenAI-compatible `reasoning_effort`
*      ladder `none`/`low`/`medium`/`high` is ACCEPTED (HTTP 200 under every
*      one) and the BFF returns `message.reasoning_content` under each — even
*      with NO thinking field at all (the v1 shape), which is why v1's
*      `reasoning: false` never actually turned thinking off, it only hid the
*      selector. `off` is `null` on purpose: `reasoning_effort:"none"` does NOT
*      disable thinking (still 188 reasoning tokens), and the desktop App's real
*      off switch (`request_params.agnes_thinking_enabled:false`) is not
*      expressible in pi-ai's string-valued map. Offering "off" would promise
*      "thinking off" and deliver "still thinking". `xhigh`/`max` stay closed
*      until a probe proves them on the BFF.
*   2. The base URL is PER-ACCOUNT (`bffPublicBaseUrl` from the session
*      file), so it rides through the builder's options instead of a module
*      constant — the reference reverse-proxy's hardcoded `.com` constant is
*      the trap this avoids.
*   3. `memberOnly` models are OFFERED, not dropped: gating is account state,
*      not model truth (red line 7's spirit — state limits, never silently
*      retract models). The panel badges them; a request that hits the gate
*      fails visibly at the upstream.
*
* @module dsh-connect-agnes-token-plan/agnescode-models
*/
/**
* The provider id this plugin registers under for AgnesCode.
*
* The bare product name, the same granularity the sibling `dsh-connect-workbuddy`
* uses for `workbuddy` / `workbuddy-global`: the vendor is implied by the
* plugin. (It used to be `agnes-agnescode`, which read as a stutter — the
* vendor prefix repeated the product name that already carries "Agnes".)
*
* Deliberately NOT `sensenova-*`: the sibling plugin
* `dsh-connect-sensenova-token-plan` registers those ids, and a duplicated id
* is rejected by `registerAdapter` as DUPLICATE_ADAPTER — one of the two would
* silently vanish from the picker (ARCHITECTURE.md §5). `agnescode` sits in
* neither namespace, so that collision is impossible either way.
*/
const AGNESCODE_PROVIDER_ID = "agnescode";
/** What the DSH model picker shows as the AgnesCode provider's name. */
const AGNESCODE_DISPLAY_NAME = "AgnesCode";
/** The zero-cost sentinel: per-token prices are unknowable (credit-gated). */
const NO_COST = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
});
/** The catalogue/identity headers every request carries (probed: required). */
function agnescodeRequestHeaders() {
	return {
		Accept: "application/json",
		"Content-Type": "application/json",
		"X-App-Id": "1",
		"X-Platform": "1",
		"X-User-Language": "zh-Hans"
	};
}
/**
* Whether an AgnesCode roster row accepts image input.
*
* AgnesCode's own BFF `/models` rows declare no modality field — only
* `model_type: "text"` and `supported_endpoint_types` — so the catalogue alone
* would answer "no vision" for EVERY row (that is why `fetchAgnescodeCatalog`
* pins `vision: false`). But AgnesCode serves the SAME Agnes model family the
* Token Plan gateway does (`agnes-3.0-flash` / `agnes-2.5-flash` /
* `agnes-2.5-pro` all appear in both rosters), whose official docs declare
* image input — `PROBED_VISION` (llm-models.ts) is that evidence, and the
* Token Plan side already probed `agnes-3.0-flash` accepting the standard
* OpenAI `image_url` block live. Non-agnes ids (`deepseek-*` / `glm-*` /
* `kimi-*`) have no such claim and stay text-only.
*
* Resolution order: the row's own `vision` (if the catalogue ever declares
* one) wins, then `PROBED_VISION` for the Agnes family, then false.
* @param {object} row - one AgnesCode roster row (must carry `id`).
* @returns {boolean} whether the row accepts image input.
*/
function agnescodeVisionOf(row) {
	if (row?.vision === true) return true;
	const id = str(row?.id, "");
	return PROBED_VISION[id] === true;
}
/**
* The AgnesCode model rows the panel shows and the adapter offers.
*
* A live catalogue row always beats the static fallback roster. The row keeps
* what the picker and panel need — plus `memberOnly`, which this provider HAS
* a platform-declared fact for and the panel badges.
* @param {object[]|null} [catalog] - the `fetchAgnescodeCatalog` result.
* @returns {object[]} the AgnesCode model rows.
*/
function agnescodeRoster(catalog) {
	const rows = Array.isArray(catalog) && catalog.length > 0 ? catalog : AGNESCODE_FALLBACK_MODELS;
	const out = [];
	for (const row of rows) {
		const id = str(row?.id, "");
		if (id === "") continue;
		const multiplier = numZeroOk(row?.multiplier);
		out.push({
			id,
			name: str(row?.name, id),
			vision: agnescodeVisionOf(row),
			memberOnly: row?.memberOnly === true,
			...multiplier === void 0 ? {} : { multiplier },
			contextWindow: num(row?.contextWindow),
			maxOutputLength: num(row?.maxOutputLength)
		});
	}
	return out;
}
/**
* Curate a roster with the panel's allow-list.
*
* The EMPTY list is the load-bearing convention (same as the Token Plan side):
* no curation means the roster is pushed WHOLE, so a fresh install keeps the
* old behaviour. Only a non-empty list filters — and it filters by the row's
* `id`, the one fact both the checkbox and the descriptor are keyed on.
* @param {object[]} rows - the {@link agnescodeRoster} result.
* @param {unknown} enabledIds - the curated ids (empty = no filter).
* @returns {object[]} the rows to publish.
*/
function filterAgnescodeRows(rows, enabledIds) {
	const list = Array.isArray(rows) ? rows : [];
	const ids = normalizeEnabledIds(enabledIds);
	if (ids.length === 0) return list;
	const keep = new Set(ids);
	return list.filter((row) => keep.has(str(row?.id, "")));
}
/**
* The thinking level map this provider offers, keyed on pi-ai's ladder.
*
* The BFF's `reasoning_effort` ladder was probed live on 2026-10-03
* (`agnes-3.0-flash`): `none`/`low`/`medium`/`high` are all ACCEPTED (HTTP 200)
* — but `none` does NOT disable thinking (the response still carried
* `reasoning_content`, 188 reasoning tokens). The desktop App's real off switch
* is `request_params.agnes_thinking_enabled:false` (or
* `request_params.thinking_effort:"off"`), which a string-valued thinking map
* cannot emit. So `off` is DELIBERATELY `null`: offering it would promise
* "thinking off" and deliver "still thinking" — the same class of silent lie
* `docs/DSH-LLM-DEVELOP.md` §4 warns about for the opposite direction. The
* levels pi-ai actually sends (`low`/`medium`/`high`) are the ones probed 200.
* `xhigh`/`max` stay closed until a probe proves them on the BFF.
* @returns {object} the level → wire-spelling map.
*/
function agnescodeThinkingLevelMap() {
	return {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null
	};
}
/**
* Map one AgnesCode row onto the pi-ai model descriptor the adapter offers.
* @param {object} row - an {@link agnescodeRoster} row (must carry `id`).
* @param {object} [options] - `{ bffBase }` — the pinned per-account base.
* @returns {object} the pi-ai descriptor.
*/
function agnescodeToDescriptor(row, options = {}) {
	const id = str(row?.id, "");
	if (id === "") throw new Error("agnescodeToDescriptor: row has no id");
	const bffBase = str(options.bffBase, "");
	if (bffBase === "") throw new Error("agnescodeToDescriptor: a pinned bffBase is required");
	const vision = agnescodeVisionOf(row);
	const multiplier = numZeroOk(row?.multiplier);
	const name = str(row?.name, id);
	return {
		id,
		name: multiplier === void 0 ? name : `${name} · x${multiplier.toFixed(2)}`,
		api: "openai-completions",
		provider: AGNESCODE_PROVIDER_ID,
		baseUrl: bffBase,
		input: vision ? ["text", "image"] : ["text"],
		reasoning: true,
		thinkingLevelMap: agnescodeThinkingLevelMap(),
		cost: { ...NO_COST },
		contextWindow: num(row?.contextWindow) ?? 512e3,
		maxTokens: num(row?.maxOutputLength) ?? 32e3,
		headers: agnescodeRequestHeaders(),
		compat: {
			maxTokensField: "max_tokens",
			supportsDeveloperRole: false
		}
	};
}
/**
* Build the whole descriptor list for one AgnesCode roster.
* @param {object[]} [roster] - the {@link agnescodeRoster} result.
* @param {object} [options] - `{ bffBase }`.
* @returns {object[]} the pi-ai descriptors.
*/
function buildAgnescodeDescriptors(roster, options = {}) {
	const list = Array.isArray(roster) ? roster : agnescodeRoster(null);
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const row of list) {
		const id = str(row?.id, "");
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		out.push(agnescodeToDescriptor(row, options));
	}
	return out;
}

//#endregion
export { writeStateFile as S, profileSegment as _, filterAgnescodeRows as a, stateDir as b, fetchAgnescodeBalance as c, trustAgnescodeBffBase as d, createFileCatalogStore as f, ensureStateDir as g, createStateReadCache as h, buildAgnescodeDescriptors as i, fetchAgnescodeCatalog as l, STATE_READ_TTL_MS as m, AGNESCODE_PROVIDER_ID as n, AGNESCODE_FALLBACK_MODELS as o, normalizeEnabledIds as p, agnescodeRoster as r, decodeAgnescodeJwtExpMs as s, AGNESCODE_DISPLAY_NAME as t, harvestAgnescodeLocalSession as u, profileStateDir as v, temporaryOf as x, readStateJson as y };