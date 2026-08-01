/**
 * Request-scoped authoritative snapshots for desktop agent-runtime turns.
 *
 * Logged-out local Agents live in the webview IndexedDB (owner=local) and are
 * not mirrored into the host LevelDB. The client therefore sends an allowlisted
 * agent-config snapshot (and optionally dialog history) for the current turn.
 * Snapshots never carry raw apiKey / token / secret material; host credentials
 * resolve via credentialRef + the host file broker only.
 */

import { isRecord } from "../core/isRecord";
import { asOptionalFiniteNumber } from "../core/optionalNumber";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedString } from "../core/trimmedString";
import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import type { AgentRuntimeChatMessage, AgentRuntimeMessageContent } from "./types";
import { resolveAgentRuntimeConfigFromRecord } from "./agentRecordConfig";

/** Allowlisted string fields copied into agent-config snapshots. */
export const DESKTOP_AGENT_CONFIG_SNAPSHOT_STRING_FIELDS = [
  "name",
  "prompt",
  "provider",
  "model",
  "apiSource",
  "cliProvider",
  "customProviderUrl",
  "credentialRef",
  "apiKeyRef",
  "apiKeyHeader",
  "reasoning_effort",
  "reasoningEffort",
] as const;

/** Allowlisted numeric inference options. */
export const DESKTOP_AGENT_CONFIG_SNAPSHOT_NUMBER_FIELDS = [
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "max_tokens",
] as const;

/** Object fields that may carry runtime policy/binding (deep-sanitized). */
export const DESKTOP_AGENT_CONFIG_SNAPSHOT_OBJECT_FIELDS = [
  "runtimeBinding",
  "runtimeToolPolicy",
  "delegation",
] as const;

/**
 * Field names that must never appear in a request snapshot body.
 * Applied as a denylist even if a future allowlist addition is mistaken.
 */
export const DESKTOP_AGENT_CONFIG_SNAPSHOT_FORBIDDEN_KEYS = [
  "apiKey",
  "apiKeyFromAgentKey",
  "token",
  "secret",
  "password",
  "accessToken",
  "refreshToken",
  "authorization",
  "authToken",
  "AUTH_TOKEN",
  "AUTH",
  "clientSecret",
  "privateKey",
  "bearer",
] as const;

/**
 * Conservative bound for tool_calls[].function.arguments on the wire.
 * Oversized args are truncated after secret-name redaction when JSON.
 */
export const DESKTOP_TOOL_CALL_ARGUMENTS_MAX_CHARS = 8_192;

const REDACTED_SECRET_PLACEHOLDER = "[redacted]";

const FORBIDDEN_KEY_SET = new Set<string>(
  DESKTOP_AGENT_CONFIG_SNAPSHOT_FORBIDDEN_KEYS.map((k) => k.toLowerCase()),
);

export type DesktopAgentRuntimeAgentConfigSnapshot = {
  /** Must match the turn `agentRef`. */
  dbKey: string;
  name?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  apiSource?: string;
  cliProvider?: string;
  customProviderUrl?: string;
  credentialRef?: string;
  apiKeyRef?: string;
  apiKeyHeader?: string;
  useServerProxy?: boolean;
  tools?: string[];
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  runtimeBinding?: Record<string, unknown>;
  runtimeToolPolicy?: Record<string, unknown>;
  delegation?: Record<string, unknown>;
};

export type DesktopAgentRuntimeDialogHistorySnapshot = {
  dialogId: string;
  messages: AgentRuntimeChatMessage[];
};

export type ParseDesktopAgentConfigSnapshotResult =
  | { ok: true; snapshot: DesktopAgentRuntimeAgentConfigSnapshot }
  | { ok: false; error: string };

export type ParseDesktopDialogHistorySnapshotResult =
  | { ok: true; snapshot: DesktopAgentRuntimeDialogHistorySnapshot }
  | { ok: false; error: string };

function isForbiddenKey(key: string) {
  return FORBIDDEN_KEY_SET.has(key.toLowerCase());
}

/**
 * True when a property name is secret-bearing under the snapshot sensitivity contract.
 * Used for nested JSON tool-argument redaction (not free-text regex mutation).
 */
export function isDesktopSnapshotSensitivePropertyName(key: string): boolean {
  return isForbiddenKey(key);
}

/**
 * Recursively redact values of secret-like property names in a plain JSON tree.
 * Does not mutate non-object prose; only walks objects/arrays.
 */
export function redactSensitiveJsonTree(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveJsonTree(item, depth + 1));
  }
  if (typeof value !== "object") return null;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isDesktopSnapshotSensitivePropertyName(key)) {
      out[key] = REDACTED_SECRET_PLACEHOLDER;
      continue;
    }
    out[key] = redactSensitiveJsonTree(child, depth + 1);
  }
  return out;
}

