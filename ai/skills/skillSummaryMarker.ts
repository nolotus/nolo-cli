import type { PageSkillMetadata } from "./skillDocProtocol";
import type { SpaceContent } from "../../app/types";

export type SkillSummaryMarker = NonNullable<SpaceContent["skillSummary"]>;

export const buildSkillSummaryMarker = (
  meta?: PageSkillMetadata | null
): SkillSummaryMarker | null => {
  const skillConfig = meta?.skillConfig;
  if (meta?.kind !== "skill" && !skillConfig) {
    return null;
  }

  return {
    isSkill: true,
    ...(skillConfig?.id ? { skillId: skillConfig.id } : {}),
    ...(skillConfig?.name ? { name: skillConfig.name } : {}),
    ...(skillConfig?.description ? { description: skillConfig.description } : {}),
    ...(skillConfig?.toolNames?.length ? { toolNames: skillConfig.toolNames } : {}),
    ...(skillConfig?.triggerMode ? { triggerMode: skillConfig.triggerMode } : {}),
  };
};

export const isSkillSummaryMarker = (
  value: SpaceContent["skillSummary"] | undefined | null
): value is SkillSummaryMarker => Boolean(value?.isSkill);
