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
};

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
  options?: { brokerFactory?: BrokerFactory },
): Promise<string | undefined> {
  const rawKey = readNonEmpty(agentConfig.apiKey);
  if (rawKey) return rawKey;

  const credentialRef = readNonEmpty(agentConfig.credentialRef);
  if (!credentialRef) return undefined;

  try {
    const factory = options?.brokerFactory ?? createDirectCredentialBroker;
    const broker = factory();
    const secret = await broker.get(credentialRef);
    const trimmed = asTrimmedString(secret);
    if (!trimmed) {
      throw new DirectApiKeyResolutionError();
    }
    return trimmed;
  } catch (error) {
    if (error instanceof DirectApiKeyResolutionError) throw error;
    // Drop broker/assert messages that may embed the ref; never surface secrets.
    throw new DirectApiKeyResolutionError();
  }
}
