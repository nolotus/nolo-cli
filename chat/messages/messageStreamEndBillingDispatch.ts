// Wave21 — billing dispatch for messageStreamEnd, extracted from the thunk.
//
// This is the one side-effect block Wave17-20 left inline. It dispatches
// updateTokens (reported or estimated mode) and swallows billing errors so a
// token-accounting failure never rejects the parent thunk — the terminal
// assistant write has already settled by the time this runs, so a billing
// error must not stamp "[Failed to save message]".

import type { StreamEndBillingMode } from "./messageStreamEndPostWritePolicy";

/** Per-provider-call billing evidence; totalUsage remains the context snapshot. */
export interface BillingUsageRecord {
  callId: string;
  usage: Record<string, unknown>;
  model?: string;
  provider?: string;
}

export interface DispatchStreamEndBillingInput {
  /** Redux dispatch from thunkApi. */
  dispatch: (action: any) => any;
  /**
   * The updateTokens async-thunk action creator. Passed in by the caller
   * (messageSlice) to avoid a circular import: dialogSlice already imports
   * from chat/messages, so this module must not import from chat/dialog.
   */
  updateTokensAction: (payload: any) => any;
  billingMode: StreamEndBillingMode;
  billingUsageRecords?: BillingUsageRecord[];
  billedUsage: unknown;
  billedEstimatedUsage: unknown;
  dialogId: string;
  dialogKey: string;
  agentConfig: any;
}

/**
 * Dispatch updateTokens for the stream-end billing mode.
 *
 * Best-effort: catches and logs errors. The caller (messageStreamEnd thunk)
 * must not reject — the message is already persisted.
 */
export async function dispatchStreamEndBilling(
  input: DispatchStreamEndBillingInput,
): Promise<void> {
  const {
    dispatch,
    updateTokensAction,
    billingMode,
    billingUsageRecords,
    billedUsage,
    billedEstimatedUsage,
    dialogId,
    dialogKey,
    agentConfig,
  } = input;

  // A token-accounting failure (e.g. quick-chat has no agent identity →
  // prepareTokenUsageData throws) must not reject the whole thunk and stamp
  // "[Failed to save message]" — the message IS saved.
  try {
    if (billingMode === "reported") {
      const usageRecords = billingUsageRecords?.length
        ? billingUsageRecords
        : [{ callId: undefined, usage: billedUsage }];
      for (const usageRecord of usageRecords) {
        await dispatch(
          updateTokensAction({
            dialogId,
            dialogKey,
            usageRecord,
            agentConfig,
          }),
        ).unwrap();
      }
    } else if (billingMode === "estimated") {
      await dispatch(
        updateTokensAction({
          dialogId,
          dialogKey,
          usage: billedEstimatedUsage,
          agentConfig,
        }),
      ).unwrap();
      console.warn(
        "[billing] Missing usage at messageStreamEnd; using estimated token update",
        {
          dialogId,
          dialogKey,
          provider: agentConfig.provider,
          model: agentConfig.model,
          endpointKey: agentConfig.endpointKey,
        },
      );
    }
  } catch (billingError) {
    console.error(
      "[billing] updateTokens failed (best-effort, message already saved):",
      billingError,
    );
  }
}