/**
 * Bound + optionally redact tool call arguments for history snapshots.
 * - Valid JSON object/array: recursive secret-name redaction, then size bound.
 * - Malformed / non-JSON / non-object root: size-bound only (no regex mutation of prose).
 */
export function sanitizeToolCallArguments(
  raw: unknown,
  maxChars = DESKTOP_TOOL_CALL_ARGUMENTS_MAX_CHARS,
): string {
  const source = typeof raw === "string" ? raw : raw == null ? "{}" : String(raw);
  let candidate = source;

  try {
    const parsed = JSON.parse(source) as unknown;
    if (parsed && (typeof parsed === "object")) {
      candidate = JSON.stringify(redactSensitiveJsonTree(parsed));
    }
  } catch {
    // Non-JSON: keep original text; only enforce the size bound below.
  }

  if (candidate.length <= maxChars) return candidate;
  return candidate.slice(0, maxChars);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return asOptionalTrimmedString(record[key]);
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return asOptionalFiniteNumber(record[key]);
}

function uniqueToolNames(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name =
      asTrimmedString(value) ||
      asTrimmedString((value as { name?: unknown } | null)?.name) ||
      asTrimmedString(
        (value as { function?: { name?: unknown } } | null)?.function?.name,
      );
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.length > 0 ? names : undefined;
}

/**
 * Deep-copy plain objects while dropping forbidden secret keys and non-JSON values.
 * Caps depth to avoid accidental large/blob payloads.
 */
function sanitizePlainObject(
  value: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (depth > 4) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenKey(key)) continue;
    if (child === null) {
      out[key] = null;
      continue;
    }
    if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
      out[key] = child;
      continue;
    }
    if (Array.isArray(child)) {
      const items = child
        .map((item) => {
          if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
            return item;
          }
          if (isRecord(item)) {
            return sanitizePlainObject(item, depth + 1);
          }
          return undefined;
        })
        .filter((item) => item !== undefined);
      out[key] = items;
      continue;
    }
    if (typeof child === "object") {
      const nested = sanitizePlainObject(child, depth + 1);
      if (nested) out[key] = nested;
    }
  }
  return out;
}

function pickAllowlistedAgentConfigFields(
  source: Record<string, unknown>,
  dbKey: string,
): DesktopAgentRuntimeAgentConfigSnapshot {
  const snapshot: DesktopAgentRuntimeAgentConfigSnapshot = { dbKey };

  for (const key of DESKTOP_AGENT_CONFIG_SNAPSHOT_STRING_FIELDS) {
    if (key === "reasoningEffort") continue; // folded into reasoning_effort
    const value = stringField(source, key);
    if (value !== undefined) {
      (snapshot as Record<string, unknown>)[key] = value;
    }
  }

  const reasoningEffort =
    stringField(source, "reasoning_effort") || stringField(source, "reasoningEffort");
  if (reasoningEffort) snapshot.reasoning_effort = reasoningEffort;

  for (const key of DESKTOP_AGENT_CONFIG_SNAPSHOT_NUMBER_FIELDS) {
    const value = numberField(source, key);
    if (value !== undefined) {
      (snapshot as Record<string, unknown>)[key] = value;
    }
  }

  if (source.useServerProxy === true) {
    snapshot.useServerProxy = true;
  } else if (source.useServerProxy === false) {
    snapshot.useServerProxy = false;
  }

  const tools =
    uniqueToolNames(source.tools) ??
    uniqueToolNames(source.toolNames);
  if (tools) snapshot.tools = tools;

  for (const key of DESKTOP_AGENT_CONFIG_SNAPSHOT_OBJECT_FIELDS) {
    const value = sanitizePlainObject(source[key]);
    if (value) {
      (snapshot as Record<string, unknown>)[key] = value;
    }
  }

  return snapshot;
}

/**
 * Client builder: produce an allowlisted agent-config snapshot from a webview Agent record.
 * Never copies raw apiKey / tokens / secrets.
 */
export function buildDesktopAgentRuntimeAgentConfigSnapshot(
  source: unknown,
  agentRef: string,
): DesktopAgentRuntimeAgentConfigSnapshot | null {
  if (!isRecord(source)) return null;
  const ref = asTrimmedString(agentRef);
  if (!ref) return null;

  // Prefer explicit dbKey/key; fall back to agentRef so short `id` fields never
  // reject a valid client record that uses a different id shape.
  const claimed =
    stringField(source, "dbKey") ||
    stringField(source, "key");
  if (claimed && claimed !== ref) return null;
  const dbKey = claimed || ref;

  return pickAllowlistedAgentConfigFields(source, dbKey);
}

