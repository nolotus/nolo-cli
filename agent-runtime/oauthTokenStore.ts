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

export type OAuthProvider = "chatgpt" | "xai" | "antigravity" | "cloudflare";

export type OAuthCredential = {
  provider: OAuthProvider;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  idToken?: string;
  accountId?: string;
  metadata?: Record<string, unknown>;
  obtainedAt: number;
};

export type OAuthTokenStore = {
  read(provider: OAuthProvider): OAuthCredential | null;
  write(provider: OAuthProvider, credential: OAuthCredential): void;
  remove(provider: OAuthProvider): void;
};

export type OAuthRefreshFn = (
  credential: OAuthCredential,
  deps?: { fetchImpl?: typeof fetch; now?: () => number }
) => Promise<OAuthCredential>;
export const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

export function getCredentialsDir(homeDir = homedir()): string {
  return join(homeDir, ".nolo", "credentials");
}

export function getCredentialPath(provider: OAuthProvider, homeDir = homedir()): string {
  return join(getCredentialsDir(homeDir), `${provider}.json`);
}

/** Same private-dir pattern as fileCredentialBroker (0700, best-effort chmod). */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort on platforms that ignore chmod (e.g. some Windows mounts).
  }
}

/** Same private-file pattern as fileCredentialBroker (0600, best-effort chmod). */
function writePrivateFile(path: string, body: string): void {
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort.
  }
}

export function readOAuthCredential(
  provider: OAuthProvider,
  homeDir = homedir()
): OAuthCredential | null {
  const path = getCredentialPath(provider, homeDir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw) as OAuthCredential;
    if (!parsed?.provider || !parsed?.accessToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeOAuthCredential(
  provider: OAuthProvider,
  credential: OAuthCredential,
  homeDir = homedir()
): void {
  const path = getCredentialPath(provider, homeDir);
  ensurePrivateDir(getCredentialsDir(homeDir));
  writePrivateFile(path, `${JSON.stringify(credential, null, 2)}\n`);
}

export function removeOAuthCredential(provider: OAuthProvider, homeDir = homedir()): void {
  const path = getCredentialPath(provider, homeDir);
  if (!existsSync(path)) return;
  unlinkSync(path);
}

export function createOAuthTokenStore(homeDir = homedir()): OAuthTokenStore {
  return {
    read(provider) {
      return readOAuthCredential(provider, homeDir);
    },
    write(provider, credential) {
      writeOAuthCredential(provider, credential, homeDir);
    },
    remove(provider) {
      removeOAuthCredential(provider, homeDir);
    },
  };
}

export function isTokenExpired(
  credential: OAuthCredential,
  skewMs = DEFAULT_REFRESH_SKEW_MS,
  now = Date.now()
): boolean {
  if (!credential.expiresAt) return false;
  return credential.expiresAt - now <= skewMs;
}

export async function resolveFreshAccessToken(args: {
  provider: OAuthProvider;
  store?: OAuthTokenStore;
  homeDir?: string;
  refresh?: OAuthRefreshFn;
  skewMs?: number;
  now?: () => number;
}): Promise<string | null> {
  const store = args.store ?? createOAuthTokenStore(args.homeDir);
  const now = args.now ?? Date.now;
  const credential = store.read(args.provider);
  if (!credential) return null;
  if (!isTokenExpired(credential, args.skewMs ?? DEFAULT_REFRESH_SKEW_MS, now())) {
    return credential.accessToken;
  }
  if (!credential.refreshToken || !args.refresh) return null;
  const refreshed = await args.refresh(credential);
  store.write(args.provider, refreshed);
  return refreshed.accessToken;
}
