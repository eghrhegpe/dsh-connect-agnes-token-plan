/**
 * AgnesCode 积分流水聚合（fetchAgnescodeLedger）的离线检查。
 *
 * 流水是「真实消耗」的唯一平台级信号：它记账号全部消耗（含桌面 App），
 * 插件在 Host 侧聚合成窗口合计后只把数字送出 wire——description 类
 * 账号级内容绝不离开 Host（红线）。本套件验：
 *   - 请求精确钉（POST 端点 / body {page,page_size:100,filter:0} / 鉴权头）；
 *   - 信封纪律（4xx/5xx、code≠000000、data/list 缺失、翻页中途失败 → 整体 null，
 *     不做半聚合）；
 *   - 翻页（total 驱动、oldestSeen 越窗提前停、页面数封顶、短页收尾）；
 *   - 窗口求和（今日 / 近 30 天、direction 桶、未知 direction 只计 fetchedCount、
 *     epoch 秒→毫秒归一、0 金额保留、无 created_at 跳过）；
 *   - covered30d 三态（取尽 / 无 pagination 且 oldest 在窗内 / oldest 越窗 → 下限）；
 *   - 返回键集精确（无 description 等账号级内容）；
 *   - untrusted base 不发请求即 null。
 */
import {
  fetchAgnescodeLedger,
  AGNESCODE_LEDGER_PAGE_SIZE,
  AGNESCODE_LEDGER_MAX_PAGES,
  AGNESCODE_LEDGER_WINDOW_DAYS
} from "../src/host/agnescode.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail ?? "") });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

const CREDENTIAL = { accessToken: "tok", bffBase: "https://api-agnes-code.agnes-ai.cn/v1" };
const EXPECTED_URL = "https://api-agnes-code.agnes-ai.cn/api/v1/subscription/credits-transactions";

// A fixed clock so the windows are exact, not "today".
const BASE = new Date("2026-10-04T12:00:00Z").getTime();
const startOfToday = (() => {
  const d = new Date(BASE);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();
const startOfWindow = BASE - AGNESCODE_LEDGER_WINDOW_DAYS * 86_400_000;
const sec = (ms) => Math.round(ms / 1000);

// Every fixture row carries a description: the aggregation must DROP it —
// the returned shape is the red line, so the fixture makes its survival
// observable.
const row = (createdAt, direction, amount) => ({
  created_at: createdAt,
  direction,
  amount,
  platform: 1,
  description: `fixture-op-${direction}`
});

// A fetcher that records every call and serves page envelopes from a map.
// `pages` maps page number → response body (the envelope); `status` maps
// page number → HTTP status (default 200).
function ledgerHarness(pages, status) {
  const calls = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: init.method, body, headers: init.headers });
    const page = body.page;
    const st = status?.[page] ?? 200;
    return {
      ok: st >= 200 && st < 300,
      status: st,
      json: async () => pages[page]
    };
  };
  return { calls, fetcher };
}
const envelope = (list, total) => ({
  code: "000000",
  message: "success",
  data: { list, pagination: total === undefined ? undefined : { page: 1, page_size: AGNESCODE_LEDGER_PAGE_SIZE, total } }
});

// --- 1. 请求形状与单页聚合 ---------------------------------------------
{
  const rows = [
    row(sec(startOfToday + 3_600_000), 1, 600),            // today credit
    row(sec(startOfToday + 7_200_000), 2, 23),             // today debit (latest)
    row(sec(startOfToday - 86_400_000), 2, 100),           // yesterday: window only
    row(sec(startOfWindow), 1, 5),                          // window boundary, kept
    row(sec(startOfWindow - 1_000), 2, 999),                // just outside: excluded
    row(sec(startOfToday + 1_800_000), 3, 50),             // unknown direction: counted, not summed
    row(sec(startOfToday + 5_000_000), 2, 0),              // zero-amount debit kept
    { created_at: startOfToday + 1_000, direction: 1, amount: 1, description: "ms" } // already-ms value: kept as-is
  ];
  const { calls, fetcher } = ledgerHarness({ 1: envelope(rows, rows.length) });
  const out = await fetchAgnescodeLedger(CREDENTIAL, fetcher, BASE);

  check("the request is a POST to the ledger endpoint",
    calls.length === 1 && calls[0].url === EXPECTED_URL && calls[0].method === "POST",
    JSON.stringify(calls.map((c) => c.url)));
  check("the page body is pinned to {page, page_size:100, filter:0}",
    JSON.stringify(calls[0].body) === JSON.stringify({ page: 1, page_size: AGNESCODE_LEDGER_PAGE_SIZE, filter: 0 }),
    JSON.stringify(calls[0].body));
  check("the request carries the credential and json content type",
    calls[0].headers.Authorization === "Bearer tok" && calls[0].headers["Content-Type"] === "application/json",
    JSON.stringify(calls[0].headers));
  check("the aggregation covers the windows: today 601 in / 23 out, 30d 606 in / 123 out",
    out !== null && out.todayCredits === 601 && out.todayDebits === 23
      && out.last30dCredits === 606 && out.last30dDebits === 123,
    JSON.stringify(out));
  check("lastDebitAt is the newest in-window debit",
    out?.lastDebitAt === startOfToday + 7_200_000, String(out?.lastDebitAt));
  check("fetchedCount counts every dated row",
    out?.fetchedCount === 8, String(out?.fetchedCount));
  check("a drained ledger covers the 30-day window",
    out?.covered30d === true, String(out?.covered30d));
  check("the clock override is reported as `at`", out?.at === BASE, String(out?.at));
  const expectedKeys = ["at", "covered30d", "fetchedCount", "last30dCredits", "last30dDebits", "lastDebitAt", "todayCredits", "todayDebits", "total"].sort();
  check("the returned shape carries NO account-level content (exact key set, no description)",
    out !== null && JSON.stringify(Object.keys(out).sort()) === JSON.stringify(expectedKeys),
    JSON.stringify(Object.keys(out ?? {})));
  check("fixture descriptions never survive the aggregation",
    out !== null && !JSON.stringify(out).includes("fixture-op"), JSON.stringify(out));
}

