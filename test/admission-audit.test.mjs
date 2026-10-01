/**
 * 同源闸审计（admission-audit）的离线检查。
 *
 * 它钉的是一条容易被两头误解的裁定：`isAdmitted` 在 `Origin` 缺失时放行，这
 * **不是**漏洞——浏览器的同站 GET 不发 `Origin`，而跨站 POST 必然发、发了就被
 * 比对拦掉；所以那条分支上过的只会是非浏览器客户端，而它们本来就能自己伪造
 * `Origin` 与 `Host`。给"写方法补一条必须带 Origin"的规则换不来任何安全性，只
 * 会多一个"面板被代理剥掉 Origin 就全站 403"的功能性风险。
 *
 * 所以这里检查的**不是**"无 Origin 的写被拒绝"，而是：
 *   1. 放行结论与 `isAdmitted` 逐位相同（审计绝不改变请求的命运）；
 *   2. "放行 + 无 Origin + 会改状态"三个条件同时成立时留下一笔痕迹；
 *   3. 带匹配 Origin 的写、被闸拒掉的写、以及同站 GET **都不留痕**；
 *   4. 痕迹里不含任何值（方法是归一化后的，不是原文）；
 *   5. 六条写路由都接的是审计版闸，新增写路由接错会红。
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installNetworkGuard } from "./peer-roots.mjs";
import {
  ADMISSION_AUDIT_FILE,
  ADMISSION_AUDIT_VERSION,
  normalizeMethod,
  parseAdmissionAudit,
  readAdmissionAudit,
  recordOriginlessWrite,
  isAdmittedWithAudit
} from "../src/host/admission-audit.ts";
import { isAdmitted } from "../src/host/host-config.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail ?? "") });
}

installNetworkGuard();

// 白名单里存的是 `hostName()` 的结果（去端口），不是完整的 Host 头。
const HOSTS = new Set(["127.0.0.1"]);
const scratch = () => mkdtempSync(join(tmpdir(), "agnes-admission-"));

/** 审计是 fire-and-forget，读之前给它一个短截止时间（不 sleep 固定时长）。 */
async function readEventually(dir, { tries = 60 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const found = await readAdmissionAudit(dir);
    if (found !== null) return found;
    await new Promise((r) => setTimeout(r, 5));
  }
  return null;
}

// --- 1. normalizeMethod：外部输入不许原样落盘 ----------------------------
{
  check("方法名归一化：小写 post → POST", normalizeMethod("post") === "POST");
  check("方法名归一化：PUT 原样", normalizeMethod("PUT") === "PUT");
  check("方法名归一化：非字符串 → OTHER", normalizeMethod(undefined) === "OTHER" && normalizeMethod(7) === "OTHER");
  check("方法名归一化：空串 → OTHER", normalizeMethod("") === "OTHER");
  check("方法名归一化：注入形状（换行/超长/数字）→ OTHER",
    normalizeMethod("POST\nEVIL") === "OTHER" &&
      normalizeMethod("P".repeat(40)) === "OTHER" &&
      normalizeMethod("123") === "OTHER",
    "落盘的方法名必须是可信形状，否则等于让别人往状态文件里写任意字符串");
}

// --- 2. parseAdmissionAudit：认不出就读作「没发生过」 --------------------
{
  check("缺席 / 损坏 / 外来版本都读作无记录",
    parseAdmissionAudit(null) === null &&
      parseAdmissionAudit("x") === null &&
      parseAdmissionAudit([]) === null &&
      parseAdmissionAudit({ version: ADMISSION_AUDIT_VERSION + 99, count: 5, lastAt: 1 }) === null);
  check("count 与 lastAt 都为 0 读作无记录（零次与缺席同义）",
    parseAdmissionAudit({ version: ADMISSION_AUDIT_VERSION, count: 0, lastAt: 0, lastMethod: "POST" }) === null);
  const parsed = parseAdmissionAudit({ version: ADMISSION_AUDIT_VERSION, count: 3, lastAt: 111, lastMethod: "w3ird" });
  check("有效记录被读出，且方法名仍被归一化",
    parsed !== null && parsed.count === 3 && parsed.lastAt === 111 && parsed.lastMethod === "OTHER",
    JSON.stringify(parsed));
}

