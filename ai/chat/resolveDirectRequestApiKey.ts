/**
 * Resolve an API key for client-side *direct* provider requests only.
 *
 * Priority:
 * 1. Transient / legacy raw `agentConfig.apiKey` (compat with unmigrated records)
 * 2. Local credential broker via bare `credentialRef`
 *    - Web Desktop: esbuild rewrites `fileCredentialBroker` → browser stub → host HTTP
 *    - RN Metro: resolves `fileCredentialBroker.native` → Keychain
 *    - Node/Bun: file broker under ~/.nolo/credentials/keys/
 *
 * Security:
 * - Never use this helper to hydrate server-proxy `KEY`, Redux, Agent, Dialog, logs, URLs.
 * - Errors must not include the credential ref or secret.
 */

import { asTrimmedString } from "../../core/trimmedString";
import {
  createFileCredentialBroker,
  type CreateFileCredentialBrokerOptions,
} from "../../agent-runtime/fileCredentialBroker";
import type { CredentialBroker } from "../../agent-runtime/credentialBroker";

export const DIRECT_API_KEY_UNAVAILABLE_MESSAGE =
  "无法加载本地 API 密钥。请在 Agent 设置中重新填写密钥，或确认本机凭据可用。";

export class DirectApiKeyResolutionError extends Error {
  constructor(message = DIRECT_API_KEY_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "DirectApiKeyResolutionError";
  }
}

export type DirectRequestCredentialConfig = {
  apiKey?: string | null;
  credentialRef?: string | null;
  /** When true, fall back to server sync store if local broker misses. */
  credentialSynced?: boolean;
};

/**
 * Injected server-side credential sync fetcher.
 * Returns the plaintext API key from the server store, or null if not found.
 * Caller binds serverUrl + authToken; this module stays transport-agnostic.
 */
export type CredentialSyncFetcher = (credentialRef: string) => Promise<string | null>;

type BrokerFactory = (
  options?: CreateFileCredentialBrokerOptions,
) => CredentialBroker;

let createDirectCredentialBroker: BrokerFactory = createFileCredentialBroker;

/**
 * Test-only override for the credential broker factory used by direct fetch.
 */
export function setDirectRequestCredentialBrokerFactoryForTests(
  factory: BrokerFactory | null,
): void {
  createDirectCredentialBroker = factory ?? createFileCredentialBroker;
}

function readNonEmpty(value: unknown): string {
  return asTrimmedString(value);
}

/**
 * Resolve a secret for a local direct provider call.
 * Returns `undefined` when no key and no credentialRef (anonymous local endpoints).
 * Throws `DirectApiKeyResolutionError` when credentialRef is present but unreadable.
 */
export async function resolveDirectRequestApiKey(
  agentConfig: DirectRequestCredentialConfig,
  options?: {
    brokerFactory?: BrokerFactory;
    /** Server sync fallback; only invoked when credentialSynced is true and broker misses. */
    syncFetcher?: CredentialSyncFetcher;
  },
): Promise<string | undefined> {
  const rawKey = readNonEmpty(agentConfig.apiKey);
  if (rawKey) return rawKey;

  const credentialRef = readNonEmpty(agentConfig.credentialRef);
  if (!credentialRef) return undefined;

 const factory = options?.brokerFactory ?? createDirectCredentialBroker;
  const broker = factory();

  // Priority 1: local broker
  const local = await safeBrokerGet(broker, credentialRef);
  if (local) return local;

  // Priority 2: server sync fallback (only when opted in)
  if (agentConfig.credentialSynced && options?.syncFetcher) {
    const synced = await options.syncFetcher(credentialRef);
    const trimmed = asTrimmedString(synced);
    if (trimmed) {
      // Cache back to local broker so subsequent reads stay local.
      try {
        await broker.put(credentialRef, trimmed);
      } catch {
        // Caching is best-effort; the resolved key is still returned.
      }
      return trimmed;
    }
  }

  // No key anywhere — only throw if a credentialRef was expected to resolve.
  throw new DirectApiKeyResolutionError();
}

async function safeBrokerGet(
  broker: CredentialBroker,
  ref: string,
): Promise<string | null> {
  try {
    return asTrimmedString(await broker.get(ref)) || null;
  } catch {
    return null;
  }
}
