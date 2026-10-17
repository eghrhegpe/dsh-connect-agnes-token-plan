/**
 * AgnesCode 限流记录存储（agnescode-stats-store.js）的离线检查。
 *
 * 它只记本插件自身撞到限频的症状（RATE_LIMIT），不记 token/轮次——平台按
 * token 口径不可读，本地自记会漏掉桌面 App 的消耗而严重低估。本套件验：
 *   - 今日 / 近 30 天两个窗口计数与最近一次时间；
 *   - 跨日边界（今天的命中不计入"今日"之前的窗口，但仍计入 30 天）；
 *   - 30 天窗口修剪（过老的天数被丢弃，不留在计数里）；
 *   - 文件与内存两套行为一致；外来版本读到"无记录"；
 *   - 原子写与 clear 不 reject（报告 boolean）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileAgnescodeStatsStore,
  createMemoryAgnescodeStatsStore
} from "../src/host/agnescode-stats-store.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail ?? "") });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

// A fixed clock so day boundaries are exact, not "today".
const BASE = new Date("2026-10-04T12:00:00").getTime();
const DAY = 86_400_000;
const at = (offsetDays) => new Date(BASE + offsetDays * DAY);

let tmpDir = null;
try { tmpDir = await mkdtemp(join(tmpdir(), "agnescode-stats-")); } catch { tmpDir = null; }

// Each case gets its OWN subdirectory, so the cases cannot contaminate one
// another through the shared state file — a real property of the store, and
// the exact bug a single shared temp dir would hide.
let caseCounter = 0;
async function freshFileStore(now = BASE) {
  const dir = join(tmpDir, `case-${caseCounter++}`);
  return createFileAgnescodeStatsStore({ dir, now: () => now });
}

// --- 1. 空存储：无记录就是 0 / 0 / null，不是"缺失" ----------------------
{
  const s = await freshFileStore();
  const snap = await s.read();
  check("fresh file store reads zeros and no last-hit",
    snap.today === 0 && snap.last30d === 0 && snap.lastAt === null, JSON.stringify(snap));
}

// --- 2. 一次命中 ----------------------------------------------------------
{
  const s = await freshFileStore();
  check("recordRateLimit reports the write reached disk", (await s.recordRateLimit(at(0))) === true);
  const snap = await s.read();
  check("one hit counts in today and in 30 days",
    snap.today === 1 && snap.last30d === 1, JSON.stringify(snap));
  check("lastAt records the hit time", snap.lastAt === at(0).getTime(), String(snap.lastAt));
}

// --- 3. 同一天多次命中累加 ----------------------------------------------
{
  const s = await freshFileStore();
  for (let i = 0; i < 3; i++) await s.recordRateLimit(at(0));
  const snap = await s.read();
  check("three hits today sum to 3", snap.today === 3 && snap.last30d === 3, JSON.stringify(snap));
}

// --- 4. 跨日边界：昨天的命中不计入"今日"，但仍计入 30 天 -----------------
{
  const s = await freshFileStore();
  await s.recordRateLimit(at(-1));
  await s.recordRateLimit(at(0));
  const snap = await s.read();
  check("yesterday's hit is not in today but is in 30 days",
    snap.today === 1 && snap.last30d === 2, JSON.stringify(snap));
}

// --- 5. 30 天窗口修剪：过老的天数被丢弃，不再计入 -----------------------
{
  const s = await freshFileStore();
  await s.recordRateLimit(at(-31));
  const snap = await s.read();
  check("a hit 31 days ago is pruned from the 30-day window",
    snap.today === 0 && snap.last30d === 0, JSON.stringify(snap));

  // 边界：恰好 30 天前仍保留（floor 是 now - 30d，含当日）。
  const s2 = await freshFileStore();
  await s2.recordRateLimit(at(-30));
  const snap2 = await s2.read();
  check("a hit exactly 30 days ago is kept",
    snap2.last30d === 1, JSON.stringify(snap2));
}

// --- 6. 外来版本 / 畸形内容读到"无记录"，clear 报告 boolean -------------
{
  const dir = join(tmpDir, "case-foreign");
  const s = createFileAgnescodeStatsStore({ dir, now: () => BASE });
  const file = join(dir, "agnescode-stats.json");
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ version: 99, rateLimit: { byDay: { "2026-10-04": 7 }, lastAt: 1 } }));
  const snap = await s.read();
  check("a foreign-version file reads as no record",
    snap.today === 0 && snap.last30d === 0 && snap.lastAt === null, JSON.stringify(snap));
  check("clear reports reaching the disk", (await s.clear()) === true);
  const after = await s.read();
  check("cleared store reads as no record", after.today === 0 && after.last30d === 0 && after.lastAt === null);
}

// --- 7. 内存存储行为一致 -------------------------------------------------
{
  const s = createMemoryAgnescodeStatsStore(() => BASE);
  await s.recordRateLimit(at(0));
  await s.recordRateLimit(at(0));
  await s.recordRateLimit(at(-1));
  const snap = await s.read();
  check("memory store matches file store semantics",
    snap.today === 2 && snap.last30d === 3, JSON.stringify(snap));
  check("memory clear reports true", (await s.clear()) === true);
  const after = await s.read();
  check("memory store clears", after.today === 0 && after.last30d === 0 && after.lastAt === null);
}

if (tmpDir !== null) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
process.exit(0);