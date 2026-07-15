/**
 * Windows Credential Manager-backed CredentialBroker (Desktop host).
 *
 * Uses PowerShell + advapi32 CredWriteW/CredReadW/CredDeleteW/CredFree with an
 * injectable runner so unit tests never touch the real Credential Manager.
 * Secrets never appear in argv, logs, or error messages.
 *
 * Security rules:
 * - One generic credential per ref (target = namespace + hex(ref)).
 * - Fixed username slot under the nolo namespace (isolation is via target).
 * - All ops: static secret-free PowerShell script; op/target/secret via stdin JSON.
 * - get miss (ERROR_NOT_FOUND 1168) → null; delete missing is idempotent.
 * - Hard failures throw only `credential_broker_{op}_failed` (no ref/secret/stderr).
 */

import { spawn } from "node:child_process";

import { asTrimmedString } from "../core/trimmedString";
import {
  assertCredentialRef,
  type CredentialBroker,
  type CredentialRef,
} from "./credentialBroker";

/** Stable target prefix for Desktop API-key Credential Manager items. */
export const WINDOWS_CREDENTIAL_TARGET_PREFIX = "nolo.credentials.keys";

/** Fixed username attribute; isolation is via `target`, not username. */
export const WINDOWS_CREDENTIAL_USERNAME = "api-key";

/** Win32 ERROR_NOT_FOUND — CredReadW/CredDeleteW when target is missing. */
export const WIN_ERROR_NOT_FOUND = 1168;

/**
 * Static PowerShell script (no secrets). Reads one JSON object from stdin:
 * `{ "op": "get"|"put"|"delete"|"has", "target": string, "secret"?: string }`.
 * get success stdout is machine JSON: `{"secret":"..."}` only.
 */
