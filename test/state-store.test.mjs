/**
 * `state-store.ts` — the state-file primitives the four stores sit on.
 *
 * Why this file exists: `state-store.ts` is the shared foundation every opt-in
 * store reads and writes through (throttle / catalog / provider / draw), and it
 * is the module those stores reach for its PATH safety (`isProfileSegment`),
 * its ATOMIC write (`writeStateFile` + `temporaryOf`), its
 * "anything unreadable reads as absent" rule (`readStateJson`) and its shared
 * short-TTL read cache + one-shot legacy adoption (`createStateReadCache`).
 * Until now those primitives had NO suite of their own — `store.test.mjs`
 * exercises `token-store` / `throttle-store`, and the switch stores get their
 * behaviour through `switch-store.test.mjs`, but the primitives underneath them
 * (the path-traversal guard, the temp+rename atomicity, the TTL boundary, the
 * §23 one-shot adoption) were only ever covered indirectly, through whichever
 * store happened to call them. A change to, say, `isProfileSegment` or the TTL
 * comparison would only show up if some store's integration test happened to
 * probe that exact edge.
 *
 * The token-store playbook is "freeze first, then move" (`store-baseline`):
 * pin the behaviour against what the code does TODAY so a later refactor of
 * these primitives has a zero-drift gate. Every assertion below encodes the
 * current semantics, not a wish.
 *
 * Peer-free: no Host peer, no network, no DPAPI — only `node:fs` and the
 * injected `dir` / clock, matching how the module is used in production.
 */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateHostEnv, isolateStateDir } from "./peer-roots.mjs";
import {
  dshHome,
  stateDir,
  profileStateDir,
  isProfileSegment,
  profileSegment,
  readOptionalService,
  temporaryOf,
  writeStateFile,
  readStateJson,
  ensureStateDir,
  createStateReadCache,
  STATE_READ_TTL_MS
} from "../src/host/state-store.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

// --- 1. isProfileSegment: the path-traversal guard -------------------------
// A profile name becomes one path segment, so it is treated as EXTERNAL INPUT.
// These pin the charset / no-leading-dot / length rules; each rejected shape is
// a traversal the module must refuse.
{
  const group = "isProfileSegment";
  const accept = ["web", "desktop", "a", "profile-1", "a.b_c-d", "x1"];
  for (const name of accept) {
    check(`${group} accepts ${JSON.stringify(name)}`, isProfileSegment(name) === true, `got ${isProfileSegment(name)}`);
  }
  const reject = [
    ["", "empty"],
    ["   ", "whitespace-only"],
    [".", "bare dot"],
    ["..", "double dot"],
    [".hidden", "leading dot"],
    ["a/b", "path separator"],
    ["a\\b", "backslash"],
    ["web/../evil", "traversal"],
    ["w*eb", "glob char"],
    ["w?eb", "glob char"],
    ["w:b", "colon (windows drive risk)"],
    ["\0", "nul byte"],
    ["x".repeat(65), "over length cap"]
  ];
  for (const [value, why] of reject) {
    check(`${group} rejects ${why} (${JSON.stringify(value.slice(0, 12))})`, isProfileSegment(value) === false, `got ${isProfileSegment(value)}`);
  }
  // Non-strings must be refused, not coerced.
  for (const value of [null, undefined, 42, {}, [], true]) {
    check(`${group} rejects non-string ${typeof value}`, isProfileSegment(value) === false, `got ${isProfileSegment(value)}`);
  }
  // A segment that SURVIVES must be the trimmed name, not a coercion.
  check(`${group} trims a padded name before testing`, isProfileSegment("  web  ") === true, `got ${isProfileSegment("  web  ")}`);
}

// --- 2. the path builders: dshHome / stateDir / profileStateDir -------------
// The directory layout is a cross-process CONTRACT (PITFALLS §22/§23): throttle
// and the credentials grant deliberately SHARE the global path, the three
// switches are segmented per profile. Getting this wrong means two profiles
// overwrite each other, or a switch stops persisting.
{
  const restore = isolateHostEnv(["DSH_HOME"]);
  try {
    process.env.DSH_HOME = join(tmpdir(), "dsh-home-fixture");
    check("dshHome reads DSH_HOME when set", dshHome() === join(tmpdir(), "dsh-home-fixture"), `got ${dshHome()}`);
    check("stateDir is $DSH_HOME/state/<name>", stateDir("demo") === join(tmpdir(), "dsh-home-fixture", "state", "demo"), `got ${stateDir("demo")}`);
    // null profile = shared directory (the backwards-compatible default).
    check("profileStateDir(null) degrades to the shared dir", profileStateDir("demo", null) === stateDir("demo"), `got ${profileStateDir("demo", null)}`);
    // A real profile inserts one segment BETWEEN state/ and the name.
    check("profileStateDir('web') segments under the profile", profileStateDir("demo", "web") === join(tmpdir(), "dsh-home-fixture", "state", "web", "demo"), `got ${profileStateDir("demo", "web")}`);
  } finally {
    restore();
  }
}

