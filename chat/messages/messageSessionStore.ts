// File: chat/messages/messageSessionStore.ts
// Module store for per-dialog message session flash — peeled out of Redux (Wave10).
// Holds loading / error / lastStreamTimestamp / requestIds. messageSlice keeps
// msgs entities + isStreaming on message records.
//
// Sync mutators return a lightweight action object so existing dispatch patterns
// can keep calling them. React UI must use the hooks below (useAppSelector on
// select* wrappers will NOT re-render).

import { useSyncExternalStore } from "react";

export const GLOBAL_MESSAGE_DIALOG_ID = "__global__";

export interface MessageSessionState {
  firstStreamProcessed: boolean;
  isLoadingInitial: boolean;
  isLoadingOlder: boolean;
  hasMoreOlder: boolean;
  error: Error | null;
  lastStreamTimestamp: number;
  currentInitMsgsRequestId?: string;
  currentLoadOlderRequestId?: string;
  // Wave11: index of the dialog's active streaming message id, written in the
  // same spot as `isStreaming` on the Redux record. UI reads this via
  // useHasStreamingMessage (useSyncExternalStore) instead of scanning Redux
  // msgs so streaming tokens don't re-render the whole list / title.
  streamingMessageId: string | null;
  // Wave12: last stream-clear timestamp for this dialog — written in the same
  // reducer pass as clearAllStreaming (user abort or logout all:true system
  // clear; see messageSlice clearAllStreaming). Memory-only, so async message
  // persistence can never overwrite it; lets UI edge-detection tell aborted
  // turns apart from normal completions.
  lastAbortTimestamp: number;
}

const createEmptyMessageSessionState = (): MessageSessionState => ({
  firstStreamProcessed: false,
  isLoadingInitial: false,
  isLoadingOlder: false,
  hasMoreOlder: true,
  error: null,
  lastStreamTimestamp: 0,
  currentInitMsgsRequestId: undefined,
  currentLoadOlderRequestId: undefined,
  streamingMessageId: null,
  lastAbortTimestamp: 0,
});

let activeDialogId: string | null = null;
const sessionByDialogId: Record<string, MessageSessionState> = {
  [GLOBAL_MESSAGE_DIALOG_ID]: createEmptyMessageSessionState(),
};

const listeners = new Set<() => void>();
let version = 0;

const notify = (): void => {
  version += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* subscriber errors must not break mutators */
    }
  }
};

const action = <T,>(type: string, payload?: T) =>
  ({ type, payload }) as { type: string; payload?: T };

export function setActiveMessageDialogId(dialogId: string | null): void {
  activeDialogId = dialogId;
  notify();
}

export function getActiveMessageDialogId(): string | null {
  return activeDialogId;
}

const resolveDialogId = (dialogId?: string | null): string =>
  dialogId ?? activeDialogId ?? GLOBAL_MESSAGE_DIALOG_ID;

export function ensureMessageSession(
  dialogId?: string | null
): MessageSessionState {
  const key = resolveDialogId(dialogId);
  if (!sessionByDialogId[key]) {
    sessionByDialogId[key] = createEmptyMessageSessionState();
  }
  return sessionByDialogId[key];
}

export function getMessageSession(
  dialogId?: string | null
): MessageSessionState {
  return (
    sessionByDialogId[resolveDialogId(dialogId)] ??
    createEmptyMessageSessionState()
  );
}

export function patchMessageSession(
  dialogId: string | null | undefined,
  patch: Partial<MessageSessionState>
) {
  const session = ensureMessageSession(dialogId);
  Object.assign(session, patch);
  notify();
  return action("messageSession/patch", { dialogId, patch });
}

export function resetMessageSession(dialogId?: string | null) {
  const key = resolveDialogId(dialogId);
  sessionByDialogId[key] = createEmptyMessageSessionState();
  notify();
  return action("messageSession/reset", { dialogId: key });
}

