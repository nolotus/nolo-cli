/**
 * macOS Keychain-backed CredentialBroker (Desktop host).
 *
 * Uses `/usr/bin/security` with an injectable runner so unit tests never touch
 * the real Keychain. Secrets never appear in argv, logs, or error messages.
 *
 * Security rules:
 * - One Keychain item per credential ref (service = namespace + hex(ref)).
 * - Fixed account slot under the nolo namespace (isolation is via service).
 * - put: `add-generic-password -U ... -w` with -w last; password via stdin prompt.
 * - get miss → null; delete item-not-found is idempotent.
 * - Hard failures throw only `credential_broker_{op}_failed` (no ref/secret/stderr).
 */

import { spawn } from "node:child_process";

import { asTrimmedString } from "../core/trimmedString";
import {
  assertCredentialRef,
  type CredentialBroker,
  type CredentialRef,
} from "./credentialBroker";

/** Stable service prefix for Desktop API-key Keychain items. */
export const MACOS_KEYCHAIN_SERVICE_PREFIX = "nolo.credentials.keys";

/** Fixed account attribute; isolation is via `service`, not account. */
export const MACOS_KEYCHAIN_ACCOUNT = "api-key";

/** CLI exit code for SecKeychain item-not-found. */
export const SECURITY_ITEM_NOT_FOUND_EXIT = 44;

const DEFAULT_SECURITY_BIN = "/usr/bin/security";

export type SecurityRunnerResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Injectable `security` command runner.
 * Callers must never put secrets into `args`; use `stdin` for password prompts.
 */
export type SecurityRunner = (input: {
  args: string[];
  stdin?: string;
}) => Promise<SecurityRunnerResult>;

export type CreateMacOsKeychainCredentialBrokerOptions = {
  /** Override `security` invocation (tests). Defaults to `/usr/bin/security`. */
  runner?: SecurityRunner;
  /** Override security binary path (production diagnostics only). */
  securityBin?: string;
  /** Override service prefix (tests only). */
  servicePrefix?: string;
  /** Override account attribute (tests only). */
  account?: string;
};

function safeCredentialRef(ref: CredentialRef): string {
  try {
    return assertCredentialRef(ref);
  } catch {
    throw new Error("invalid_ref");
  }
}

/**
 * Map a credential ref to a single Keychain `service` name.
 * Hex-encodes the full ref so sanitization cannot collide (`a:b` ≠ `a_b`).
 */
export function credentialRefToMacOsKeychainService(
  ref: CredentialRef,
  servicePrefix: string = MACOS_KEYCHAIN_SERVICE_PREFIX,
): string {
  const safe = safeCredentialRef(ref);
  const hex = Buffer.from(safe, "utf8").toString("hex");
  if (!hex) {
    throw new Error("invalid_ref");
  }
  return `${servicePrefix}.${hex}`;
}

function rethrowBrokerError(op: string, _error?: unknown): never {
  throw new Error(`credential_broker_${op}_failed`);
}

/**
 * Default runner: spawn `/usr/bin/security` without echoing secrets or stderr.
 */
export function createDefaultSecurityRunner(
  securityBin: string = DEFAULT_SECURITY_BIN,
): SecurityRunner {
  return function defaultSecurityRunner(input) {
    return new Promise<SecurityRunnerResult>((resolve) => {
      let settled = false;
      const finish = (result: SecurityRunnerResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(securityBin, input.args, {
          stdio: ["pipe", "pipe", "pipe"],
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

      if (input.stdin !== undefined) {
        child.stdin?.write(input.stdin);
      }
      child.stdin?.end();
    });
  };
}

/**
 * macOS Keychain CredentialBroker via `security` CLI.
 * Interface matches CredentialBroker / createFileCredentialBroker.
 */
export function createMacOsKeychainCredentialBroker(
  options: CreateMacOsKeychainCredentialBrokerOptions = {},
): CredentialBroker {
  const runner =
    options.runner ?? createDefaultSecurityRunner(options.securityBin);
  const servicePrefix =
    options.servicePrefix ?? MACOS_KEYCHAIN_SERVICE_PREFIX;
  const account = options.account ?? MACOS_KEYCHAIN_ACCOUNT;

  const serviceFor = (ref: CredentialRef): string =>
    credentialRefToMacOsKeychainService(ref, servicePrefix);

  return {
    async get(ref) {
      const safeRef = safeCredentialRef(ref);
      const service = serviceFor(safeRef);
      let result: SecurityRunnerResult;
      try {
        result = await runner({
          args: [
            "find-generic-password",
            "-a",
            account,
            "-s",
            service,
            "-w",
          ],
        });
      } catch (error) {
        rethrowBrokerError("get", error);
      }
      if (result.exitCode === SECURITY_ITEM_NOT_FOUND_EXIT) {
        return null;
      }
      if (result.exitCode !== 0) {
        rethrowBrokerError("get");
      }
      // find -w prints password only; strip a single trailing newline.
      const secret = result.stdout.replace(/\n$/, "");
      return secret.length > 0 ? secret : null;
    },

    async put(ref, secret) {
      const safeRef = safeCredentialRef(ref);
      const value = asTrimmedString(secret);
      if (!value) {
        throw new Error("Cannot store an empty credential secret.");
      }
      const service = serviceFor(safeRef);
      // -w last → interactive prompt reads password (and retype) from stdin.
      // Never place the secret in argv.
      const stdin = `${value}\n${value}\n`;
      let result: SecurityRunnerResult;
      try {
        result = await runner({
          args: [
            "add-generic-password",
            "-a",
            account,
            "-s",
            service,
            "-U",
            "-w",
          ],
          stdin,
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
      const service = serviceFor(safeRef);
      let result: SecurityRunnerResult;
      try {
        result = await runner({
          args: [
            "delete-generic-password",
            "-a",
            account,
            "-s",
            service,
          ],
        });
      } catch (error) {
        rethrowBrokerError("delete", error);
      }
      // Item-not-found is idempotent success.
      if (
        result.exitCode === 0 ||
        result.exitCode === SECURITY_ITEM_NOT_FOUND_EXIT
      ) {
        return;
      }
      rethrowBrokerError("delete");
    },

    async has(ref) {
      const safeRef = safeCredentialRef(ref);
      const service = serviceFor(safeRef);
      let result: SecurityRunnerResult;
      try {
        // Metadata lookup only (no -w / -g) — still never log stdout/stderr.
        result = await runner({
          args: [
            "find-generic-password",
            "-a",
            account,
            "-s",
            service,
          ],
        });
      } catch (error) {
        rethrowBrokerError("has", error);
      }
      if (result.exitCode === SECURITY_ITEM_NOT_FOUND_EXIT) {
        return false;
      }
      if (result.exitCode !== 0) {
        rethrowBrokerError("has");
      }
      return true;
    },
  };
}
