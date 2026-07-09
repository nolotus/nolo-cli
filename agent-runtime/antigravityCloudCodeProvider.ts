import { randomUUID } from "node:crypto";
import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import {
  getAntigravityUserAgent,
  readAntigravityProjectId,
  resolveAntigravityCloudCodeBaseUrl,
} from "./antigravityOAuth";
import { resolveAntigravityWireModel } from "./antigravityWireModel";
import type { AgentRuntimeChatMessage, AgentRuntimeToolCall } from "./types";

const STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse";

/**
 * Gemini 3 rejects any replayed `functionCall` part that has no
 * `thoughtSignature` ("Function call is missing a thought_signature ...", 400
 * INVALID_ARGUMENT), which breaks every multi-tool turn after the first call.
 * Nolo carries tool calls in OpenAI shape, which has no field for the real
 * signature, so we replay the documented bypass sentinel — identical to
 * oh-my-pi's fallback when a real signature is unavailable. */
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/** Gemini 3 family gates the thought_signature requirement (matches oh-my-pi). */
function isGemini3WireModel(modelId: string): boolean {
  return modelId.includes("gemini-3");
}

type CcaPart =
  | { text: string }
  | {
      functionCall: { name: string; args: Record<string, unknown>; id?: string };
      thoughtSignature?: string;
    }
  | { functionResponse: { name: string; response: { output: string } } };

type CcaContent = { role: "user" | "model"; parts: CcaPart[] };

export type AntigravityCloudCodeCallArgs = {
  agentConfig: AgentRuntimeAgentConfig;
  accessToken: string;
  metadata?: Record<string, unknown> | null;
  openAiBody: Record<string, unknown>;
  signal?: AbortSignal;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

function messageText(content: AgentRuntimeChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function convertOpenAiMessagesToCca(
  messages: unknown[],
  options: { attachSkipThoughtSignature: boolean },
): { contents: CcaContent[]; systemTexts: string[] } {
  const contents: CcaContent[] = [];
  const systemTexts: string[] = [];
  const toolNamesById = new Map<string, string>();

  for (const raw of messages) {
    if (!raw || typeof raw !== "object" || !("role" in raw)) continue;
    const role = String((raw as { role: unknown }).role);
    const content = "content" in raw ? (raw as { content: unknown }).content : null;

    if (role === "system") {
      const text = messageText(content as AgentRuntimeChatMessage["content"]);
      if (text) systemTexts.push(text);
      continue;
    }

    if (role === "user") {
      const text = messageText(content as AgentRuntimeChatMessage["content"]);
      if (!text) continue;
      contents.push({ role: "user", parts: [{ text }] });
      continue;
    }

    if (role === "assistant") {
      const parts: CcaPart[] = [];
      const text = messageText(content as AgentRuntimeChatMessage["content"]);
      if (text) parts.push({ text });

      const toolCalls =
        "tool_calls" in raw && Array.isArray((raw as { tool_calls: unknown }).tool_calls)
          ? ((raw as { tool_calls: AgentRuntimeToolCall[] }).tool_calls ?? [])
          : [];
      for (const call of toolCalls) {
        const name = call?.function?.name?.trim();
        if (!name) continue;
        const id = call.id?.trim() || `${name}_${toolNamesById.size}`;
        toolNamesById.set(id, name);
        parts.push({
          functionCall: {
            name,
            args: parseToolArguments(call.function?.arguments),
            id,
          },
          ...(options.attachSkipThoughtSignature
            ? { thoughtSignature: SKIP_THOUGHT_SIGNATURE }
            : {}),
        });
      }
      if (parts.length === 0) continue;
      contents.push({ role: "model", parts });
      continue;
    }

    if (role === "tool") {
      const toolCallId =
        "tool_call_id" in raw && typeof (raw as { tool_call_id: unknown }).tool_call_id === "string"
          ? (raw as { tool_call_id: string }).tool_call_id
          : "";
      const name = toolNamesById.get(toolCallId) ?? "tool";
      const output = messageText(content as AgentRuntimeChatMessage["content"]) || "{}";
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response: { output } } }],
      });
    }
  }

  return { contents, systemTexts };
}

function convertOpenAiTools(tools: unknown[] | undefined) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const declarations: Record<string, unknown>[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || !("function" in tool)) continue;
    const fn = (tool as { function: Record<string, unknown> }).function;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;
    declarations.push({
      name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    });
  }
  if (declarations.length === 0) return undefined;
  return [{ functionDeclarations: declarations }];
}

