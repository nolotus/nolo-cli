/**
 * Desktop host CredentialBroker factory.
 *
 * On darwin, defaults to macOS Keychain with lazy promote from the legacy file
 * broker. On win32, defaults to Windows Credential Manager with the same lazy
 * promote path. Linux (and explicit file override) keep the file broker until
 * a real Linux system store lands.
 *
 * Migration rules (Keychain / CredMan primary + legacy file):
 * - get primary hit is authoritative and may clean up a stale file copy;
 * - get primary miss → read file; on successful put to primary, delete file;
 * - promote put failure may return the file secret but must not delete file;
 * - new put writes primary only (no file fallback on put failure);
 * - has is true if either store has the ref;
 * - delete is idempotent on both stores (attempts both even when one fails).
 */

import type { CredentialBroker } from "./credentialBroker";
import { createFileCredentialBroker } from "./fileCredentialBroker";
import { createMacOsKeychainCredentialBroker } from "./macOsKeychainCredentialBroker";
import { createWindowsCredentialManagerBroker } from "./windowsCredentialManagerBroker";

export type DesktopCredentialStoreMode = "keychain" | "credman" | "file";

export type CreateDesktopHostCredentialBrokerOptions = {
  /** Override platform detection (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Env map; reads NOLO_DESKTOP_CREDENTIAL_STORE. Defaults to process.env. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Inject primary (Keychain) broker for tests. */
  keychainBroker?: CredentialBroker;
  /** Inject primary (Windows Credential Manager) broker for tests. */
  windowsCredentialBroker?: CredentialBroker;
  /** Inject legacy file broker for tests. */
  fileBroker?: CredentialBroker;
  /** Factory for Keychain broker when not injected. */
  createKeychainBroker?: () => CredentialBroker;
  /** Factory for Windows Credential Manager broker when not injected. */
  createWindowsCredentialBroker?: () => CredentialBroker;
  /** Factory for file broker when not injected. */
  createFileBroker?: () => CredentialBroker;
};

function resolveStoreMode(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): DesktopCredentialStoreMode {
  const override = String(env.NOLO_DESKTOP_CREDENTIAL_STORE ?? "")
    .trim()
    .toLowerCase();
  // Emergency escape hatch: force file store on any platform.
  if (override === "file") {
    return "file";
  }
  if (platform === "darwin") {
    return "keychain";
  }
  if (platform === "win32") {
    return "credman";
  }
  // Linux host system store is a later slice.
  return "file";
}

/**
 * Compose a platform system store + legacy file for lazy one-way promote on get.
 * Shared by macOS Keychain and Windows Credential Manager.
 */
function createMigratingSystemStoreBroker(args: {
  primary: CredentialBroker;
  file: CredentialBroker;
}): CredentialBroker {
  const { primary, file } = args;

  return {
    async get(ref) {
      const fromPrimary = await primary.get(ref);
      if (fromPrimary != null && fromPrimary.length > 0) {
        // Retry cleanup after an earlier promote succeeded but file deletion
        // failed. Primary is already authoritative, so cleanup is best-effort.
        try {
          await file.delete(ref);
        } catch {
          // A later read/delete can retry; never block use of the primary copy.
        }
        return fromPrimary;
      }

      const fromFile = await file.get(ref);
      if (fromFile == null || fromFile.length === 0) {
        return null;
      }

      // Lazy promote: only delete file after primary put succeeds.
      try {
        await primary.put(ref, fromFile);
      } catch {
        // Keep file; still return the secret so callers are not blocked.
        return fromFile;
      }

      try {
        await file.delete(ref);
      } catch {
        // Already durable in primary; leftover file is safe for a later get.
      }
      return fromFile;
    },

    async put(ref, secret) {
      // New writes go only to the system store. Fail closed — never fall back to file.
      await primary.put(ref, secret);
    },

    async delete(ref) {
      // Attempt both stores even when one fails, so a partial backend outage
      // cannot leave an avoidable legacy plaintext copy behind.
      let failed = false;
      try {
        await primary.delete(ref);
      } catch {
        failed = true;
      }
      try {
        await file.delete(ref);
      } catch {
        failed = true;
      }
      if (failed) {
        throw new Error("credential_broker_delete_failed");
      }
    },

    async has(ref) {
      if (await primary.has(ref)) return true;
      return Boolean(await file.has(ref));
    },
  };
}

/**
 * Desktop host default CredentialBroker.
 * - darwin → Keychain (+ file lazy promote) unless NOLO_DESKTOP_CREDENTIAL_STORE=file
 * - win32 → Windows Credential Manager (+ file lazy promote) unless override=file
 * - other platforms → file (until a Linux system store exists)
 */
export function createDesktopHostCredentialBroker(
  options: CreateDesktopHostCredentialBrokerOptions = {},
): CredentialBroker {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const mode = resolveStoreMode(platform, env);

  const createFile =
    options.createFileBroker ?? (() => createFileCredentialBroker());
  const file = options.fileBroker ?? createFile();

  if (mode === "file") {
    return file;
  }

  if (mode === "credman") {
    const createWindows =
      options.createWindowsCredentialBroker ??
      (() => createWindowsCredentialManagerBroker());
    const primary =
      options.windowsCredentialBroker ?? createWindows();
    return createMigratingSystemStoreBroker({ primary, file });
  }

  // mode === "keychain"
  const createKeychain =
    options.createKeychainBroker ??
    (() => createMacOsKeychainCredentialBroker());
  const primary = options.keychainBroker ?? createKeychain();

  return createMigratingSystemStoreBroker({ primary, file });
}
