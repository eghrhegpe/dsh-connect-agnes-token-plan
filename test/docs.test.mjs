// docs.test.mjs —— 文档一致性钉子（纯文件读取：无网络、无 peer 依赖、干净检出即可跑）
//
// 守住四条「文档结构纪律」：
//   1. 内部链接全部可解析（防死链）
//   2. 同一张表格不出现在 ≥2 个文件（防多源事实：配置表 / 节流表 / 测试表这类单一事实只允许一个出处）
//   3. 根 README.md 行数有上限（它只做索引与快速上手，细节下沉 docs/）
//   4. docs/DSH-PLUGIN.md 的 package.json 教学快照与真实 package.json 同步（快照不被其它测试钉住）
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];
const note = (m) => console.log(`  ok - ${m}`);
const bad = (m) => fails.push(m);

function collectMd(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "upstream" || name === ".git" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...collectMd(p));
    else if (extname(p) === ".md") out.push(p);
  }
  return out;
}

const mdFiles = collectMd(ROOT).sort();
console.log(`docs.test.mjs —— 检查 ${mdFiles.length} 个 markdown 文件`);

// 1) 内部链接全部可解析
{
  let checked = 0;
  for (const f of mdFiles) {
    const text = readFileSync(f, "utf8");
    const re = /\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].trim();
      if (/^(https?:|#)/.test(raw)) continue;
      const pathPart = raw.split("#")[0];
      if (!pathPart) continue;
      checked++;
      if (!existsSync(resolve(dirname(f), pathPart))) bad(`断链：${f} -> ${raw}`);
    }
  }
  note(`内部链接 ${checked} 条全部可解析`);
}

