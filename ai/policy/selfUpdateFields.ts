export const AGENT_UPDATE_FIELD_NAMES = [
  "name",
  "model",
  "provider",
  "prompt",
  "introduction",
  "greeting",
  "isPublic",
  "tags",
  "tools",
  "references",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "max_tokens",
  "reasoning_effort",
] as const;

export type AgentUpdateField = (typeof AGENT_UPDATE_FIELD_NAMES)[number];

export const DEFAULT_AUTO_APPROVED_SELF_UPDATE_FIELDS: AgentUpdateField[] = [
  "greeting",
  "introduction",
  "tags",
];

const VALID_AGENT_UPDATE_FIELDS = new Set<string>(AGENT_UPDATE_FIELD_NAMES);

export const normalizeAgentUpdateFieldList = (
  value: unknown,
  fallback: readonly AgentUpdateField[] = DEFAULT_AUTO_APPROVED_SELF_UPDATE_FIELDS,
): AgentUpdateField[] => {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = Array.from(
    new Set(
      value.filter(
        (item): item is AgentUpdateField =>
          typeof item === "string" && VALID_AGENT_UPDATE_FIELDS.has(item),
      ),
    ),
  );

  return normalized;
};
