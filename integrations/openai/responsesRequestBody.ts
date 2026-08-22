import { convertMessagesToResponsesInput, toResponsesTools } from "./responsesHelpers";

/** Convert a chat-completions-shaped body into the public Responses wire body. */
export function buildResponsesRequestBody(
  body: Record<string, any>,
  model: string,
): Record<string, any> {
  const tools = Array.isArray(body.tools) ? toResponsesTools(body.tools) : undefined;
  const reasoningEffort =
    body.reasoning && typeof body.reasoning === "object"
      ? undefined
      : typeof body.reasoning_effort === "string" && body.reasoning_effort.trim()
        ? body.reasoning_effort
        : undefined;
  return {
    ...body,
    model,
    input:
      Array.isArray(body.input) && body.input.length > 0
        ? body.input
        : convertMessagesToResponsesInput(body.messages ?? []),
    ...(Array.isArray(body.tools) ? { tools: tools ?? undefined } : {}),
    ...(typeof body.max_tokens === "number"
      ? { max_output_tokens: body.max_tokens }
      : {}),
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    messages: undefined,
    max_tokens: undefined,
    reasoning_effort: undefined,
    tool_choice: undefined,
  };
}
