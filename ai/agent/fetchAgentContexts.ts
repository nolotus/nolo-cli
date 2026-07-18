import { fetchReferenceContents } from "../context/buildReferenceContext";
import { resolveReferenceAssets } from "../agent/referenceUtils";
import type { ReferenceItem } from "../../app/types";

export interface AgentContexts {
  botInstructionsContext: string;
  botKnowledgeContext: string;
}

/** 根据 agentConfig.references 拉取 instruction / knowledge */
export async function fetchAgentContexts(
  references: ReferenceItem[] | undefined,
  dispatch: any
): Promise<AgentContexts> {
  if (!Array.isArray(references)) {
    return { botInstructionsContext: "", botKnowledgeContext: "" };
  }

  const { references: normalizedRefs, contentByKey } =
    await resolveReferenceAssets(references, dispatch);

  const instructionKeys = new Set<string>();
  const knowledgeKeys = new Set<string>();
  normalizedRefs.forEach((ref) => {
    if (!ref.dbKey) return;
    ref.type === "instruction"
      ? instructionKeys.add(ref.dbKey)
      : knowledgeKeys.add(ref.dbKey);
  });
  const [instructionsMap, knowledgeMap] = await Promise.all([
    fetchReferenceContents(Array.from(instructionKeys), dispatch, {
      preloaded: contentByKey,
    }),
    fetchReferenceContents(Array.from(knowledgeKeys), dispatch, {
      preloaded: contentByKey,
    }),
  ]);
  return {
    botInstructionsContext: Array.from(instructionsMap.values()).join(""),
    botKnowledgeContext: Array.from(knowledgeMap.values()).join(""),
  };
}
