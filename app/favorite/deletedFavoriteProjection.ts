import {
  isAgentKey,
  isFileKey,
  isPageKey,
  isTableMetaKey,
} from "../../database/keys";

type DeletedFavoriteProjectionRemoval = {
  targetType: "agent" | "content";
  id: string;
};

export const resolveDeletedFavoriteProjectionRemoval = (
  contentKey: string
): DeletedFavoriteProjectionRemoval | null => {
  if (!contentKey) return null;

  if (isAgentKey(contentKey)) {
    return { targetType: "agent", id: contentKey };
  }

  if (
    isPageKey(contentKey) ||
    isTableMetaKey(contentKey) ||
    isFileKey(contentKey)
  ) {
    return { targetType: "content", id: contentKey };
  }

  return null;
};