function buildCloudCodeAssistPayload(args: AntigravityCloudCodeCallArgs) {
  const projectId = readAntigravityProjectId(args.metadata);
  if (!projectId) {
    throw new Error(
      'Antigravity OAuth credential is missing metadata.projectId. Re-run `nolo auth antigravity`.',
    );
  }

  const logicalModel =
    (typeof args.openAiBody.model === "string" && args.openAiBody.model.trim()) ||
    args.agentConfig.model?.trim() ||
    "gemini-3.1-pro";
  const { wireModelId: model, profile } = resolveAntigravityWireModel(logicalModel);

  const rawMessages = Array.isArray(args.openAiBody.messages) ? args.openAiBody.messages : [];
  const { contents, systemTexts } = convertOpenAiMessagesToCca(rawMessages, {
    attachSkipThoughtSignature: isGemini3WireModel(model),
  });
  if (contents.length === 0) {
    throw new Error("Antigravity Cloud Code Assist request has no user/model contents.");
  }

  const prompt = args.agentConfig.prompt?.trim();
  if (prompt) systemTexts.unshift(prompt);

  const request: Record<string, unknown> = { contents };
  if (systemTexts.length > 0) {
    request.systemInstruction = {
      role: "user",
      parts: systemTexts.map((text) => ({ text })),
    };
  }

  const tools = convertOpenAiTools(
    Array.isArray(args.openAiBody.tools) ? (args.openAiBody.tools as unknown[]) : undefined,
  );
  if (tools) {
    request.tools = tools;
    request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }

  const generationConfig: Record<string, unknown> = {};
  if (profile?.maxOutputTokens) {
    generationConfig.maxOutputTokens = profile.maxOutputTokens;
  } else if (typeof args.agentConfig.max_tokens === "number" && args.agentConfig.max_tokens > 0) {
    generationConfig.maxOutputTokens = args.agentConfig.max_tokens;
  }
  if (typeof args.agentConfig.temperature === "number") {
    generationConfig.temperature = args.agentConfig.temperature;
  }
  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig;
  }

  const agentId = randomUUID();
  const trajectoryId = randomUUID();
  const step = 2;
  const requestId = `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`;
  const isClaude = model.toLowerCase().includes("claude");
  const labels: Record<string, string> = {
    trajectory_id: trajectoryId,
    last_step_index: String(step - 1),
    used_claude: String(isClaude),
    used_claude_conservative: String(isClaude),
  };
  if (profile?.modelEnum) {
    labels.model_enum = profile.modelEnum;
  }
  request.labels = labels;
  request.sessionId = `-${Math.floor(Math.random() * 9e15)}`;

  return {
    url: `${resolveAntigravityCloudCodeBaseUrl(args.agentConfig.customProviderUrl)}${STREAM_PATH}`,
    envelope: {
      project: projectId,
      model,
      request,
      requestId,
      requestType: "agent",
      userAgent: "antigravity",
    },
  };
}

function extractJsonFromSseLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

function accumulateCcaChunks(chunks: unknown[]) {
  let text = "";
  const toolCalls: AgentRuntimeToolCall[] = [];
  let usage: Record<string, unknown> | undefined;

  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    const response: Record<string, unknown> =
      "response" in chunk && chunk.response && typeof chunk.response === "object"
        ? (chunk.response as Record<string, unknown>)
        : (chunk as Record<string, unknown>);

    if ("usageMetadata" in response && response.usageMetadata && typeof response.usageMetadata === "object") {
      const meta = response.usageMetadata as Record<string, unknown>;
      const prompt = typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : 0;
      const candidates = typeof meta.candidatesTokenCount === "number" ? meta.candidatesTokenCount : 0;
      const total = typeof meta.totalTokenCount === "number" ? meta.totalTokenCount : prompt + candidates;
      usage = {
        prompt_tokens: prompt,
        completion_tokens: candidates,
        total_tokens: total,
      };
    }

    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || !("content" in candidate)) continue;
      const content = (candidate as { content: unknown }).content;
      if (!content || typeof content !== "object" || !("parts" in content)) continue;
      const parts = (content as { parts: unknown }).parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        if ("text" in part && typeof (part as { text: unknown }).text === "string") {
          const piece = (part as { text: string }).text;
          if (!(part as { thought?: boolean }).thought) {
            text += piece;
          }
        }
        if ("functionCall" in part && (part as { functionCall: unknown }).functionCall) {
          const call = (part as { functionCall: Record<string, unknown> }).functionCall;
          const name = typeof call.name === "string" ? call.name : "tool";
          const id = typeof call.id === "string" ? call.id : `${name}_${toolCalls.length}`;
          const argsObj =
            call.args && typeof call.args === "object" && !Array.isArray(call.args)
              ? (call.args as Record<string, unknown>)
              : {};
          toolCalls.push({
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(argsObj) },
          });
        }
      }
    }
  }

  return { text, toolCalls, usage };
}

async function readSseJsonChunks(response: Response): Promise<unknown[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  let buffer = "";
  const chunks: unknown[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = extractJsonFromSseLine(line);
      if (parsed) chunks.push(parsed);
    }
  }
  if (buffer.trim()) {
    const parsed = extractJsonFromSseLine(buffer);
    if (parsed) chunks.push(parsed);
  }
  return chunks;
}

/** Call Cloud Code Assist and return an OpenAI chat.completion-shaped JSON body. */
export async function fetchAntigravityCloudCodeCompletion(
  args: AntigravityCloudCodeCallArgs,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const { url, envelope } = buildCloudCodeAssistPayload(args);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": getAntigravityUserAgent(),
    },
    body: JSON.stringify(envelope),
    signal: args.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      status: response.status,
      body: { error: { message: errorText || response.statusText } },
    };
  }

  const chunks = await readSseJsonChunks(response);
  const { text, toolCalls, usage } = accumulateCcaChunks(chunks);
  const message: Record<string, unknown> = {
    role: "assistant",
    content: text || null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    status: 200,
    body: {
      choices: [
        {
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        },
      ],
      ...(usage ? { usage } : {}),
    },
  };
}