export function deleteMessageSession(dialogId: string) {
  delete sessionByDialogId[dialogId];
  if (activeDialogId === dialogId) {
    activeDialogId = null;
  }
  if (!sessionByDialogId[GLOBAL_MESSAGE_DIALOG_ID]) {
    sessionByDialogId[GLOBAL_MESSAGE_DIALOG_ID] =
      createEmptyMessageSessionState();
  }
  notify();
  return action("messageSession/delete", { dialogId });
}

export function resetAllMessageSessions() {
  for (const key of Object.keys(sessionByDialogId)) {
    delete sessionByDialogId[key];
  }
  sessionByDialogId[GLOBAL_MESSAGE_DIALOG_ID] =
    createEmptyMessageSessionState();
  activeDialogId = null;
  notify();
  return action("messageSession/resetAll");
}

export function markMessageStreamActivity(dialogId?: string | null) {
  const session = ensureMessageSession(dialogId);
  session.firstStreamProcessed = true;
  session.lastStreamTimestamp = Date.now();
  notify();
  return action("messageSession/streamActivity", { dialogId });
}

// Wave12 — written in the same reducer pass as clearAllStreaming (also hit by
// logout all:true system clear) so the streaming→completed edge detector can
// tell "aborted turn" apart from a normal completion. Memory-only (unlike
// message metadata, which async persist may overwrite).
export function markMessageSessionAbort(dialogId?: string | null) {
  const session = ensureMessageSession(dialogId);
  session.lastAbortTimestamp = Date.now();
  notify();
  return action("messageSession/abort", { dialogId });
}

// ===== Wave11: streaming-message id index =====
// Written in the same spot as `isStreaming` on the Redux record (see
// messageSlice reducers), so the store is the single source of truth for
// "is anything streaming in this dialog" without scanning Redux msgs.

export function setStreamingMessageId(
  dialogId: string | null | undefined,
  messageId: string | null
): void {
  const session = ensureMessageSession(dialogId);
  if (session.streamingMessageId === messageId) return;
  session.streamingMessageId = messageId;
  notify();
}

export function getStreamingMessageId(
  dialogId?: string | null
): string | null {
  if (dialogId === null) return null;
  return getMessageSession(dialogId).streamingMessageId;
}

export function getHasStreamingMessage(dialogId?: string | null): boolean {
  if (dialogId === null) return false;
  return !!getMessageSession(dialogId).streamingMessageId;
}

// ===== getters / select* wrappers (ignore Redux state) =====

export function getFirstStreamProcessed(dialogId?: string | null): boolean {
  return getMessageSession(dialogId).firstStreamProcessed;
}
export function getIsLoadingInitial(dialogId?: string | null): boolean {
  return getMessageSession(dialogId).isLoadingInitial;
}
export function getIsLoadingOlder(dialogId?: string | null): boolean {
  return getMessageSession(dialogId).isLoadingOlder;
}
export function getHasMoreOlder(dialogId?: string | null): boolean {
  return getMessageSession(dialogId).hasMoreOlder;
}
export function getMessageSessionError(
  dialogId?: string | null
): Error | null {
  return getMessageSession(dialogId).error;
}
export function getLastStreamTimestamp(dialogId?: string | null): number {
  return getMessageSession(dialogId).lastStreamTimestamp;
}

export function getLastAbortTimestamp(dialogId?: string | null): number {
  return getMessageSession(dialogId).lastAbortTimestamp;
}
export function getMessagesLoadingState(dialogId?: string | null) {
  const session = getMessageSession(dialogId);
  return {
    isLoadingInitial: session.isLoadingInitial,
    isLoadingOlder: session.isLoadingOlder,
    hasMoreOlder: session.hasMoreOlder,
    error: session.error,
  };
}

/** @deprecated Prefer getters/hooks; kept for non-React call sites. */
export const selectFirstStreamProcessed = (
  _state: any,
  dialogId?: string | null
) => getFirstStreamProcessed(dialogId);
export const selectIsLoadingInitial = (
  _state: any,
  dialogId?: string | null
) => getIsLoadingInitial(dialogId);
export const selectIsLoadingOlder = (_state: any, dialogId?: string | null) =>
  getIsLoadingOlder(dialogId);
