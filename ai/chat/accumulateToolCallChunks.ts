/**
 * Web-side adapter over the one tool-call accumulator.
 *
 * The slotting rules live in `agent-runtime/toolCallAccumulator` — which id
 * opens a new call, which fragment continues which slot. This file used to
 * carry a second copy of them, and the copies drifted: it kept the `index`-only
 * slotting that collapses OpenCode Go's parallel calls (every one of them
 * arrives as `index: 0`) long after the runtime side was fixed.
 *
 * What stays here is the shape the streaming UI wants, not a second algorithm:
 *
 * - array in / array out, so `applyDelta` can drop the result straight into
 *   its state snapshot and re-render the calls as they arrive;
 * - no filtering of unnamed slots. `finalizeAccumulatedToolCalls` drops them
 *   because a call with no name cannot be executed, but mid-stream a slot that
 *   has an id and no name yet is simply a call still arriving;
 * - the slot's wire index rides along in the existing optional `index` field,
 *   because the accumulator needs it back on the next delta to tell parallel
 *   calls apart. Callers map to `{ id, type, function }` explicitly before
 *   sending, so it never reaches the wire.
 *
 * Each call returns fresh entries rather than mutating the snapshot it was
 * given, which the old in-place version did not guarantee.
 */
import {
  accumulateToolCallDelta,
  type ToolCallSlot,
} from "../../agent-runtime/toolCallAccumulator";

export interface ToolCallChunk {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string | object;
  };
}

export interface AccumulatedToolCall {
  index?: number;
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string | object;
  };
}

export function accumulateToolCallChunks(
  currentAccumulatedCalls: AccumulatedToolCall[],
  toolCallChunks: ToolCallChunk[],
): AccumulatedToolCall[] {
  const accumulator = {
    slots: currentAccumulatedCalls.map(
      (call, position) =>
        ({
          ...call,
          // The accumulator appends into function.arguments, so the nested
          // object has to be copied too or the caller's snapshot moves.
          function: { ...call.function },
          wireIndex: call.index ?? position,
        }) as ToolCallSlot,
    ),
  };

  accumulateToolCallDelta(accumulator, toolCallChunks as Array<Record<string, unknown>>);

  return accumulator.slots.map(({ wireIndex, ...call }) => ({
    ...call,
    index: wireIndex,
  })) as AccumulatedToolCall[];
}