/**
 * Server/parser: validate and re-sanitize an inbound agentConfigSnapshot.
 * Rejects ref mismatch and non-objects. Always re-applies the allowlist.
 */
export function parseDesktopAgentRuntimeAgentConfigSnapshot(
  value: unknown,
  agentRef: string,
): ParseDesktopAgentConfigSnapshotResult {
  const ref = asTrimmedString(agentRef);
  if (!ref) {
    return { ok: false, error: "agentRef is required for agentConfigSnapshot" };
  }
  if (value === undefined || value === null) {
    return { ok: false, error: "agentConfigSnapshot is required when provided" };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "agentConfigSnapshot must be an object" };
  }

  const record = value;
  const dbKey =
    stringField(record, "dbKey") ||
    stringField(record, "key") ||
    "";
  if (!dbKey) {
    return { ok: false, error: "agentConfigSnapshot.dbKey is required" };
  }
  if (dbKey !== ref) {
    return {
      ok: false,
      error: `agentConfigSnapshot.dbKey must match agentRef (got ${dbKey}, expected ${ref})`,
    };
  }

  // Re-pick allowlist only — never trust extra keys from the wire.
  const snapshot = pickAllowlistedAgentConfigFields(record, dbKey);

  // Defense in depth: ensure no forbidden key survived.
  for (const key of Object.keys(snapshot)) {
    if (isForbiddenKey(key)) {
      return { ok: false, error: `agentConfigSnapshot contains forbidden field: ${key}` };
    }
  }
  if ("apiKey" in record || "apiKey" in snapshot) {
    // Explicit strip: pickAllowlisted never copies apiKey; reject if caller forced it somehow.
    // (pickAllowlisted already omits it; this is documentation of the contract.)
  }

  return { ok: true, snapshot };
}

/**
 * Convert a validated snapshot into AgentRuntimeAgentConfig for the local loop.
 */
export function agentRuntimeConfigFromDesktopSnapshot(
  snapshot: DesktopAgentRuntimeAgentConfigSnapshot,
): AgentRuntimeAgentConfig {
  const record: Record<string, unknown> = {
    dbKey: snapshot.dbKey,
    ...(snapshot.name ? { name: snapshot.name } : {}),
    ...(snapshot.prompt ? { prompt: snapshot.prompt } : {}),
    ...(snapshot.provider ? { provider: snapshot.provider } : {}),
    ...(snapshot.model ? { model: snapshot.model } : {}),
    ...(snapshot.apiSource ? { apiSource: snapshot.apiSource } : {}),
    ...(snapshot.cliProvider ? { cliProvider: snapshot.cliProvider } : {}),
    ...(snapshot.customProviderUrl ? { customProviderUrl: snapshot.customProviderUrl } : {}),
    ...(snapshot.credentialRef ? { credentialRef: snapshot.credentialRef } : {}),
    ...(snapshot.apiKeyRef ? { apiKeyRef: snapshot.apiKeyRef } : {}),
    ...(snapshot.apiKeyHeader ? { apiKeyHeader: snapshot.apiKeyHeader } : {}),
    ...(snapshot.useServerProxy === true ? { useServerProxy: true } : {}),
    ...(snapshot.useServerProxy === false ? { useServerProxy: false } : {}),
    ...(snapshot.tools ? { tools: snapshot.tools, toolNames: snapshot.tools } : {}),
    ...(snapshot.temperature !== undefined ? { temperature: snapshot.temperature } : {}),
    ...(snapshot.top_p !== undefined ? { top_p: snapshot.top_p } : {}),
    ...(snapshot.frequency_penalty !== undefined
      ? { frequency_penalty: snapshot.frequency_penalty }
      : {}),
    ...(snapshot.presence_penalty !== undefined
      ? { presence_penalty: snapshot.presence_penalty }
      : {}),
    ...(snapshot.max_tokens !== undefined ? { max_tokens: snapshot.max_tokens } : {}),
    ...(snapshot.reasoning_effort ? { reasoning_effort: snapshot.reasoning_effort } : {}),
    ...(snapshot.runtimeBinding ? { runtimeBinding: snapshot.runtimeBinding } : {}),
    ...(snapshot.runtimeToolPolicy ? { runtimeToolPolicy: snapshot.runtimeToolPolicy } : {}),
    ...(snapshot.delegation ? { delegation: snapshot.delegation } : {}),
  };

  return resolveAgentRuntimeConfigFromRecord(snapshot.dbKey, record);
}

function sanitizeMessageContent(content: unknown): AgentRuntimeMessageContent {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts: Array<{ type: "text"; text: string }> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    // Only text parts — never image/blob/data-url payloads.
    if (record.type === "text" && typeof record.text === "string") {
      parts.push({ type: "text", text: record.text });
    }
  }
  return parts.length > 0 ? parts : null;
}