// --- 3. temporaryOf: unique-per-write temp names ---------------------------
// Two Host processes can share one state dir, so a FIXED temp name lets each
// write land on the same path and one's rename can clobber the other's
// half-written file. The temp name must be process+clock unique.
{
  const dir = join("state", "demo");
  const a = temporaryOf(dir, "throttle.json", () => 1000);
  const b = temporaryOf(dir, "throttle.json", () => 2000);
  check("temporaryOf carries the final base name", a.includes("throttle.json."), `got ${a}`);
  check("temporaryOf ends in .tmp", a.endsWith(".tmp"), `got ${a}`);
  check("temporaryOf carries the pid", a.includes(`.${process.pid}.`), `got ${a}`);
  // Two writes in the same process must still land on DIFFERENT paths — the
  // clock half is what separates them, and that is the half a regression
  // (someone reusing a fixed name) would break.
  check("temporaryOf separates two writes by clock", a !== b, `both ${a}`);
}

// --- 4. writeStateFile: atomic temp+rename, 0600, trailing newline ---------
// The write path is where a partial file or a world-readable state file would
// leak, so: object/string both accepted, a trailing newline (every store wrote
// one before this module), and the temp file must NOT survive the rename.
{
  const restore = isolateStateDir();
  const dir = mkdtempSync(join(tmpdir(), "dsh-state-write-"));
  try {
    // object payload → JSON + newline, atomically renamed into place.
    const file = join(dir, "obj.json");
    const tmpObj = temporaryOf(dir, "obj.json");
    await writeStateFile(file, { a: 1 }, { temporary: tmpObj });
    check("writeStateFile(stringifies an object", readFileSync(file, "utf8") === '{"a":1}\n', `got ${JSON.stringify(readFileSync(file, "utf8"))}`);
    check("writeStateFile leaves no temp file behind", !existsSync(tmpObj), `temp still present: ${tmpObj}`);

    // string payload written VERBATIM (the documented string form).
    const file2 = join(dir, "raw.json");
    await writeStateFile(file2, '{"b":2}', { temporary: temporaryOf(dir, "raw.json") });
    check("writeStateFile writes a string verbatim + newline", readFileSync(file2, "utf8") === '{"b":2}\n', `got ${JSON.stringify(readFileSync(file2, "utf8"))}`);

    // The `[object Object]` trap (PITFALLS §36): primitives/null must THROW,
    // never land as literal text.
    for (const bad of [null, undefined, 42, true]) {
      let threw = false;
      try {
        await writeStateFile(join(dir, "bad.json"), bad, { temporary: temporaryOf(dir, "bad.json") });
      } catch {
        threw = true;
      }
      check(`writeStateFile refuses ${String(bad)} (no [object Object])`, threw, "did not throw");
    }

    // A read-only-ish target: a directory path as the FILE makes rename fail —
    // the failure must PROPAGATE (the callers, not this primitive, decide to
    // swallow it).
    const asDir = join(dir, "collide");
    mkdirSync(asDir);
    let propagated = false;
    try {
      await writeStateFile(asDir, { x: 1 }, { temporary: temporaryOf(dir, "collide") });
    } catch {
      propagated = true;
    }
    check("writeStateFile propagates a failing rename (caller decides to swallow)", propagated, "swallowed inside the primitive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restore();
  }
}

// --- 5. readStateJson: absent / non-JSON / unreadable all read as null -----
// "Corrupt reads as absent" is the safe direction for every consumer: one more
// attempt, never a crash. Pin all three inputs to `null`.
{
  const restore = isolateStateDir();
  const dir = mkdtempSync(join(tmpdir(), "dsh-state-read-"));
  try {
    check("readStateJson(missing) is null", (await readStateJson(join(dir, "nope.json"))) === null);
    writeFileSync(join(dir, "bad.json"), "{not json", "utf8");
    check("readStateJson(non-JSON) is null", (await readStateJson(join(dir, "bad.json"))) === null);
    writeFileSync(join(dir, "ok.json"), '{"x":5}', "utf8");
    const parsed = await readStateJson(join(dir, "ok.json"));
    check("readStateJson(valid) parses", parsed !== null && parsed.x === 5, `got ${JSON.stringify(parsed)}`);
    // a directory is unreadable as a file
    mkdirSync(join(dir, "adir"));
    check("readStateJson(directory) is null", (await readStateJson(join(dir, "adir"))) === null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restore();
  }
}

// --- 6. createStateReadCache: TTL boundary + remember() -------------------
// The cache is the upper bound on "how stale is this process's view" under a
// shared state dir. Pin: (a) within TTL the read-through does NOT re-run,
// (b) past TTL it DOES, (c) null is a cacheable value distinct from "never
// read", (d) remember() makes a fresh write self-visible without a TTL wait.
{
  const group = "createStateReadCache";
  let calls = 0;
  let backing = { v: 1 };
  const rt = async () => { calls += 1; return backing; };
  let t = 0;
  const cache = createStateReadCache(rt, { ttlMs: 1000, now: () => t });

  check(`${group} first read penetrates and caches`, (await cache.read()).v === 1 && calls === 1, `calls=${calls}`);
  t = 500; // within TTL
  await cache.read();
  check(`${group} within TTL does NOT re-read the disk`, calls === 1, `calls=${calls}`);
  t = 1001; // past TTL (>= ttl)
  await cache.read();
  check(`${group} past TTL re-reads`, calls === 2, `calls=${calls}`);

  // null is a legitimate cached value; a later non-null read still refreshes
  // after TTL, and a null read is served from cache within TTL.
  calls = 0;
  let backing2 = null;
  const cache2 = createStateReadCache(async () => { calls += 1; return backing2; }, { ttlMs: 1000, now: () => t });
  t = 0;
  check(`${group} a null read is a cacheable value`, (await cache2.read()) === null && calls === 1, `calls=${calls}`);
  t = 500;
  await cache2.read();
  check(`${group} null stays cached within TTL`, calls === 1, `calls=${calls}`);
  t = 1001;
  await cache2.read();
  check(`${group} null re-reads past TTL`, calls === 2, `calls=${calls}`);

  // remember() seeds the cache so a just-written value is self-visible.
  calls = 0;
  const cache3 = createStateReadCache(async () => { calls += 1; return { stale: true }; }, { ttlMs: 1000, now: () => t });
  t = 0;
  cache3.remember({ fresh: true });
  const got = await cache3.read();
  check(`${group} remember() makes a fresh write visible without a read`, calls === 0 && got.fresh === true, `calls=${calls} got=${JSON.stringify(got)}`);
}

// --- 7. createStateReadCache: the §23 one-shot legacy adoption -------------
// Per-profile segmentation left the old shared-path value behind. On a read that
// finds its OWN record missing, the cache adopts the legacy value ONCE: reads
// it, writes it back, returns it. It must try exactly once (a machine with no
// legacy file should not re-read every TTL) and must not loop.
{
  const group = "legacy adoption";
  // Instance 1: a missing own record adopts the legacy value and writes it back.
  let inheritReads = 0;
  let inheritWrites = 0;
  const cache = createStateReadCache(
    async () => null, // own record never appears
    {
      ttlMs: 1000,
      now: () => 0,
      inheritFrom: {
        read: async () => { inheritReads += 1; return { legacy: true }; },
        write: async () => { inheritWrites += 1; }
      }
    }
  );
  const first = await cache.read();
  check(`${group} a missing own record adopts the legacy value`, first !== null && first.legacy === true, `got ${JSON.stringify(first)}`);
  check(`${group} adoption writes the value back (once)`, inheritWrites === 1, `writes=${inheritWrites}`);

  // Instance 2 (own counters): across repeated TTL expiries with the own record
  // STILL missing, the legacy path is consulted exactly ONCE — a machine with
  // no legacy file must not pay an extra read every TTL.
  let adoptReads = 0;
  let adoptWrites = 0;
  let clock = 0;
  const cache2 = createStateReadCache(
    async () => null,
    {
      ttlMs: 1,
      now: () => (clock += 2), // every read is a TTL expiry
      inheritFrom: {
        read: async () => { adoptReads += 1; return { legacy: true }; },
        write: async () => { adoptWrites += 1; }
      }
    }
  );
  await cache2.read();
  await cache2.read();
  await cache2.read();
  check(`${group} adoption is one-shot across TTL expiries`, adoptReads === 1, `inheritReads=${adoptReads} (want 1)`);
  check(`${group} the write-back also happened exactly once`, adoptWrites === 1, `inheritWrites=${adoptWrites} (want 1)`);

  // A FAILING legacy write-back (read-only Home, or another process won the
  // race) must not reject the read — the value still serves this process.
  let adopted = null;
  let rejected = false;
  try {
    const cache3 = createStateReadCache(
      async () => null,
      { ttlMs: 1, now: () => 0, inheritFrom: { read: async () => ({ v: 1 }), write: async () => { throw new Error("read-only home"); } } }
    );
    adopted = await cache3.read();
  } catch {
    rejected = true;
  }
  check(`${group} a failing legacy write does not reject the read`, !rejected && adopted !== null && adopted.v === 1, `rejected=${rejected} got ${JSON.stringify(adopted)}`);

  // No legacy configured at all: a missing own record just reads null.
  const cache4 = createStateReadCache(async () => null, { ttlMs: 1, now: () => 0 });
  check(`${group} no inheritFrom + missing record is null`, (await cache4.read()) === null);

  // The own record WINS over the legacy value — adoption is a fallback, not an
  // override.
  const cache5 = createStateReadCache(
    async () => ({ own: true }),
    { ttlMs: 1000, now: () => 0, inheritFrom: { read: async () => { throw new Error("must not be consulted"); }, write: async () => {} } }
  );
  const own = await cache5.read();
  check(`${group} an existing own record never consults the legacy path`, own !== null && own.own === true, `got ${JSON.stringify(own)}`);
}

// --- 8. profileSegment / readOptionalService: optional-service reading -----
// profileContext is OPTIONAL on the real host; reading it must never throw and
// must degrade to the shared path (null). readOptionalService tries ctx.get,
// then ctx.reflect.get, then a plain property — the last one guarded because a
// real Cordis throws on undeclared property access.
{
  const group = "profileSegment";
  check(`${group} a null ctx is null`, profileSegment(null) === null);
  check(`${group} a non-object ctx is null`, profileSegment(42) === null);
  // no profileContext at all
  check(`${group} a host with no profileContext is null`, profileSegment({ get: () => undefined }) === null);
  // via ctx.get
  check(`${group} reads the name via ctx.get`, profileSegment({ get: () => ({ name: "web" }) }) === "web");
  // via ctx.reflect.get
  check(`${group} falls back to reflect.get`, profileSegment({ reflect: { get: () => ({ name: "desktop" }) } }) === "desktop");
  // a service present but not an object
  check(`${group} a non-object service is null`, profileSegment({ get: () => "not-an-object" }) === null);
  // a service with an UNSAFE name (traversal) must not be trusted
  check(`${group} an unsafe name is refused (null)`, profileSegment({ get: () => ({ name: "../evil" }) }) === null);
  // plain-object stub (the last-resort entry)
  check(`${group} reads a plain-object stub`, profileSegment({ profileContext: { name: "web" } }) === "web");

  // readOptionalService: throws in every entry ⇒ undefined, never propagate.
  const g2 = "readOptionalService";
  check(`${g2} returns undefined when nothing provides it`, readOptionalService({}, "settings") === undefined);
  check(`${g2} a throwing ctx.get falls through to undefined`, readOptionalService({ get: () => { throw new Error("no mixin"); } }, "settings") === undefined);
  check(`${g2} reads through ctx.get when present`, readOptionalService({ get: (n) => n === "settings" ? 42 : undefined }, "settings") === 42);
  check(`${g2} reads through a plain property stub`, readOptionalService({ settings: "v" }, "settings") === "v");
}

// --- 9. STATE_READ_TTL_MS is the documented short bound -------------------
// A regression here (e.g. someone raising it to minutes) would silently widen
// the "another process's write becomes visible" window, so pin the contract
// that it is a SUBDURATION default, not a cache-forever.
{
  check("STATE_READ_TTL_MS is a short sub-minute bound", STATE_READ_TTL_MS > 0 && STATE_READ_TTL_MS < 60_000, `got ${STATE_READ_TTL_MS}`);
}

// --- report ---------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? "  ok" : "  NOT OK"} - ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log(`\n${failed.length === 0 ? "all" : failed.length} ${results.length} checks passed${failed.length ? `; ${failed.length} FAILED` : ""}`);
if (failed.length > 0) process.exit(1);
