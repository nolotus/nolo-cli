// File: chat/dialog/dialogRuntimeStore.ts
// Module store for per-dialog session runtime — peeled out of Redux (Wave9).
// Holds tokens / pendingFiles / controllers / pendingRawData / loopStopReason /
// pendingUserInputQueue. dialogSlice keeps currentDialogKey + CRUD/send thunks.
//
// Sync mutators return a lightweight action object so existing
// `dispatch(addPendingFile(...))` call sites keep working (mutator runs on
// invoke; Redux ignores the no-op type). React UI must use the hooks below
// (useAppSelector on select* wrappers will NOT re-render).

import { useSyncExternalStore } from "react";

import {
  GLOBAL_DIALOG_RUNTIME_KEY,
  type LoopStopReason,
  type PendingFile,
  type PendingRawData,
  type TokenStats,
} from "./dialogRuntimeTypes";

export type { LoopStopReason, PendingFile, PendingRawData, TokenStats };
export { GLOBAL_DIALOG_RUNTIME_KEY };

export interface DialogRuntimeState {
  tokens: TokenStats;
  pendingFiles: PendingFile[];
  activeControllers: Record<string, AbortController>;
  pendingRawData: Record<string, PendingRawData>;
  loopStopReason: LoopStopReason | null;
  pendingUserInputQueue: string[];
}

type LiveTokenUsagePayload = {
  input_tokens: number;
  output_tokens: number;
  cost?: number;
  dialogKey?: string;
};

const createEmptyTokenStats = (): TokenStats => ({
  inputTokens: 0,
  outputTokens: 0,
  totalCost: 0,
});

const createEmptyDialogRuntimeState = (): DialogRuntimeState => ({
  tokens: createEmptyTokenStats(),
  pendingFiles: [],
  activeControllers: {},
  pendingRawData: {},
  loopStopReason: null,
  pendingUserInputQueue: [],
});

