import { buildScopedPagePath } from "../../create/space/contentKeyUtils";

export const buildDialogUrl = (
  dialogKey: string,
  spaceId?: string | null
): string => buildScopedPagePath(dialogKey, spaceId);