// 2) 跨文件重复表格
{
  const seen = new Map(); // norm -> Set(file)
  for (const f of mdFiles) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    let cur = [];
    const flush = () => {
      if (cur.length >= 3) {
        const norm = cur.map((l) => l.replace(/\s+/g, "").replace(/[|`]/g, "")).join("\n");
        if (norm.length > 40) {
          const set = seen.get(norm) ?? new Set();
          set.add(f);
          seen.set(norm, set);
        }
      }
      cur = [];
    };
    for (const line of lines) {
      if (line.trim().startsWith("|")) cur.push(line.trim());
      else flush();
    }
    flush();
  }
  let dups = 0;
  for (const [norm, files] of seen) {
    if (files.size > 1) {
      dups++;
      bad(`表格「${norm.slice(0, 50)}…」重复出现在 ${files.size} 个文件：${[...files].join(", ")}（同一事实只允许一个出处）`);
    }
  }
  note(`表格去重：${seen.size} 张唯一表格，${dups} 张跨文件重复`);
}

// 3) 根 README 行数上限
{
  const lines = readFileSync(join(ROOT, "README.md"), "utf8").split(/\r?\n/).length;
  const cap = 140;
  if (lines > cap) bad(`README.md 共 ${lines} 行，超过上限 ${cap}：根 README 只做索引与快速上手，细节下沉 docs/`);
  else note(`README.md ${lines} 行（上限 ${cap}）`);
}

// 4) DSH-PLUGIN.md 教学快照 ↔ package.json
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const doc = readFileSync(join(ROOT, "docs", "DSH-PLUGIN.md"), "utf8");
  const block = doc.match(/```jsonc\n([\s\S]*?)```/);
  if (!block) bad("docs/DSH-PLUGIN.md 找不到 jsonc 教学快照块");
  else {
    const snip = block[1];
    for (const key of ["name", "version", "main"]) {
      const m = snip.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
      if (!m) bad(`教学快照缺字段 "${key}"`);
      else if (m[1] !== String(pkg[key])) bad(`教学快照 "${key}" = ${m[1]}，真实 package.json = ${pkg[key]}（快照需同步）`);
    }
    const fm = snip.match(/"files"\s*:\s*\[([\s\S]*?)\]/);
    if (!fm) bad("教学快照缺 files 数组");
    else {
      const snipFiles = [...fm[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      const extra = snipFiles.filter((f) => !pkg.files.includes(f));
      const missing = pkg.files.filter((f) => !snipFiles.includes(f));
      if (extra.length) bad(`教学快照 files 多出：${extra.join(", ")}`);
      if (missing.length) bad(`教学快照 files 缺：${missing.join(", ")}`);
      if (!extra.length && !missing.length) note(`教学快照 files 与 package.json 一致（${snipFiles.length} 项）`);
    }
  }
}

// 5) API.md 快照示例 JSONC ↔ 声明契约
// 契约键集是 API.md 与 index.js 之外的第三个事实源：示例手滑打错字段、或文档了代码里
// 不存在的键，都会红。示例是带省略号与注释的 JSONC，先剥注释（保字符串内 // 不动）再解析。
{
  const apiDoc = readFileSync(join(ROOT, "docs", "API.md"), "utf8");
  const block = apiDoc.match(/```jsonc\n([\s\S]*?)```/);
  if (!block) bad("docs/API.md 找不到 jsonc 快照示例块");
  else {
    const stripJsonc = (src) => {
      let out = "";
      let i = 0;
      let inStr = false;
      while (i < src.length) {
        const c = src[i];
        if (inStr) {
          out += c;
          if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
          if (c === '"') inStr = false;
          i++;
          continue;
        }
        if (c === '"') { inStr = true; out += c; i++; continue; }
        if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
        if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
        out += c;
        i++;
      }
      return out;
    };
    const cleaned = stripJsonc(block[1])
      .replace(/\s*\.\.\.\s*/g, "") // 占位省略号：{...}->{}、["..."]->[""]
      .replace(/,\s*([}\]])/g, "$1"); // 尾随逗号容错
    let parsed = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      bad(`API.md 快照示例不是合法 JSON：${e.message}`);
    }
    if (parsed) {
      // 契约：快照成功响应的 14 个顶层键（含条件性 visionModels）
      const canonical = ["auth", "cacheSeconds", "catalogAvailable", "catalogModels", "consoleBase", "llm", "now", "ok", "pollSeconds", "pools", "shapeWarnings", "trend", "uncountedModels", "visionModels"].sort().join(",");
      const docKeys = Object.keys(parsed).sort().join(",");
      if (docKeys !== canonical) bad(`API.md 快照示例顶层键与契约不符：\n  文档：${docKeys}\n  契约：${canonical}`);
      else note("API.md 快照示例顶层键与契约一致（14 键）");
      const indexSrc = readFileSync(join(ROOT, "index.js"), "utf8");
      const missing = canonical.split(",").filter((k) => !new RegExp(`\\b${k}\\b`).test(indexSrc));
      if (missing.length) bad(`契约键在 index.js 中未出现：${missing.join(", ")}`);
    }
  }
}

// N) PITFALLS 的条目数：凡是写了「N 条」的地方，N 必须等于真实条目数
// 这些数字散在三个文件里，已经各自漂移过一次（15 / 17 并存），而 PITFALLS
// 是「改代码前先看」的第一站——一个过期数字会让读者以为自己看全了。
{
  const pitfalls = readFileSync(join(ROOT, "docs/PITFALLS.md"), "utf8");
  const actual = (pitfalls.match(/^## \d+\./gm) ?? []).length;
  let claims = 0;
  let pointed = 0;
  for (const f of mdFiles) {
    const text = readFileSync(f, "utf8");
    // 「N 条」是总数；「第 N 条」/「§N」是条号。两者都要查，但含义不同，
    // 所以 `第` 后面的数字不能当成总数——那会把一条有效引用报成数字漂移。
    // `(?<!\d)` 是必需的：「第 13 条」里的 `3 条` 也是 `\d+条`，没有它就会
    // 把一条有效引用当成总数漂移报出来。
    for (const m of text.matchAll(/PITFALLS\.md[^\n]*?(?<!第\s*)(?<!\d)(\d+)\s*条/g)) {
      claims += 1;
      const claimed = Number(m[1]);
      if (claimed !== actual) {
        bad(`${f.replace(ROOT + "\\", "")} 称 PITFALLS 有 ${claimed} 条，实际 ${actual} 条`);
      }
    }
    for (const m of text.matchAll(/PITFALLS\.md[^\n]*?(?:第\s*(\d+)\s*条|§\s*(\d+))/g)) {
      pointed += 1;
      const cited = Number(m[1] ?? m[2]);
      if (cited < 1 || cited > actual) {
        bad(`${f.replace(ROOT + "\\", "")} 引用 PITFALLS 第 ${cited} 条，但只有 ${actual} 条`);
      }
    }
  }
  if (claims < 2) bad(`只找到 ${claims} 处「N 条」引用，检查本身可能已经失效`);
  else note(`PITFALLS 条目数 ${actual}，${claims} 处总数引用与 ${pointed} 处条号引用全部有效`);
}

if (fails.length) {
  console.error(`\n❌ docs.test.mjs 失败 ${fails.length} 项：`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✅ docs.test.mjs 全部通过\n");