let activeDialogKey: string | null = null;
const runtimeByKey: Record<string, DialogRuntimeState> = {
  [GLOBAL_DIALOG_RUNTIME_KEY]: createEmptyDialogRuntimeState(),
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

export function setActiveDialogKey(key: string | null): void {
  activeDialogKey = key;
  notify();
}

export function getActiveDialogKey(): string | null {
  return activeDialogKey;
}

const resolveDialogRuntimeKey = (dialogKey?: string | null): string =>
  dialogKey ?? activeDialogKey ?? GLOBAL_DIALOG_RUNTIME_KEY;

const ensureDialogRuntimeState = (
  dialogKey?: string | null
): DialogRuntimeState => {
  const runtimeKey = resolveDialogRuntimeKey(dialogKey);
  if (!runtimeByKey[runtimeKey]) {
    runtimeByKey[runtimeKey] = createEmptyDialogRuntimeState();
  }
  return runtimeByKey[runtimeKey];
};

/**
 * Reset per-session runtime state when a dialog is (re)initialized.
 * Resets: tokens, loopStopReason, pendingUserInputQueue.
 * Preserves: activeControllers, pendingFiles, pendingRawData.
 */
export function resetDialogRuntimeSessionState(dialogKey?: string | null): void {
  const runtime = ensureDialogRuntimeState(dialogKey);
  runtime.tokens = createEmptyTokenStats();
  runtime.loopStopReason = null;
  runtime.pendingUserInputQueue = [];
  notify();
}

export function addPendingFile(payload: PendingFile) {
  const targetRuntimeKey =
    payload.targetDialogKey ??
    payload.runtimeDialogKey ??
    (payload.type === "dialog" ? activeDialogKey : payload.dialogKey);
  const runtime = ensureDialogRuntimeState(targetRuntimeKey);
  if (!runtime.pendingFiles.some((f) => f.id === payload.id)) {
    runtime.pendingFiles.push(payload);
    notify();
  }
  return action("dialogRuntime/addPendingFile", payload);
}

export function removePendingFile(fileId: string) {
  const runtime = ensureDialogRuntimeState();
  const fileToRemove = runtime.pendingFiles.find((f) => f.id === fileId);
  if (fileToRemove) {
    if (fileToRemove.pageKey) {
      delete runtime.pendingRawData[fileToRemove.pageKey];
    }
    runtime.pendingFiles = runtime.pendingFiles.filter(
      (file) => file.id !== fileId
    );
    notify();
  }
  return action("dialogRuntime/removePendingFile", fileId);
}

export function clearPendingAttachments(
  payload?: { dialogKey?: string; all?: boolean }
) {
  if (payload?.all) {
    Object.values(runtimeByKey).forEach((runtime) => {
      runtime.pendingFiles = [];
      runtime.pendingRawData = {};
    });
    notify();
    return action("dialogRuntime/clearPendingAttachments", payload);
  }
  const runtime = ensureDialogRuntimeState(payload?.dialogKey);
  runtime.pendingFiles = [];
  runtime.pendingRawData = {};
  notify();
  return action("dialogRuntime/clearPendingAttachments", payload);
}

export function setLoopStopReason(payload: {
  reason: LoopStopReason | null;
  dialogKey?: string;
}) {
  const runtime = ensureDialogRuntimeState(payload.dialogKey);
  runtime.loopStopReason = payload.reason;
  notify();
  return action("dialogRuntime/setLoopStopReason", payload);
}

export function clearDialogRuntimeState(payload: { dialogKey: string }) {
  delete runtimeByKey[payload.dialogKey];
  notify();
  return action("dialogRuntime/clearDialogRuntimeState", payload);
}

export function addActiveController(payload: {
  messageId: string;
  controller: AbortController;
  dialogKey?: string;
}) {
  const runtime = ensureDialogRuntimeState(payload.dialogKey);
  runtime.activeControllers[payload.messageId] = payload.controller;
  notify();
  return action("dialogRuntime/addActiveController", payload);
}

export function removeActiveController(
  payload: { messageId: string; dialogKey?: string } | string
) {
  const normalized =
    typeof payload === "string" ? { messageId: payload } : payload;
  const runtime = ensureDialogRuntimeState(normalized.dialogKey);
  delete runtime.activeControllers[normalized.messageId];
  notify();
  return action("dialogRuntime/removeActiveController", normalized);
}

export function clearActiveControllers(
  payload?: { dialogKey?: string; all?: boolean }
) {
  if (payload?.all) {
    Object.values(runtimeByKey).forEach((runtime) => {
      runtime.activeControllers = {};
    });
    notify();
    return action("dialogRuntime/clearActiveControllers", payload);
  }
  const runtime = ensureDialogRuntimeState(payload?.dialogKey);
  runtime.activeControllers = {};
  notify();
  return action("dialogRuntime/clearActiveControllers", payload);
}

export function enqueueUserInput(
  payload: string | { text: string; dialogKey?: string }
) {
  const normalized =
    typeof payload === "string" ? { text: payload } : payload;
  const runtime = ensureDialogRuntimeState(normalized.dialogKey);
  runtime.pendingUserInputQueue.push(normalized.text);
  notify();
  return action("dialogRuntime/enqueueUserInput", normalized);
}

export function dequeueUserInput(payload?: { dialogKey?: string }) {
  const runtime = ensureDialogRuntimeState(payload?.dialogKey);
  runtime.pendingUserInputQueue.shift();
  notify();
  return action("dialogRuntime/dequeueUserInput", payload);
}

export function clearPendingUserInputQueue(
  payload?: { dialogKey?: string; all?: boolean }
) {
  if (payload?.all) {
    Object.values(runtimeByKey).forEach((runtime) => {
      runtime.pendingUserInputQueue = [];
    });
    notify();
    return action("dialogRuntime/clearPendingUserInputQueue", payload);
  }
  const runtime = ensureDialogRuntimeState(payload?.dialogKey);
  runtime.pendingUserInputQueue = [];
  notify();
  return action("dialogRuntime/clearPendingUserInputQueue", payload);
}

export function tokenUsageLiveUpdate(payload: LiveTokenUsagePayload) {
  const runtime = ensureDialogRuntimeState(payload.dialogKey);
  runtime.tokens.inputTokens += payload.input_tokens;
  runtime.tokens.outputTokens += payload.output_tokens;
  runtime.tokens.totalCost += payload.cost ?? 0;
  notify();
  return action("dialogRuntime/tokenUsageLiveUpdate", payload);
}

/** createPageAndAddReference fulfilled side-effect */
export function addPageReferenceToRuntime(payload: {
  reference: PendingFile;
  rawData: PendingRawData | null;
  dialogKey?: string;
}): void {
  const runtime = ensureDialogRuntimeState(payload.dialogKey);
  runtime.pendingFiles.push(payload.reference);
  if (payload.rawData?.pageKey) {
    runtime.pendingRawData[payload.rawData.pageKey] = payload.rawData;
  }
  notify();
}

/** updateTokens fulfilled — subtract billed tokens from live counters */
export function applyUpdateTokensFulfilled(payload: {
  dialogKey: string;
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
}): void {
  const runtime = runtimeByKey[payload.dialogKey];
  if (!runtime) return;
  runtime.tokens.inputTokens = Math.max(
    0,
    runtime.tokens.inputTokens - (payload.input_tokens ?? 0)
  );
  runtime.tokens.outputTokens = Math.max(
    0,
    runtime.tokens.outputTokens - (payload.output_tokens ?? 0)
  );
  runtime.tokens.totalCost = Math.max(
    0,
    runtime.tokens.totalCost - (payload.cost ?? 0)
  );
  notify();
}

/**
 * Leaving a dialog: move pending files to global runtime, clear queues/raw.
 * Does not change Redux currentDialogKey — caller clears that separately.
 */
export function applyClearDialogStateRuntime(): void {
  const previousDialogKey = activeDialogKey;
  const previousRuntime = previousDialogKey
    ? runtimeByKey[previousDialogKey]
    : null;
  const globalRuntime = ensureDialogRuntimeState(GLOBAL_DIALOG_RUNTIME_KEY);

  if (previousRuntime) {
    if (previousRuntime.pendingFiles.length > 0) {
      globalRuntime.pendingFiles = previousRuntime.pendingFiles;
      previousRuntime.pendingFiles = [];
    }
    previousRuntime.pendingRawData = {};
    previousRuntime.pendingUserInputQueue = [];
  }
  activeDialogKey = null;
  globalRuntime.pendingRawData = {};
  globalRuntime.pendingUserInputQueue = [];
  notify();
}

export function deleteDialogRuntime(dialogKey: string): void {
  delete runtimeByKey[dialogKey];
  notify();
}

export function abortActiveControllers(args?: {
  dialogKey?: string;
  all?: boolean;
}): void {
  const runtimes: DialogRuntimeState[] = args?.all
    ? Object.values(runtimeByKey)
    : [ensureDialogRuntimeState(args?.dialogKey)];
  runtimes.forEach((runtime) => {
    Object.values(runtime.activeControllers).forEach((controller) =>
      controller.abort()
    );
  });
}

// ===== getters (select* ignore Redux state — for non-React callers) =====

export function getDialogRuntimeState(
  dialogKey?: string | null
): DialogRuntimeState {
  return (
    runtimeByKey[resolveDialogRuntimeKey(dialogKey)] ??
    createEmptyDialogRuntimeState()
  );
}

export function getPendingFiles(dialogKey?: string | null): PendingFile[] {
  return getDialogRuntimeState(dialogKey).pendingFiles;
}

export function getActiveControllers(
  dialogKey?: string | null
): Record<string, AbortController> {
  return getDialogRuntimeState(dialogKey).activeControllers;
}

export function getPendingRawData(
  dialogKey?: string | null
): Record<string, PendingRawData> {
  return getDialogRuntimeState(dialogKey).pendingRawData;
}

export function getDialogRuntimeTokens(dialogKey?: string | null): TokenStats {
  return getDialogRuntimeState(dialogKey).tokens;
}

export function getPendingRawDataByPageKey(
  pageKey: string
): PendingRawData | undefined {
  return getDialogRuntimeState().pendingRawData[pageKey];
}

export function getPendingUserInputQueue(
  dialogKey?: string | null
): string[] {
  return getDialogRuntimeState(dialogKey).pendingUserInputQueue;
}

export function getLoopStopReason(
  dialogKey?: string | null
): LoopStopReason | null {
  return getDialogRuntimeState(dialogKey).loopStopReason;
}

/** @deprecated Prefer getters/hooks; kept for stream/non-React call sites. */
export const selectDialogRuntimeByKey = (
  _state: any,
  dialogKey?: string
) => getDialogRuntimeState(dialogKey);
export const selectPendingFiles = (_state: any, dialogKey?: string) =>
  getPendingFiles(dialogKey);
export const selectActiveControllers = (_state: any, dialogKey?: string) =>
  getActiveControllers(dialogKey);
export const selectPendingRawData = (_state: any, dialogKey?: string) =>
  getPendingRawData(dialogKey);
export const selectDialogRuntimeTokens = (_state: any, dialogKey?: string) =>
  getDialogRuntimeTokens(dialogKey);
export const selectPendingRawDataByPageKey = (_state: any, pageKey: string) =>
  getPendingRawDataByPageKey(pageKey);
export const selectPendingUserInputQueue = (
  _state: any,
  dialogKey?: string
) => getPendingUserInputQueue(dialogKey);
export const selectLoopStopReason = (_state: any, dialogKey?: string) =>
  getLoopStopReason(dialogKey);

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

export function usePendingFiles(dialogKey?: string | null): PendingFile[] {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getPendingFiles(dialogKey);
}

export function useActiveControllers(
  dialogKey?: string | null
): Record<string, AbortController> {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getActiveControllers(dialogKey);
}

export function usePendingUserInputQueue(
  dialogKey?: string | null
): string[] {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getPendingUserInputQueue(dialogKey);
}

export function useLoopStopReason(
  dialogKey?: string | null
): LoopStopReason | null {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getLoopStopReason(dialogKey);
}

export function useDialogRuntimeTokens(
  dialogKey?: string | null
): TokenStats {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getDialogRuntimeTokens(dialogKey);
}

export function resetDialogRuntimeStoreForTests(): void {
  activeDialogKey = null;
  for (const key of Object.keys(runtimeByKey)) {
    delete runtimeByKey[key];
  }
  runtimeByKey[GLOBAL_DIALOG_RUNTIME_KEY] = createEmptyDialogRuntimeState();
  notify();
}
