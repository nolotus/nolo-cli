import type { AgentRuntimeAgentConfig } from "./hostAdapter";

type AgentRecord = Record<string, unknown>;

function stringField(record: AgentRecord, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: AgentRecord, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectField(record: AgentRecord, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function appendUniqueStrings(values: string[], next: unknown) {
  if (!Array.isArray(next)) return values;
  const seen = new Set(values);
  for (const value of next) {
    const toolName = typeof value === "string"
      ? value
      : value && typeof value === "object" && typeof (value as any).name === "string"
        ? (value as any).name
        : value && typeof value === "object" && typeof (value as any).function?.name === "string"
          ? (value as any).function.name
          : "";
    if (toolName && !seen.has(toolName)) {
      seen.add(toolName);
      values.push(toolName);
    }
  }
  return values;
}

function resolveAgentRuntimeToolNames(record: AgentRecord) {
  const tools = appendUniqueStrings(
    appendUniqueStrings([], record.toolNames),
    record.tools,
  );
  return tools.length > 0 ? tools : undefined;
}

export function resolveAgentRuntimeConfigFromRecord(
  key: string,
  record: AgentRecord,
): AgentRuntimeAgentConfig {
  const name = stringField(record, "name");
  const prompt = stringField(record, "prompt");
  const model = stringField(record, "model");
  const apiSource = stringField(record, "apiSource");
  const cliProvider = stringField(record, "cliProvider");
  const customProviderUrl = stringField(record, "customProviderUrl");
  const apiKey = stringField(record, "apiKey");
  const apiKeyHeader = stringField(record, "apiKeyHeader");
  const apiKeyFromAgentKey = stringField(record, "apiKeyFromAgentKey");
  const useServerProxy = record.useServerProxy === true;
  const provider = stringField(record, "provider") ?? stringField(record, "apiSource");
  const toolNames = resolveAgentRuntimeToolNames(record);
  const temperature = numberField(record, "temperature");
  const topP = numberField(record, "top_p");
  const frequencyPenalty = numberField(record, "frequency_penalty");
  const presencePenalty = numberField(record, "presence_penalty");
  const maxTokens = numberField(record, "max_tokens");
  const reasoningEffort =
    stringField(record, "reasoning_effort") || stringField(record, "reasoningEffort");
  const runtimeBinding = objectField(record, "runtimeBinding");
  const runtimeToolPolicy =
    objectField(record, "runtimeToolPolicy") ??
    objectField(runtimeBinding ?? {}, "runtimeToolPolicy");
  const delegation = objectField(record, "delegation");
  return {
    key,
    ...(name ? { name } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(apiSource ? { apiSource } : {}),
    ...(cliProvider ? { cliProvider } : {}),
    ...(customProviderUrl ? { customProviderUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyHeader ? { apiKeyHeader } : {}),
    ...(apiKeyFromAgentKey ? { apiKeyFromAgentKey } : {}),
    ...(useServerProxy ? { useServerProxy } : {}),
    ...(toolNames ? { toolNames } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { top_p: topP } : {}),
    ...(frequencyPenalty !== undefined ? { frequency_penalty: frequencyPenalty } : {}),
    ...(presencePenalty !== undefined ? { presence_penalty: presencePenalty } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(runtimeBinding ? { runtimeBinding } : {}),
    ...(runtimeToolPolicy ? { runtimeToolPolicy } : {}),
    ...(delegation ? { delegation } : {}),
    rawRecord: record,
  };
}
