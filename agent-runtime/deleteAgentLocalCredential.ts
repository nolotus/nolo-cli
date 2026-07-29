/**
 * Lifecycle cleanup for per-Agent local API key credentials (credentialRef).
 *
 * Security / semantics:
 * - Only `credentialRef` (file/Keychain/host broker). Never OAuth `apiKeyRef` sessions.
 * - Call only after authoritative Agent record/tombstone delete succeeds.
 * - Never resurrect DB on broker failure; errors must not include ref or secret.
 * - Public catalog projections (`agent-pub-*` / `agent-pub-*`) must not delete the
 *   shared private agent's key.
 */

import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedString } from "../core/trimmedString";
import {
  createFileCredentialBroker,
  type CreateFileCredentialBrokerOptions,
} from "./fileCredentialBroker";
import type { CredentialBroker } from "./credentialBroker";

export const AGENT_LOCAL_CREDENTIAL_DELETE_FAILED_MESSAGE =
  "Agent was deleted, but local API key cleanup failed. You may remove the leftover credential manually if needed.";

type BrokerFactory = (
  options?: CreateFileCredentialBrokerOptions,
) => CredentialBroker;

let createAgentLocalCredentialBroker: BrokerFactory = createFileCredentialBroker;

/**
 * Test-only override for the credential broker factory used on agent delete cleanup.
 */
export function setAgentLocalCredentialBrokerFactoryForTests(
  factory: BrokerFactory | null,
): void {
  createAgentLocalCredentialBroker = factory ?? createFileCredentialBroker;
}

/** Public market projections share the private agent's credentialRef — never clear them. */
export function isPublicAgentProjectionKey(dbKey: string): boolean {
  const key = asTrimmedString(dbKey);
  return key.startsWith("agent-pub-");
}

/**
 * Read broker credential ref from an Agent record.
 * Never returns OAuth apiKeyRef; never reads or returns secrets.
 */
export function extractAgentLocalCredentialRef(record: unknown): string | null {
  if (!record || typeof record !== "object") return null;
  const value = (record as { credentialRef?: unknown }).credentialRef;
  return asOptionalTrimmedString(value) ?? null;
}

export type DeleteAgentLocalCredentialResult =
  | { deleted: true }
  | { deleted: false; skipped: true }
  | { deleted: false; warning: string };

/**
 * Best-effort broker.delete after authoritative Agent DB delete.
 * Failures are sanitized (no ref/secret) and never throw.
 */
export async function deleteAgentLocalCredentialRef(
  credentialRef: string | null | undefined,
  options?: { brokerFactory?: BrokerFactory },
): Promise<DeleteAgentLocalCredentialResult> {
  const ref = asTrimmedString(credentialRef);
  if (!ref) {
    return { deleted: false, skipped: true };
  }

  try {
    const factory = options?.brokerFactory ?? createAgentLocalCredentialBroker;
    const broker = factory();
    await broker.delete(ref);
    return { deleted: true };
  } catch {
    return {
      deleted: false,
      warning: AGENT_LOCAL_CREDENTIAL_DELETE_FAILED_MESSAGE,
    };
  }
}
