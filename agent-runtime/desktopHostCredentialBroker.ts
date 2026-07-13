/**
 * Desktop host CredentialBroker factory.
 *
 * On darwin, defaults to macOS Keychain with lazy promote from the legacy file
 * broker. Non-darwin (and explicit file override) keep the file broker until
 * Windows/Linux host stores land.
 *
 * Migration rules:
 * - get Keychain miss → read file; on successful put to Keychain, delete file.
 * - promote put failure may return the file secret but must not delete file.
 * - new put writes Keychain only (no file fallback on put failure).
 * - has is true if either store has the ref.
 * - delete is idempotent on both stores.
 */

import type { CredentialBroker } from "./credentialBroker";
import { createFileCredentialBroker } from "./fileCredentialBroker";
import { createMacOsKeychainCredentialBroker } from "./macOsKeychainCredentialBroker";

export type DesktopCredentialStoreMode = "keychain" | "file";

export type CreateDesktopHostCredentialBrokerOptions = {
  /** Override platform detection (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Env map; reads NOLO_DESKTOP_CREDENTIAL_STORE. Defaults to process.env. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Inject primary (Keychain) broker for tests. */
  keychainBroker?: CredentialBroker;
  /** Inject legacy file broker for tests. */
  fileBroker?: CredentialBroker;
  /** Factory for Keychain broker when not injected. */
  createKeychainBroker?: () => CredentialBroker;
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
  // Windows/Linux host stores are a later slice.
  return "file";
}

/**
 * Compose Keychain + file for lazy one-way promote on get.
 */
function createDarwinMigratingBroker(args: {
  keychain: CredentialBroker;
  file: CredentialBroker;
}): CredentialBroker {
  const { keychain, file } = args;

  return {
    async get(ref) {
      const fromKeychain = await keychain.get(ref);
      if (fromKeychain != null && fromKeychain.length > 0) {
        // Retry cleanup after an earlier promote succeeded but file deletion
        // failed. Keychain is already authoritative, so cleanup is best-effort.
        try {
          await file.delete(ref);
        } catch {
          // A later read/delete can retry; never block use of the Keychain copy.
        }
        return fromKeychain;
      }

      const fromFile = await file.get(ref);
      if (fromFile == null || fromFile.length === 0) {
        return null;
      }

      // Lazy promote: only delete file after Keychain put succeeds.
      try {
        await keychain.put(ref, fromFile);
      } catch {
        // Keep file; still return the secret so callers are not blocked.
        return fromFile;
      }

      try {
        await file.delete(ref);
      } catch {
        // Already durable in Keychain; leftover file is safe for a later get.
      }
      return fromFile;
    },

    async put(ref, secret) {
      // New writes go only to Keychain. Fail closed — never fall back to file.
      await keychain.put(ref, secret);
    },

    async delete(ref) {
      // Attempt both stores even when one fails, so a partial backend outage
      // cannot leave an avoidable legacy plaintext copy behind.
      let failed = false;
      try {
        await keychain.delete(ref);
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
      if (await keychain.has(ref)) return true;
      return Boolean(await file.has(ref));
    },
  };
}

/**
 * Desktop host default CredentialBroker.
 * - darwin → Keychain (+ file lazy promote) unless NOLO_DESKTOP_CREDENTIAL_STORE=file
 * - other platforms → file (until Windows CredMan / Linux store)
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

  const createKeychain =
    options.createKeychainBroker ??
    (() => createMacOsKeychainCredentialBroker());
  const keychain = options.keychainBroker ?? createKeychain();

  return createDarwinMigratingBroker({ keychain, file });
}