export const WINDOWS_CREDENTIAL_MANAGER_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { exit 1 }
  $req = $raw | ConvertFrom-Json
  $op = [string]$req.op
  $target = [string]$req.target
  if ([string]::IsNullOrWhiteSpace($op) -or [string]::IsNullOrWhiteSpace($target)) { exit 1 }

  Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class NoloCredNative {
  public const int CRED_TYPE_GENERIC = 1;
  public const int CRED_PERSIST_LOCAL_MACHINE = 2;
  public const int ERROR_NOT_FOUND = 1168;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref CREDENTIAL userCredential, uint flags);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, int type, int reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDeleteW(string target, int type, int flags);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
}
"@

  if ($op -eq 'get') {
    $ptr = [IntPtr]::Zero
    $ok = [NoloCredNative]::CredReadW($target, [NoloCredNative]::CRED_TYPE_GENERIC, 0, [ref]$ptr)
    if (-not $ok) {
      exit [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    }
    try {
      $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][NoloCredNative+CREDENTIAL])
      if ($cred.CredentialBlobSize -le 0 -or $cred.CredentialBlob -eq [IntPtr]::Zero) {
        $payload = @{ secret = '' } | ConvertTo-Json -Compress
        [Console]::Out.Write($payload)
        exit 0
      }
      $bytes = New-Object byte[] $cred.CredentialBlobSize
      [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
      $secret = [Text.Encoding]::UTF8.GetString($bytes)
      $payload = @{ secret = $secret } | ConvertTo-Json -Compress
      [Console]::Out.Write($payload)
      exit 0
    } finally {
      [NoloCredNative]::CredFree($ptr)
    }
  }

  if ($op -eq 'has') {
    $ptr = [IntPtr]::Zero
    $ok = [NoloCredNative]::CredReadW($target, [NoloCredNative]::CRED_TYPE_GENERIC, 0, [ref]$ptr)
    if (-not $ok) {
      exit [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    }
    [NoloCredNative]::CredFree($ptr)
    exit 0
  }

  if ($op -eq 'put') {
    $secret = [string]$req.secret
    if ([string]::IsNullOrEmpty($secret)) { exit 1 }
    $blob = [Text.Encoding]::UTF8.GetBytes($secret)
    $cred = New-Object NoloCredNative+CREDENTIAL
    $cred.Type = [NoloCredNative]::CRED_TYPE_GENERIC
    $cred.TargetName = $target
    $cred.UserName = 'api-key'
    $cred.Persist = [NoloCredNative]::CRED_PERSIST_LOCAL_MACHINE
    $cred.CredentialBlobSize = $blob.Length
    $cred.CredentialBlob = [Runtime.InteropServices.Marshal]::AllocHGlobal($blob.Length)
    try {
      if ($blob.Length -gt 0) {
        [Runtime.InteropServices.Marshal]::Copy($blob, 0, $cred.CredentialBlob, $blob.Length)
      }
      $ok = [NoloCredNative]::CredWriteW([ref]$cred, 0)
      if (-not $ok) {
        exit [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      }
      exit 0
    } finally {
      [Runtime.InteropServices.Marshal]::FreeHGlobal($cred.CredentialBlob)
    }
  }

  if ($op -eq 'delete') {
    $ok = [NoloCredNative]::CredDeleteW($target, [NoloCredNative]::CRED_TYPE_GENERIC, 0)
    if (-not $ok) {
      exit [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    }
    exit 0
  }

  exit 1
} catch {
  exit 1
}
`.trim();

export type WindowsCredentialRunnerResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Injectable Windows credential process runner.
 * Callers must never put secrets or refs into `args`; use `stdin` JSON only.
 */
export type WindowsCredentialRunner = (input: {
  args: string[];
  stdin?: string;
}) => Promise<WindowsCredentialRunnerResult>;

export type CreateWindowsCredentialManagerBrokerOptions = {
  /** Override PowerShell invocation (tests). Defaults to powershell.exe / pwsh. */
  runner?: WindowsCredentialRunner;
  /** Override shell binary path (production diagnostics only). */
  shellBin?: string;
  /** Override target prefix (tests only). */
  targetPrefix?: string;
};

function safeCredentialRef(ref: CredentialRef): string {
  try {
    return assertCredentialRef(ref);
  } catch {
    throw new Error("invalid_ref");
  }
}

/**
 * Map a credential ref to a single Credential Manager `TargetName`.
 * Hex-encodes the full ref so sanitization cannot collide (`a:b` ≠ `a_b`).
 */
export function credentialRefToWindowsCredentialTarget(
  ref: CredentialRef,
  targetPrefix: string = WINDOWS_CREDENTIAL_TARGET_PREFIX,
): string {
  const safe = safeCredentialRef(ref);
  const hex = Buffer.from(safe, "utf8").toString("hex");
  if (!hex) {
    throw new Error("invalid_ref");
  }
  return `${targetPrefix}.${hex}`;
}

function rethrowBrokerError(op: string, _error?: unknown): never {
  throw new Error(`credential_broker_${op}_failed`);
}

/** Build static PowerShell argv (no op/target/secret/ref). */
export function buildWindowsCredentialPowerShellArgs(
  script: string = WINDOWS_CREDENTIAL_MANAGER_SCRIPT,
): string[] {
  // -EncodedCommand expects UTF-16LE base64; keeps quoting safe and secret-free.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ];
}

function requestStdin(payload: {
  op: "get" | "put" | "delete" | "has";
  target: string;
  secret?: string;
}): string {
  // Single JSON object; secret only for put. Never place secret/ref on argv.
  return JSON.stringify(payload);
}

/**
 * Parse get stdout: machine JSON only, shape `{ "secret": string }`.
 * Never concatenates raw stderr into errors or return values.
 */
function parseGetSecretFromStdout(stdout: string): string {
  const trimmed = asTrimmedString(stdout);
  if (!trimmed) {
    rethrowBrokerError("get");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    rethrowBrokerError("get");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { secret?: unknown }).secret !== "string"
  ) {
    rethrowBrokerError("get");
  }
  return (parsed as { secret: string }).secret;
}

function spawnShell(
  bin: string,
  args: string[],
  stdin?: string,
): Promise<WindowsCredentialRunnerResult> {
  return new Promise<WindowsCredentialRunnerResult>((resolve) => {
    let settled = false;
    const finish = (result: WindowsCredentialRunnerResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      finish({ exitCode: -1, stdout: "", stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", () => {
      finish({ exitCode: -1, stdout: "", stderr: "" });
    });
    child.on("close", (code) => {
      finish({
        exitCode: typeof code === "number" ? code : -1,
        stdout,
        stderr,
      });
    });

    if (stdin !== undefined) {
      child.stdin?.write(stdin);
    }
    child.stdin?.end();
  });
}

/**
 * Default runner: spawn powershell.exe (fallback pwsh) without echoing secrets.
 */
export function createDefaultWindowsCredentialRunner(
  shellBin?: string,
): WindowsCredentialRunner {
  let resolvedBin: string | null = shellBin ?? null;

  return async function defaultWindowsCredentialRunner(input) {
    if (resolvedBin) {
      return spawnShell(resolvedBin, input.args, input.stdin);
    }

    // Prefer Windows PowerShell, then PowerShell Core.
    const first = await spawnShell("powershell.exe", input.args, input.stdin);
    if (first.exitCode !== -1) {
      resolvedBin = "powershell.exe";
      return first;
    }
    const second = await spawnShell("pwsh", input.args, input.stdin);
    if (second.exitCode !== -1) {
      resolvedBin = "pwsh";
    }
    return second;
  };
}

/**
 * Windows Credential Manager CredentialBroker via PowerShell + advapi32.
 * Interface matches CredentialBroker / createFileCredentialBroker.
 */
export function createWindowsCredentialManagerBroker(
  options: CreateWindowsCredentialManagerBrokerOptions = {},
): CredentialBroker {
  const runner =
    options.runner ?? createDefaultWindowsCredentialRunner(options.shellBin);
  const targetPrefix =
    options.targetPrefix ?? WINDOWS_CREDENTIAL_TARGET_PREFIX;

  const targetFor = (ref: CredentialRef): string =>
    credentialRefToWindowsCredentialTarget(ref, targetPrefix);

  const staticArgs = buildWindowsCredentialPowerShellArgs();

  return {
    async get(ref) {
      const safeRef = safeCredentialRef(ref);
      const target = targetFor(safeRef);
      let result: WindowsCredentialRunnerResult;
      try {
        result = await runner({
          args: staticArgs,
          stdin: requestStdin({ op: "get", target }),
        });
      } catch (error) {
        rethrowBrokerError("get", error);
      }
      if (result.exitCode === WIN_ERROR_NOT_FOUND) {
        return null;
      }
      if (result.exitCode !== 0) {
        rethrowBrokerError("get");
      }
      const secret = parseGetSecretFromStdout(result.stdout);
      return secret.length > 0 ? secret : null;
    },

    async put(ref, secret) {
      const safeRef = safeCredentialRef(ref);
      const value = asTrimmedString(secret);
      if (!value) {
        throw new Error("Cannot store an empty credential secret.");
      }
      const target = targetFor(safeRef);
      let result: WindowsCredentialRunnerResult;
      try {
        result = await runner({
          args: staticArgs,
          stdin: requestStdin({ op: "put", target, secret: value }),
        });
      } catch (error) {
        rethrowBrokerError("put", error);
      }
      if (result.exitCode !== 0) {
        rethrowBrokerError("put");
      }
    },

    async delete(ref) {
      const safeRef = safeCredentialRef(ref);
      const target = targetFor(safeRef);
      let result: WindowsCredentialRunnerResult;
      try {
        result = await runner({
          args: staticArgs,
          stdin: requestStdin({ op: "delete", target }),
        });
      } catch (error) {
        rethrowBrokerError("delete", error);
      }
      // Missing target is idempotent success.
      if (
        result.exitCode === 0 ||
        result.exitCode === WIN_ERROR_NOT_FOUND
      ) {
        return;
      }
      rethrowBrokerError("delete");
    },

    async has(ref) {
      const safeRef = safeCredentialRef(ref);
      const target = targetFor(safeRef);
      let result: WindowsCredentialRunnerResult;
      try {
        result = await runner({
          args: staticArgs,
          stdin: requestStdin({ op: "has", target }),
        });
      } catch (error) {
        rethrowBrokerError("has", error);
      }
      if (result.exitCode === WIN_ERROR_NOT_FOUND) {
        return false;
      }
      if (result.exitCode !== 0) {
        rethrowBrokerError("has");
      }
      return true;
    },
  };
}
