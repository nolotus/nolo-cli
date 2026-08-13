import type { AgentRuntimeToolCall } from "./types";

type State = { id: string; name: string; arguments: string };

export type ResponsesToolAccumulator = Map<string, State>;

export function createResponsesToolAccumulator(): ResponsesToolAccumulator {
  return new Map();
}

function keyOf(event: any): string {
  return typeof event?.item_id === "string" && event.item_id
    ? event.item_id
    : typeof event?.item?.id === "string" && event.item.id
      ? event.item.id
      : typeof event?.item?.call_id === "string" && event.item.call_id
        ? event.item.call_id
        : typeof event?.call_id === "string" && event.call_id
          ? event.call_id
          : "";
}

export function applyResponsesToolEvent(
  calls: ResponsesToolAccumulator,
  event: any,
): void {
  const key = keyOf(event);
  if (!key) return;
  const item = event?.item;
  const id = item?.call_id || item?.id || event?.call_id || key;
  const current = calls.get(key) ?? { id, name: "", arguments: "" };
  if (typeof item?.name === "string" && item.name) current.name = item.name;
  if (typeof item?.arguments === "string") current.arguments = item.arguments;
  if (typeof event?.arguments === "string") current.arguments = event.arguments;
  if (typeof event?.delta === "string") current.arguments += event.delta;
  calls.set(key, current);
}

export function addResponsesToolCall(
  calls: ResponsesToolAccumulator,
  call: AgentRuntimeToolCall,
): void {
  const key = call.id;
  calls.set(key, {
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
  });
}

export function finalizeResponsesToolCalls(
  calls: ResponsesToolAccumulator,
): AgentRuntimeToolCall[] {
  return [...calls.values()]
    .filter((call) => call.name)
    .map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
}