function sanitizeToolCalls(value: unknown): AgentRuntimeChatMessage["tool_calls"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: NonNullable<AgentRuntimeChatMessage["tool_calls"]> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = asTrimmedString(record.id);
    const fn = record.function && typeof record.function === "object"
      ? (record.function as Record<string, unknown>)
      : null;
    const name = asTrimmedString(fn?.name);
    const rawArgs = typeof fn?.arguments === "string" ? fn.arguments : "{}";
    if (!id || !name) continue;
    calls.push({
      id,
      type: "function",
      function: { name, arguments: sanitizeToolCallArguments(rawArgs) },
    });
  }
  return calls.length > 0 ? calls : undefined;
}

function sanitizeChatMessage(value: unknown): AgentRuntimeChatMessage | null {
  if (!isRecord(value)) return null;
  const role = value.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    return null;
  }
  const content = sanitizeMessageContent(value.content);
  const message: AgentRuntimeChatMessage = {
    role,
    content,
  };
  const toolCallId =
    asOptionalTrimmedString(value.tool_call_id) ??
    asOptionalTrimmedString(value.toolCallId);
  if (toolCallId) message.tool_call_id = toolCallId;
  const toolCalls = sanitizeToolCalls(value.tool_calls);
  if (toolCalls) message.tool_calls = toolCalls;
  if (typeof value.reasoning_content === "string" && value.reasoning_content) {
    message.reasoning_content = value.reasoning_content;
  }
  return message;
}

/**
 * Client builder for dialog history. Drops the trailing user message when it
 * matches `currentInput` so localLoop does not double-append the same turn.
 * Strips attachment blobs / image parts.
 */
export function buildDesktopAgentRuntimeDialogHistorySnapshot(args: {
  dialogId: string;
  messages: unknown[];
  currentInput?: AgentRuntimeMessageContent;
}): DesktopAgentRuntimeDialogHistorySnapshot | null {
  const dialogId = asTrimmedString(args.dialogId);
  if (!dialogId) return null;
  if (!Array.isArray(args.messages)) return null;

  let messages = args.messages
    .map((item) => sanitizeChatMessage(item))
    .filter((item): item is AgentRuntimeChatMessage => item !== null);

  // Exclude streaming placeholders
  messages = messages.filter((msg) => {
    const raw = msg as AgentRuntimeChatMessage & { isStreaming?: boolean };
    return raw.isStreaming !== true;
  });

  const inputText = normalizeContentToText(args.currentInput);
  if (inputText && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === "user" && normalizeContentToText(last.content) === inputText) {
      messages = messages.slice(0, -1);
    }
  }

  return { dialogId, messages };
}

function normalizeContentToText(content: AgentRuntimeMessageContent | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (part?.type === "text" && part.text ? [part.text] : []))
    .join("\n")
    .trim();
}

export function parseDesktopAgentRuntimeDialogHistorySnapshot(
  value: unknown,
  continueDialogId?: string,
): ParseDesktopDialogHistorySnapshotResult {
  if (value === undefined || value === null) {
    return { ok: false, error: "dialogHistorySnapshot is required when provided" };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "dialogHistorySnapshot must be an object" };
  }
  const record = value;
  const dialogId =
    stringField(record, "dialogId") ||
    asTrimmedString(continueDialogId);
  if (!dialogId) {
    return { ok: false, error: "dialogHistorySnapshot.dialogId is required" };
  }
  if (
    typeof continueDialogId === "string" &&
    continueDialogId.trim() &&
    dialogId !== continueDialogId.trim()
  ) {
    return {
      ok: false,
      error: `dialogHistorySnapshot.dialogId must match continueDialogId (got ${dialogId})`,
    };
  }
  if (!Array.isArray(record.messages)) {
    return { ok: false, error: "dialogHistorySnapshot.messages must be an array" };
  }

  const messages = record.messages
    .map((item) => sanitizeChatMessage(item))
    .filter((item): item is AgentRuntimeChatMessage => item !== null);

  return {
    ok: true,
    snapshot: { dialogId, messages },
  };
}

/**
 * Assert a built body object never contains raw secrets (for tests + runtime checks).
 */
export function assertDesktopAgentRuntimeTurnBodyHasNoRawSecrets(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const json = JSON.stringify(body);
  // Cheap structural check on known secret field names at the top levels.
  const walk = (value: unknown, path: string) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenKey(key)) {
        throw new Error(`Forbidden secret field in request body at ${path}.${key}`);
      }
      walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(body, "");
  void json;
}