// --- 3. recordOriginlessWrite：累加、失败不抛 ----------------------------
{
  const dir = scratch();
  await recordOriginlessWrite("POST", { dir, now: () => 1000 });
  const first = await readAdmissionAudit(dir);
  check("第一次写入记到 count=1", first?.count === 1 && first?.lastMethod === "POST", JSON.stringify(first));

  await recordOriginlessWrite("put", { dir, now: () => 2000 });
  const second = await readAdmissionAudit(dir);
  check("第二次累加并更新时间与方法",
    second?.count === 2 && second?.lastAt === 2000 && second?.lastMethod === "PUT", JSON.stringify(second));

  // 目录不可写时不能把请求带走：审计是旁路的。
  let threw = false;
  await recordOriginlessWrite("POST", { dir: join(dir, ADMISSION_AUDIT_FILE, "deeper"), now: () => 1 })
    .catch(() => { threw = true; });
  check("写入失败不抛（审计不能影响请求本身）", threw === false);

  check("只落这一个文件，不扩散到 state 目录其它地方",
    readdirSync(dir).length === 1 && readdirSync(dir)[0] === ADMISSION_AUDIT_FILE,
    readdirSync(dir).join(","));
  check("落盘内容不含任何头值/凭据原文（只有四个字段）",
    Object.keys(JSON.parse(readFileSync(join(dir, ADMISSION_AUDIT_FILE), "utf8"))).sort().join(",")
      === "count,lastAt,lastMethod,version",
    readFileSync(join(dir, ADMISSION_AUDIT_FILE), "utf8").slice(0, 120));
}

// --- 4. isAdmittedWithAudit：放行结论与 isAdmitted 逐位相同 --------------
{
  const dir = scratch();
  const cases = [
    ["同站 GET（无 Origin —— 合法）", { method: "GET", headers: { host: "127.0.0.1:19387" } }, true, false],
    ["带匹配 Origin 的 POST", { method: "POST", headers: { host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387" } }, true, false],
    ["跨站 POST（必被拒）", { method: "POST", headers: { host: "127.0.0.1:19387", origin: "https://evil.test" } }, false, false],
    ["无 Origin 的 POST", { method: "POST", headers: { host: "127.0.0.1:19387" } }, true, true],
    ["无 Origin 且无 method（account 路由按 POST 处理）", { headers: { host: "127.0.0.1:19387" } }, true, true],
    ["Host 不在白名单（必被拒）", { method: "POST", headers: { host: "attacker.test" } }, false, false]
  ];
  let index = 0;
  for (const [label, request, expectAdmitted, expectAudited] of cases) {
    index += 1;
    const sub = join(dir, `case${index}`);
    const admitted = isAdmittedWithAudit(request, HOSTS, { dir: sub, now: () => 1000 + index });
    check(`放行结论与 isAdmitted 一致：${label}`,
      admitted === expectAdmitted && isAdmitted(request, HOSTS) === admitted,
      `audit=${admitted} plain=${isAdmitted(request, HOSTS)}`);
    const audit = await readEventually(sub);
    check(
      expectAudited ? `留痕：${label}` : `不留痕：${label}`,
      expectAudited ? audit !== null && audit.count === 1 : audit === null,
      JSON.stringify(audit)
    );
  }
}

// --- 5. 接线钉：六条写路由必须都接审计版闸 ------------------------------
// 新增写路由时最容易漏的就是这一下——接成 `isAdmitted` 的闸照常放行，只是从此
// 不留痕，而"没痕迹"会被读成"没发生过"。
{
  const { readFileSync: read, readdirSync: list } = await import("node:fs");
  const routesDir = join(import.meta.dirname, "..", "src", "host", "routes");
  const files = list(routesDir).filter((f) => f.endsWith(".ts"));
  const auditing = files.filter((f) => /isAdmittedWithAudit/.test(read(join(routesDir, f), "utf8")));
  const plain = files.filter((f) => /(?<!WithAudit)\bisAdmitted\b/.test(read(join(routesDir, f), "utf8")));
  check("写路由接的是审计版闸（account/api-key/models/provider/tool-switch/agnescode）",
    auditing.length === 6 &&
      ["account.ts", "api-key.ts", "models.ts", "provider.ts", "tool-switch.ts", "agnescode.ts"]
        .every((f) => auditing.includes(f)),
    `实到 [${auditing.sort().join(", ")}]`);
  check("只有只读的 snapshot 走不带审计的闸（同站 GET 本就不发 Origin）",
    plain.length === 1 && plain[0] === "snapshot.ts",
    `实到 [${plain.sort().join(", ")}]。若新增了写路由却用了 isAdmitted，这里会红`);
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
