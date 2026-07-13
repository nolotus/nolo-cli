import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  assertCredentialRef,
  type CredentialBroker,
  type CredentialRef,
} from "./credentialBroker";
import { getCredentialsDir } from "./oauthTokenStore";

export type StoredApiKeyCredential = {
  secret: string;
  updatedAt: number;
};

export function getApiKeyCredentialsDir(homeDir = homedir()): string {
  return join(getCredentialsDir(homeDir), "keys");
}

/**
 * Map a credential ref to a single filename under ~/.nolo/credentials/keys/.
 * Colons become underscores so refs like `api-key:agent-foo` stay portable.
 */
export function credentialRefToFileName(ref: CredentialRef): string {
  const safe = assertCredentialRef(ref).replace(/[^a-zA-Z0-9._-]+/g, "_");
  if (!safe || safe === "." || safe === "..") {
    throw new Error(`Credential ref is not filesystem-safe: ${ref}`);
  }
  return `${safe}.json`;
}

export function getApiKeyCredentialPath(ref: CredentialRef, homeDir = homedir()): string {
  return join(getApiKeyCredentialsDir(homeDir), credentialRefToFileName(ref));
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort on platforms that ignore chmod (e.g. some Windows mounts).
  }
}

function writePrivateFile(path: string, body: string): void {
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort.
  }
}

export function readApiKeyCredential(
  ref: CredentialRef,
  homeDir = homedir(),
): string | null {
  const path = getApiKeyCredentialPath(ref, homeDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as StoredApiKeyCredential;
    if (typeof parsed?.secret !== "string" || !parsed.secret) return null;
    return parsed.secret;
  } catch {
    return null;
  }
}

export function writeApiKeyCredential(
  ref: CredentialRef,
  secret: string,
  homeDir = homedir(),
  now = Date.now(),
): void {
  const trimmedSecret = secret.trim();
  if (!trimmedSecret) {
    throw new Error("Cannot store an empty credential secret.");
  }
  assertCredentialRef(ref);
  const dir = getApiKeyCredentialsDir(homeDir);
  ensurePrivateDir(dir);
  const path = getApiKeyCredentialPath(ref, homeDir);
  const payload: StoredApiKeyCredential = {
    secret: trimmedSecret,
    updatedAt: now,
  };
  writePrivateFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

export function removeApiKeyCredential(ref: CredentialRef, homeDir = homedir()): void {
  assertCredentialRef(ref);
  const path = getApiKeyCredentialPath(ref, homeDir);
  if (!existsSync(path)) return;
  unlinkSync(path);
}

export function hasApiKeyCredential(ref: CredentialRef, homeDir = homedir()): boolean {
  return readApiKeyCredential(ref, homeDir) !== null;
}

export type CreateFileCredentialBrokerOptions = {
  homeDir?: string;
  now?: () => number;
};

/**
 * File-backed CredentialBroker for metered API keys.
 * OAuth tokens remain under ~/.nolo/credentials/<provider>.json via oauthTokenStore.
 */
export function createFileCredentialBroker(
  options: CreateFileCredentialBrokerOptions = {},
): CredentialBroker {
  const homeDir = options.homeDir ?? homedir();
  const now = options.now ?? Date.now;
  return {
    get(ref) {
      return readApiKeyCredential(ref, homeDir);
    },
    put(ref, secret) {
      writeApiKeyCredential(ref, secret, homeDir, now());
    },
    delete(ref) {
      removeApiKeyCredential(ref, homeDir);
    },
    has(ref) {
      return hasApiKeyCredential(ref, homeDir);
    },
  };
}