// --- 1b. 无 created_at 的条目：跳过计数，30 天合计仍为下限 ---------------
{
  const rows = [
    row(sec(startOfToday + 3_600_000), 1, 10),
    { direction: 1, amount: 7, description: "no created_at" } // undated: skipped
  ];
  const { fetcher } = ledgerHarness({ 1: envelope(rows, 2) });
  const out = await fetchAgnescodeLedger(CREDENTIAL, fetcher, BASE);
  check("an undated row is skipped from fetchedCount",
    out?.fetchedCount === 1, JSON.stringify(out));
  check("an undated row keeps the 30-day sum a lower bound (cannot confirm it is out of window)",
    out?.covered30d === false && out?.last30dCredits === 10, JSON.stringify(out));
}

// --- 2. 边界：恰好今日零点 / 恰好 30 天前 --------------------------------
{
  const rows = [
    row(sec(startOfToday), 1, 10),        // exactly local midnight: today
    row(sec(startOfWindow), 2, 20)        // exactly 30 days ago: in window
  ];
  const { fetcher } = ledgerHarness({ 1: envelope(rows, 2) });
  const out = await fetchAgnescodeLedger(CREDENTIAL, fetcher, BASE);
  check("an entry at local midnight counts as today",
    out?.todayCredits === 10, JSON.stringify(out));
  check("an entry exactly 30 days ago counts into the window",
    out?.last30dDebits === 20, JSON.stringify(out));
}

// --- 3. 信封与传输纪律 ----------------------------------------------------
{
  const { fetcher } = ledgerHarness({ 1: envelope([], 0) }, { 1: 401 });
  check("a 401 reads as null", await fetchAgnescodeLedger(CREDENTIAL, fetcher, BASE) === null);

  const h500 = ledgerHarness({ 1: envelope([], 0) }, { 1: 500 });
  check("a 500 reads as null", await fetchAgnescodeLedger(CREDENTIAL, h500.fetcher, BASE) === null);

  const hBadCode = ledgerHarness({ 1: { code: "400000", message: "no", data: { list: [] } } });
  check("a non-zero envelope code reads as null", await fetchAgnescodeLedger(CREDENTIAL, hBadCode.fetcher, BASE) === null);

  const hNoData = ledgerHarness({ 1: { code: "000000", data: null } });
  check("a missing data block reads as null", await fetchAgnescodeLedger(CREDENTIAL, hNoData.fetcher, BASE) === null);

  const hNoList = ledgerHarness({ 1: { code: "000000", data: {} } });
  check("a missing list reads as null", await fetchAgnescodeLedger(CREDENTIAL, hNoList.fetcher, BASE) === null);
}

