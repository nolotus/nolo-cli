// Per-dialog composer image drafts (File + preview URL). Survives leave/re-enter
// of a dialog while the page stays mounted in the SPA; cleared on send / auth reset.

export interface ComposerImageDraftItem {
  id: string;
  file: File;
  previewUrl: string;
}

interface ComposerImageDraft {
  items: ComposerImageDraftItem[];
}

const draftsByDialogKey: Record<string, ComposerImageDraft> = {};

export function getComposerImageDraft(
  dialogKey: string | null | undefined
): ComposerImageDraftItem[] {
  if (!dialogKey) return [];
  const draft = draftsByDialogKey[dialogKey];
  return draft ? draft.items.map((item) => ({ ...item })) : [];
}

export function setComposerImageDraft(
  dialogKey: string | null | undefined,
  items: ComposerImageDraftItem[]
): void {
  if (!dialogKey) return;
  if (items.length === 0) {
    delete draftsByDialogKey[dialogKey];
    return;
  }
  draftsByDialogKey[dialogKey] = {
    items: items.map((item) => ({ ...item })),
  };
}

export function clearComposerImageDraft(
  dialogKey: string | null | undefined
): void {
  if (!dialogKey) return;
  const existing = draftsByDialogKey[dialogKey];
  if (existing) {
    for (const item of existing.items) {
      if (
        item.previewUrl.startsWith("blob:") &&
        typeof URL !== "undefined" &&
        typeof URL.revokeObjectURL === "function"
      ) {
        URL.revokeObjectURL(item.previewUrl);
      }
    }
  }
  delete draftsByDialogKey[dialogKey];
}

export function clearAllComposerImageDrafts(): void {
  for (const key of Object.keys(draftsByDialogKey)) {
    clearComposerImageDraft(key);
  }
}

export function resetComposerImageDraftStoreForTests(): void {
  for (const key of Object.keys(draftsByDialogKey)) {
    delete draftsByDialogKey[key];
  }
}
