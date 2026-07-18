export type SkillReferenceChoice = {
  dbKey: string;
  title: string;
  type: "instruction";
};

export type SkillFollowupChoice = {
  id: "save_only" | "use_existing_agent" | "create_agent";
  label: string;
  userMessage: string;
};

type SkillFollowupInput = {
  dbKey: string;
  title: string;
  skillId?: string;
  spaceId?: string | null;
  toolNames?: string[];
  hasEvalConfig?: boolean;
  importedFrom?: string | null;
};

export const buildSkillReferenceChoice = (
  dbKey: string,
  title: string
): SkillReferenceChoice => ({
  dbKey,
  title,
  type: "instruction",
});

export const buildSkillFollowupChoices = (
  reference: SkillReferenceChoice
): SkillFollowupChoice[] => [
  {
    id: "save_only",
    label: "仅保存",
    userMessage: `先只保存这个 skill 文档，不挂到任何 agent。skill dbKey 是 ${reference.dbKey}。`,
  },
  {
    id: "use_existing_agent",
    label: "挂到现有 Agent",
    userMessage: `请把这个 skill 挂到我现有的 agent 上。skill dbKey 是 ${reference.dbKey}。`,
  },
  {
    id: "create_agent",
    label: "新建一个 Agent 来使用它",
    userMessage: `请基于这个 skill 新建一个 agent 来使用它。skill dbKey 是 ${reference.dbKey}。`,
  },
];

export const buildSkillFollowupResult = (input: SkillFollowupInput) => {
  const reference = buildSkillReferenceChoice(input.dbKey, input.title);
  const nextActions = buildSkillFollowupChoices(reference);
  const lines = [
    `Skill《${input.title}》已保存为本地文档。`,
    `- dbKey: ${input.dbKey}`,
    input.spaceId ? `- spaceId: ${input.spaceId}` : null,
    input.skillId ? `- skillId: ${input.skillId}` : null,
    input.importedFrom ? `- importedFrom: ${input.importedFrom}` : null,
    Array.isArray(input.toolNames) && input.toolNames.length > 0
      ? `- tools: ${input.toolNames.join(", ")}`
      : null,
    typeof input.hasEvalConfig === "boolean"
      ? `- hasEvalConfig: ${input.hasEvalConfig ? "yes" : "no"}`
      : null,
    "下一步请优先询问用户：仅保存、挂到现有 Agent，还是新建一个 Agent 来使用它。",
  ].filter(Boolean);

  return {
    rawData: {
      success: true,
      id: input.dbKey,
      dbKey: input.dbKey,
      title: input.title,
      skillId: input.skillId ?? null,
      spaceId: input.spaceId ?? null,
      toolNames: input.toolNames ?? [],
      hasEvalConfig: input.hasEvalConfig ?? false,
      importedFrom: input.importedFrom ?? null,
      reference,
      nextActions,
    },
    displayData: lines.join("\n"),
  };
};