// --- 4. 翻页：total 驱动 / 封顶 / 越窗提前停 ------------------------------
{
  // total=150 → exactly two pages (100 + 50).
  const page1 = Array.from({ length: 100 }, (_, i) => row(sec(startOfToday + i * 1000), 1, 0));
  const page2 = Array.from({ length: 50 }, (_, i) => row(sec(startOfToday + i * 1000), 1, 0));
  const two = ledgerHarness({ 1: envelope(page1, 150), 2: envelope(page2, 150) });
  const out150 = await fetchAgnescodeLedger(CREDENTIAL, two.fetcher, BASE);
  check("total=150 fetches exactly two pages", two.calls.length === 2, String(two.calls.length));
  check("the second page request is {page:2, page_size:100, filter:0}",
    JSON.stringify(two.calls[1]?.body) === JSON.stringify({ page: 2, page_size: AGNESCODE_LEDGER_PAGE_SIZE, filter: 0 }),
    JSON.stringify(two.calls[1]?.body));
  check("a fully-fetched ledger reports its totals and covers the window",
    out150?.fetchedCount === 150 && out150?.covered30d === true && out150?.total === 150,
    JSON.stringify(out150));

  // total=500 → five pages, the hard cap, and the ledger is exactly drained.
  const cap = ledgerHarness(
    { 1: envelope(page1, 500), 2: envelope(page1, 500), 3: envelope(page1, 500), 4: envelope(page1, 500), 5: envelope(page1, 500) }
  );
  const out500 = await fetchAgnescodeLedger(CREDENTIAL, cap.fetcher, BASE);
  check(`total=500 fetches the ${AGNESCODE_LEDGER_MAX_PAGES}-page cap and is covered`,
    cap.calls.length === AGNESCODE_LEDGER_MAX_PAGES && out500?.fetchedCount === 500 && out500?.covered30d === true,
    `${cap.calls.length} calls, fetched ${out500?.fetchedCount}`);

  // total=1000 → five pages fetched, the ledger NOT drained: a lower bound.
  const over = ledgerHarness(
    { 1: envelope(page1, 1000), 2: envelope(page1, 1000), 3: envelope(page1, 1000), 4: envelope(page1, 1000), 5: envelope(page1, 1000) }
  );
  const out1000 = await fetchAgnescodeLedger(CREDENTIAL, over.fetcher, BASE);
  check("total=1000 stops at the cap and flags the 30-day sum a lower bound",
    over.calls.length === AGNESCODE_LEDGER_MAX_PAGES
      && out1000?.fetchedCount === 500 && out1000?.covered30d === false,
    `${over.calls.length} calls, fetched ${out1000?.fetchedCount}, covered ${out1000?.covered30d}`);

  // oldest seen steps past the 30-day boundary → stop after page 1.
  const stale = Array.from({ length: 100 }, () => row(sec(startOfWindow - 86_400_000), 1, 0));
  const early = ledgerHarness({ 1: envelope(stale, 1000) });
  const outEarly = await fetchAgnescodeLedger(CREDENTIAL, early.fetcher, BASE);
  check("an oldest entry past the 30-day boundary stops the walk early",
    early.calls.length === 1, String(early.calls.length));
  check("the early stop still reports an uncovered window",
    outEarly?.covered30d === false && outEarly?.last30dCredits === 0, JSON.stringify(outEarly));
}

// --- 5. 翻页中途失败 → 整体 null -----------------------------------------
{
  const page1 = Array.from({ length: 100 }, (_, i) => row(sec(startOfToday + i * 1000), 1, 0));
  const { calls, fetcher } = ledgerHarness({ 1: envelope(page1, 150), 2: envelope([], 150) }, { 2: 401 });
  const out = await fetchAgnescodeLedger(CREDENTIAL, fetcher, BASE);
  check("a second-page failure nulls the WHOLE aggregation",
    out === null && calls.length === 2, `${calls.length} calls, out=${JSON.stringify(out)}`);
}

// --- 6. 无 pagination：covered30d 按 oldestSeen 判定 ----------------------
{
  const inWindow = [row(sec(startOfToday), 1, 5)];
  const { fetcher: fCovered } = ledgerHarness({ 1: envelope(inWindow) }); // total omitted
  const covered = await fetchAgnescodeLedger(CREDENTIAL, fCovered, BASE);
  check("without pagination, a fully in-window page is covered",
    covered?.total === null && covered?.covered30d === true, JSON.stringify(covered));

  const outOfWindow = [row(sec(startOfWindow - 86_400_000), 1, 5)];
  const { fetcher: fStale } = ledgerHarness({ 1: envelope(outOfWindow) });
  const stale = await fetchAgnescodeLedger(CREDENTIAL, fStale, BASE);
  check("without pagination, an oldest entry past the boundary is NOT covered",
    stale?.covered30d === false, JSON.stringify(stale));

  const { fetcher: fEmpty } = ledgerHarness({ 1: envelope([]) });
  const empty = await fetchAgnescodeLedger(CREDENTIAL, fEmpty, BASE);
  check("an empty ledger is covered (nothing left to fetch)",
    empty?.fetchedCount === 0 && empty?.covered30d === true && empty?.lastDebitAt === null,
    JSON.stringify(empty));
}

// --- 7. untrusted base：发请求前即 null ----------------------------------
{
  const { calls, fetcher } = ledgerHarness({ 1: envelope([], 0) });
  const out = await fetchAgnescodeLedger({ accessToken: "t", bffBase: "https://evil.example.com/v1" }, fetcher, BASE);
  check("a foreign base reads as null before any request",
    out === null && calls.length === 0, `${calls.length} calls`);
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
process.exit(0);
