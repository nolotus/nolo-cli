import { asTrimmedString } from "../core/trimmedString";
import type { CredentialBroker, CredentialRef } from "./credentialBroker";

/**
 * Two-phase, crash-resumable migration of raw agent `apiKey` into the local broker.
 *
 * Phase 1 — put secret + mark `credentialMigration: "pending"` (record still may hold apiKey).
 * Phase 2 — strip `apiKey` only after put is verified via `has(ref)`; mark `"done"`.
 *
 * Resume rules:
 * - raw apiKey present → (re)put then strip when has(ref)
 * - pending + no raw + has(ref) → mark done
 * - done + no raw → noop
 * - pending + no raw + !has(ref) → leave pending (manual repair / re-entry needed)
 */

export type CredentialMigrationStatus = "pending" | "done";

export type AgentSecretFields = {
  key: string;
  apiKey?: string | null;
  apiKeyRef?: string | null;
  credentialRef?: string | null;
  credentialMigration?: CredentialMigrationStatus | string | null;
};

/** Patch to merge onto the agent record. `null` means delete the field. */
export type AgentSecretMigrationUpdates = {
  apiKey?: string | null;
  apiKeyRef?: string;
  credentialRef?: string;
  credentialMigration?: CredentialMigrationStatus;
};

export type AgentSecretMigrationResult = {
  updates: AgentSecretMigrationUpdates;
  status: "noop" | "migrated" | "resumed-pending" | "already-done" | "awaiting-secret";
  credentialRef?: string;
  phase: "none" | "put" | "strip" | "complete";
};

export function buildAgentApiKeyCredentialRef(agentKey: string): CredentialRef {
  const key = asTrimmedString(agentKey);
  if (!key) throw new Error("agentKey is required to build a credential ref.");
  return `api-key:${key}`;
}

function readRawApiKey(agent: AgentSecretFields): string {
  return asTrimmedString(agent.apiKey);
}

function resolveTargetRef(agent: AgentSecretFields): CredentialRef {
  const fromCredential = asTrimmedString(agent.credentialRef);
  if (fromCredential) return fromCredential;
  // Do not reuse OAuth-style apiKeyRef (chatgpt/xai/...) as a file-key path for raw apiKey.
  // Only use apiKeyRef when it already looks like a broker key ref.
  const fromApiKeyRef = asTrimmedString(agent.apiKeyRef);
  if (fromApiKeyRef.startsWith("api-key:")) return fromApiKeyRef;
  return buildAgentApiKeyCredentialRef(agent.key);
}

async function brokerHas(broker: CredentialBroker, ref: CredentialRef): Promise<boolean> {
  return Boolean(await broker.has(ref));
}

async function brokerPut(
  broker: CredentialBroker,
  ref: CredentialRef,
  secret: string,
): Promise<void> {
  await broker.put(ref, secret);
}

/**
 * Migrate raw `apiKey` off an agent record into the credential broker.
 * Returns a record patch; caller is responsible for persisting the agent write.
 */
export async function migrateAgentSecrets(args: {
  agent: AgentSecretFields;
  broker: CredentialBroker;
}): Promise<AgentSecretMigrationResult> {
  const { agent, broker } = args;
  const raw = readRawApiKey(agent);
  const migration = asTrimmedString(agent.credentialMigration);

  if (migration === "done" && !raw) {
    const ref =
      (typeof agent.credentialRef === "string" && agent.credentialRef.trim()) ||
      (typeof agent.apiKeyRef === "string" && agent.apiKeyRef.startsWith("api-key:")
        ? agent.apiKeyRef.trim()
        : "") ||
      undefined;
    return {
      updates: {},
      status: "already-done",
      ...(ref ? { credentialRef: ref } : {}),
      phase: "complete",
    };
  }

  if (!raw && migration !== "pending") {
    return { updates: {}, status: "noop", phase: "none" };
  }

  const targetRef = resolveTargetRef(agent);

  // Phase 1: put when raw secret is still on the record.
  if (raw) {
    await brokerPut(broker, targetRef, raw);
    const stored = await brokerHas(broker, targetRef);
    if (!stored) {
      // Put did not stick; keep raw key, mark pending for resume.
      return {
        updates: {
          credentialRef: targetRef,
          credentialMigration: "pending",
        },
        status: "resumed-pending",
        credentialRef: targetRef,
        phase: "put",
      };
    }
    // Phase 2 in same call when put verified: strip raw secret.
    return {
      updates: {
        apiKey: null,
        credentialRef: targetRef,
        // Keep apiKeyRef for resolution if not already an OAuth provider name.
        // Prefer explicit credentialRef; set apiKeyRef only when empty so OAuth agents stay intact.
        ...(!(typeof agent.apiKeyRef === "string" && agent.apiKeyRef.trim())
          ? { apiKeyRef: targetRef }
          : {}),
        credentialMigration: "done",
      },
      status: migration === "pending" ? "resumed-pending" : "migrated",
      credentialRef: targetRef,
      phase: "strip",
    };
  }

  // Resume: pending, raw already stripped (or never re-read), verify broker has secret.
  const stored = await brokerHas(broker, targetRef);
  if (stored) {
    return {
      updates: {
        credentialRef: targetRef,
        credentialMigration: "done",
        ...(!(typeof agent.apiKeyRef === "string" && agent.apiKeyRef.trim())
          ? { apiKeyRef: targetRef }
          : {}),
      },
      status: "resumed-pending",
      credentialRef: targetRef,
      phase: "complete",
    };
  }

  return {
    updates: {
      credentialRef: targetRef,
      credentialMigration: "pending",
    },
    status: "awaiting-secret",
    credentialRef: targetRef,
    phase: "put",
  };
}

/**
 * Apply migration updates onto a plain agent record object (immutable-friendly).
 * `apiKey: null` deletes the field.
 */
export function applyAgentSecretMigrationUpdates<T extends Record<string, unknown>>(
  record: T,
  updates: AgentSecretMigrationUpdates,
): T {
  const next: Record<string, unknown> = { ...record };
  if ("apiKey" in updates) {
    if (updates.apiKey === null || updates.apiKey === "") {
      delete next.apiKey;
    } else if (typeof updates.apiKey === "string") {
      next.apiKey = updates.apiKey;
    }
  }
  if (updates.apiKeyRef !== undefined) next.apiKeyRef = updates.apiKeyRef;
  if (updates.credentialRef !== undefined) next.credentialRef = updates.credentialRef;
  if (updates.credentialMigration !== undefined) {
    next.credentialMigration = updates.credentialMigration;
  }
  return next as T;
}