export const selectHasMoreOlder = (_state: any, dialogId?: string | null) =>
  getHasMoreOlder(dialogId);
export const selectMessageError = (_state: any, dialogId?: string | null) =>
  getMessageSessionError(dialogId);
export const selectLastStreamTimestamp = (
  _state: any,
  dialogId?: string | null
) => getLastStreamTimestamp(dialogId);
export const selectMessagesLoadingState = (
  _state: any,
  dialogId?: string | null
) => getMessagesLoadingState(dialogId);

/**
 * Wave11 — hasStreamingMessage selector. Reads from the session store's
 * `streamingMessageId` index instead of scanning Redux msgs. Kept as a
 * getter-shaped selector so non-React call sites keep compiling; React UI
 * must use {@link useHasStreamingMessage} (useSyncExternalStore), because
 * `useAppSelector(selectHasStreamingMessage)` would NOT re-render on the
 * module-store mutation.
 */
export const selectHasStreamingMessage = (
  _state: any,
  dialogId?: string | null
) => getHasStreamingMessage(dialogId);

/**
 * Wave12 — `currentDialogId` peeled out of Redux. The active dialog id now
 * lives solely in this module store (`activeDialogId`). This selector ignores
 * the Redux state argument entirely so legacy `selectCurrentDialogId(state)`
 * call sites keep compiling; the optional `_state` is accepted only for the
 * single-arg compat shape.
 */
export const selectCurrentDialogId = (_state?: any): string | null =>
  getActiveMessageDialogId();

/**
 * Wave12 — React hook for the active dialog id, reading the session store via
 * useSyncExternalStore (three-arg form, SSR-safe) so `setActiveMessageDialogId`
 * triggers re-render without Redux.
 */
export function useCurrentMessageDialogId(): string | null {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getActiveMessageDialogId();
}

// ===== useSyncExternalStore =====

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): number {
  return version;
}

export function useFirstStreamProcessed(dialogId?: string | null): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (dialogId == null) return false;
  return getFirstStreamProcessed(dialogId);
}

export function useIsLoadingInitial(dialogId?: string | null): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (dialogId == null) return false;
  return getIsLoadingInitial(dialogId);
}

export function useIsLoadingOlder(dialogId?: string | null): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (dialogId == null) return false;
  return getIsLoadingOlder(dialogId);
}

export function useHasMoreOlder(dialogId?: string | null): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (dialogId == null) return true;
  return getHasMoreOlder(dialogId);
}

export function useMessageSessionError(
  dialogId?: string | null
): Error | null {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (dialogId == null) return null;
  return getMessageSessionError(dialogId);
}

export function useLastStreamTimestamp(dialogId?: string | null): number {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (dialogId == null) return 0;
  return getLastStreamTimestamp(dialogId);
}

export function useLastAbortTimestamp(dialogId?: string | null): number {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (dialogId == null) return 0;
  return getLastAbortTimestamp(dialogId);
}

export function useMessagesLoadingState(dialogId?: string | null) {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (dialogId == null) {
    return {
      isLoadingInitial: false,
      isLoadingOlder: false,
      hasMoreOlder: true,
      error: null as Error | null,
    };
  }
  return getMessagesLoadingState(dialogId);
}

/**
 * Wave11 — React hook for "is anything streaming in this dialog".
 * Reads the session store's `streamingMessageId` index via useSyncExternalStore
 * (three-arg form, SSR-safe) so streaming-token mutations trigger re-render
 * without scanning Redux msgs.
 *
 * - omitted / `undefined` → resolve via activeDialogId (useChatPageTitle)
 * - explicit `null` → false (no dialog selected, e.g. DialogPage empty state)
 */
export function useHasStreamingMessage(dialogId?: string | null): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (dialogId === null) return false;
  return getHasStreamingMessage(dialogId);
}

export function resetMessageSessionStoreForTests(): void {
  resetAllMessageSessions();
  version = 0;
}
