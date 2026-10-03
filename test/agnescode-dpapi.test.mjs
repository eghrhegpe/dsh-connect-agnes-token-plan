/**
 * The ONE layer `agnescode.test.mjs` cannot reach by design: the production
 * DPAPI unwrap (`defaultDpapiUnprotect`), a PowerShell child process.
 *
 * Everything upstream of the DPAPI call is injectable and covered there with
 * fixtures; this suite exercises the real OS path end-to-end — it protects
 * fresh random bytes with `ProtectedData::Protect` (CurrentUser scope) via the
 * same PowerShell runtime the implementation uses, then feeds them to
 * `defaultDpapiUnprotect` through stdin and checks the bytes come back.
 *
 * Why a real process instead of an injection: the injected tests pin the
 * contract AROUND the call, but the call itself — the stdin pipe write, the
 * binary stdout read-back, the exit-code handling, the stderr capture — has
 * zero coverage anywhere (`live-agnescode.mjs` does not touch it either), and
 * it is the one leg of the harvest that regresses silently (a PowerShell
 * quoting slip shows up only as "no session on this machine").
 *
 * It is offline (DPAPI is a local user-key call) and touches none of the
 * user's real AgnesCode files: only bytes this suite itself just encrypted.
 * DPAPI is Windows-only; elsewhere the suite SKIPs, mirroring the
 * implementation's own `UNSUPPORTED_PLATFORM` stance.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function section(title) {
  console.log(`\n— ${title}`);
}

const IS_WIN = process.platform === "win32";

/**
 * Protect bytes through a PowerShell child, the mirror image of
 * `defaultDpapiUnprotect`'s unwrap script (stdin in → CurrentUser scope →
 * stdout out). Must be the same process family so the CurrentUser key matches.
 * @param {Buffer} plain - the bytes to protect.
 * @returns {{ out: Buffer, ok: boolean, stderr: string }}
 */
function dpapiProtect(plain) {
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$in = [Console]::OpenStandardInput()",
    "$ms = New-Object IO.MemoryStream",
    "$in.CopyTo($ms)",
    "$pt = [Security.Cryptography.ProtectedData]::Protect($ms.ToArray(), $null, 'CurrentUser')",
    "[Console]::OpenStandardOutput().Write($pt, 0, $pt.Length)"
  ].join("; ");
  const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: plain,
    windowsHide: true,
    timeout: 20_000
  });
  return {
    out: Buffer.concat((res.stdout ? [res.stdout] : [])),
    ok: res.status === 0,
    stderr: (res.stderr ?? "").toString()
  };
}

if (!IS_WIN) {
  console.log("agnescode-dpapi.test.mjs: SKIP (DPAPI is Windows-only; the implementation maps other platforms to UNSUPPORTED_PLATFORM)");
} else {
  const { defaultDpapiUnprotect } = await import("../src/host/agnescode.ts");

  section("real DPAPI round-trip (Protect in PowerShell → defaultDpapiUnprotect)");
  // The production payload is a 32-byte os_crypt key; a second, larger buffer
  // proves the stdin→stdout binary pipe is not truncating at one chunk.
  for (const size of [32, 1024]) {
    const secret = randomBytes(size);
    const wrapped = dpapiProtect(secret);
    check(`PowerShell ProtectedData::Protect produced a wrapped blob (${size}B)`,
      wrapped.ok && wrapped.out.length > size, wrapped.stderr.slice(0, 200));
    let got;
    let why;
    try {
      got = await defaultDpapiUnprotect(wrapped.out);
    } catch (error) {
      why = error;
    }
    check(`defaultDpapiUnprotect returns the exact original bytes (${size}B)`,
      !why && Buffer.isBuffer(got) && Buffer.compare(got, secret) === 0,
      why ? String(why.message ?? why) : `got ${got?.length}B`);
  }

  section("failure path (bytes no CurrentUser blob can decrypt)");
  // Random garbage is not a valid DPAPI blob: the child must exit non-zero and
  // the implementation must reject with its exit-status message (carrying the
  // captured stderr), never resolve.
  let failure;
  try {
    await defaultDpapiUnprotect(randomBytes(48));
  } catch (error) {
    failure = error;
  }
  check("garbage input rejects with the exit-status message",
    failure instanceof Error && failure.message.includes("DPAPI unprotect failed"),
    failure ? String(failure.message ?? failure) : "resolved without throwing");
}

// --- report ------------------------------------------------------------------
const passed = results.filter((result) => result.pass).length;
const failed = results.filter((result) => !result.pass);
for (const result of failed) {
  console.error(`  FAIL  ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
}
console.log(`\nagnescode-dpapi.test.mjs: ${passed}/${results.length} passed${results.length === 0 ? " (skipped)" : ""}`);
if (failed.length > 0) process.exitCode = 1;
