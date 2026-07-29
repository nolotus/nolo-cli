import type { PublicImageAgentMode } from "../../../app/types";

export type { PublicImageAgentMode };

export const getPublicImageAgentMode = (
  agent?: Partial<{
    imageWorkflow: PublicImageAgentMode;
    provider: string;
    model: string;
    imageConfig: { enabled?: boolean } | null;
  }>
): PublicImageAgentMode | null => {
  if (!agent) return null;
  if (agent.imageWorkflow) return agent.imageWorkflow;
  return null;
};

export const getPublicImageAgentDefaultProfile = (mode: PublicImageAgentMode) => {
  if (mode === "generate") {
    return { quality: "medium", size: "1024x1024", outputFormat: "png" } as const;
  }
  if (mode === "edit") {
    return { quality: "medium", size: "auto", outputFormat: "png" } as const;
  }
  return { quality: "low", size: "auto", outputFormat: "png" } as const;
};
