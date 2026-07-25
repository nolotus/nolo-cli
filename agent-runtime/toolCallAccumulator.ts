/**
 * Shared OpenAI chat.completions streaming tool-call accumulator.
 *
 * OpenAI streaming fragments tool calls across many chunks: each carries
 * `{ index, id?, type?, function: { name?, arguments? } }`. The `id` and
 * `function.name` are emitted at most once (take the first/concatenate), while
 * `function.arguments` arrives as a sequence of string slices concatenated
 * in order. Multiple concurrent calls are disambiguated by `index`.
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

export function accumulateToolCallDelta(
  accumulated: Record<number, AccumulatedToolCall>,
  deltas: Array<Record<string, unknown>>,
) {
  for (const delta of deltas) {
    const index = typeof delta.index === "number" ? delta.index : 0;
    const current =
      accumulated[index] ?? {
        id: "",
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
    if (typeof delta.id === "string" && delta.id) current.id = delta.id;
    const fn = delta.function;
    if (fn && typeof fn === "object") {
      const functionDelta = fn as { name?: string; arguments?: string };
      if (typeof functionDelta.name === "string" && functionDelta.name) {
        current.function.name += functionDelta.name;
      }
      if (typeof functionDelta.arguments === "string" && functionDelta.arguments) {
        current.function.arguments += functionDelta.arguments;
      }
    }
    accumulated[index] = current;
  }
}

export function finalizeAccumulatedToolCalls(
  accumulated: Record<number, AccumulatedToolCall>,
): AccumulatedToolCall[] {
  return Object.keys(accumulated)
    .map((key) => accumulated[Number(key)])
    .filter((call) => call?.function?.name);
}