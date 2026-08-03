/**
 * Shared OpenAI chat.completions streaming tool-call accumulator.
 *
 * OpenAI streaming fragments tool calls across many chunks: each carries
 * `{ index, id?, type?, function: { name?, arguments? } }`. The `id` and
 * `function.name` are emitted at most once (take the first/concatenate), while
 * `function.arguments` arrives as a sequence of string slices concatenated
 * in order. Multiple concurrent calls are disambiguated by `index`.
 *
 * Not every upstream honours that. OpenCode Go (`https://opencode.ai/zen/go/v1`)
 * streams every parallel call as `index: 0` and only distinguishes them by a
 * fresh `function.name` + `id` pair:
 *
 *   {index:0, id:"fc_a", function:{name:"get_weather", arguments:""}}
 *   {index:0,           function:{arguments:"{\"city\":\"Beijing\"}"}}
 *   {index:0, id:"fc_b", function:{name:"get_weather", arguments:""}}
 *   {index:0,           function:{arguments:"{\"city\":\"Shanghai\"}"}}
 *
 * Slotting those by `index` alone collapses both calls into one — names
 * concatenate into garbage like `get_weatherget_weather` and arguments into
 * `{...}{...}`. So a new `id` always opens a new slot, and the wire index is
 * remembered per slot so that the id-less argument fragments that follow land
 * on the newest call for that index rather than on the one it displaced.
 *
 * Both `openAiCompatibleProvider` and `platformChatProvider` stream the same
 * chat.completions delta shape, so they share this one implementation to
 * prevent drift (the two copies had already diverged on `function.name`
 * handling: one concatenated, one took-first — concatenate is the superset
 * that stays correct when upstream splits the name across chunks).
 */
export type AccumulatedToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

/**
 * A slot mid-accumulation. `arguments` is still open because a few upstreams
 * hand over the finished object instead of streaming a JSON string; `finalize`
 * serialises it back to the string the wire expects. `wireIndex` is the index
 * the slot first arrived under, which `finalize` strips — callers only ever
 * see finished tool calls, so the bookkeeping cannot leak into a request body.
 */
export type ToolCallSlot = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string | object;
  };
  wireIndex: number;
};

/** Opaque accumulator state; build one with {@link createToolCallAccumulator}. */
export type ToolCallAccumulator = {
  slots: ToolCallSlot[];
};

export function createToolCallAccumulator(): ToolCallAccumulator {
  return { slots: [] };
}

/**
 * Pick the slot a delta belongs to, appending one when the delta starts a new
 * call. A delta carrying an unseen `id` always starts a new call; an id-less
 * fragment continues the newest slot opened under the same wire index.
 */
function resolveSlot(
  accumulator: ToolCallAccumulator,
  deltaId: string,
  wireIndex: number | undefined,
): number {
  const { slots } = accumulator;

  if (deltaId) {
    const existing = slots.findIndex((slot) => slot.id === deltaId);
    if (existing !== -1) return existing;
  } else if (wireIndex !== undefined) {
    const sameIndex = slots.findLastIndex((slot) => slot.wireIndex === wireIndex);
    if (sameIndex !== -1) return sameIndex;
  } else if (slots.length > 0) {
    return slots.length - 1;
  }

  slots.push({
    id: deltaId,
    type: "function",
    function: { name: "", arguments: "" },
    wireIndex: wireIndex ?? slots.length,
  });
  return slots.length - 1;
}

export function accumulateToolCallDelta(
  accumulator: ToolCallAccumulator,
  deltas: Array<Record<string, unknown>>,
) {
  for (const delta of deltas) {
    const deltaId = typeof delta.id === "string" && delta.id ? delta.id : "";
    const wireIndex = typeof delta.index === "number" ? delta.index : undefined;
    const current = accumulator.slots[resolveSlot(accumulator, deltaId, wireIndex)]!;

    const fn = delta.function;
    if (fn && typeof fn === "object") {
      const functionDelta = fn as { name?: string; arguments?: string | object };
      if (typeof functionDelta.name === "string" && functionDelta.name) {
        current.function.name += functionDelta.name;
      }
      const argumentsDelta = functionDelta.arguments;
      if (typeof argumentsDelta === "string" && argumentsDelta) {
        const soFar =
          typeof current.function.arguments === "string" ? current.function.arguments : "";
        current.function.arguments = soFar + argumentsDelta;
      } else if (argumentsDelta && typeof argumentsDelta === "object") {
        // Whole-object arguments are a final value, not a fragment: last wins.
        current.function.arguments = argumentsDelta;
      }
    }
  }
}

export function finalizeAccumulatedToolCalls(
  accumulator: ToolCallAccumulator,
): AccumulatedToolCall[] {
  return accumulator.slots
    .filter((slot) => slot.function.name)
    .map(({ id, type, function: fn }) => ({
      id,
      type,
      function: {
        name: fn.name,
        arguments:
          typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    }));
}
