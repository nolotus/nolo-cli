import { randomUUID } from "node:crypto";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asRecordOrEmpty } from "../core/recordOrEmpty";
import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import {
  getAntigravityUserAgent,
  readAntigravityProjectId,
  resolveAntigravityCloudCodeBaseUrl,
} from "./antigravityOAuth";
import { resolveAntigravityWireModel } from "./antigravityWireModel";
import { parseToolArgumentsJson } from "./parseToolArguments";
import { parseSseDataLineJson } from "./sseDataLine";
import { readSseDataValues } from "./sseFrames";
import type { AgentRuntimeChatMessage, AgentRuntimeToolCall } from "./types";

const STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse";

/**
 * Gemini 3 rejects any replayed `functionCall` part that has no
 * `thoughtSignature` ("Function call is missing a thought_signature ...", 400
 * INVALID_ARGUMENT), and gemini-3.5 在签名不合法时更隐蔽：不报错，直接返回
 * 空 STOP（0 completion tokens），表现为 agent「沉默」。
 * 主路径：流式响应里的真实签名随 tool_calls 捕获并持久化，回放时原样带回。
 * 兜底：历史消息没有签名时，沿用 oh-my-pi 的文档化绕过哨兵（gemini-3 可用，
 * gemini-3.5 上仍可能空响应，但至少不 400）。 */
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
  | { functionResponse: { name: string; response: { output: string } } }
  | { inlineData: { mimeType: string; data: string } };

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

/**
 * 从 `data:<mimeType>;base64,<data>` 解析出 Gemini inlineData 所需的 mimeType + data。
 * 非 data URL（http(s) 远程链接）返回 null——antigravity cloudcode 的本地 runtime
 * 调用没有图片下载通道，远程 URL 无法内联，交给上游报错或由调用方先内联。
 */
function parseDataUrlToInlineData(
  url: string,
): { mimeType: string; data: string } | null {
  const match = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]*)$/.exec(url);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/**
 * 从多模态 content 数组里提取 Gemini 的 inlineData part（图片）。
 * 只处理 data URL 形式的 image_url；远程 URL 跳过（不在此处下载）。
 */
function extractInlineDataParts(
  content: AgentRuntimeChatMessage["content"],
): { inlineData: { mimeType: string; data: string } }[] {
  if (!Array.isArray(content)) return [];
  const parts: { inlineData: { mimeType: string; data: string } }[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type !== "image_url") continue;
    const url = (part as { image_url?: { url?: string } }).image_url?.url;
    if (typeof url !== "string" || !url.trim()) continue;
    const inline = parseDataUrlToInlineData(url);
    if (inline) parts.push({ inlineData: inline });
  }
  return parts;
}

function convertOpenAiMessagesToCca(
  messages: unknown[],
  options: { attachSkipThoughtSignature: boolean },
): { contents: CcaContent[]; systemTexts: string[] } {
  const contents: CcaContent[] = [];
  const systemTexts: string[] = [];
  const toolNamesById = new Map<string, string>();
  // 记录尚未收到 functionResponse 的悬挂 functionCall 名字及对应 id
  let pendingFunctionCalls: Array<{ name: string; id: string }> = [];

  const pushOrMergeContent = (role: "user" | "model", parts: CcaPart[]) => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };

  const flushPendingFunctionCalls = () => {
    if (pendingFunctionCalls.length === 0) return;
    const dummyResponses: CcaPart[] = pendingFunctionCalls.map(({ name }) => ({
      functionResponse: { name, response: { output: "{}" } },
    }));
    pendingFunctionCalls = [];
    pushOrMergeContent("user", dummyResponses);
  };

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
      // 遇到新的 user 消息时，如果还有未应答的 functionCall，先自动补齐空 functionResponse
      flushPendingFunctionCalls();

      const text = messageText(content as AgentRuntimeChatMessage["content"]);
      const imageParts = extractInlineDataParts(
        content as AgentRuntimeChatMessage["content"],
      );
      if (!text && imageParts.length === 0) continue;
      const parts: CcaPart[] = [];
      if (text) parts.push({ text });
      for (const img of imageParts) parts.push(img);
      pushOrMergeContent("user", parts);
      continue;
    }

    if (role === "assistant") {
      // 遇到新的 assistant 消息时，先补齐之前挂起的 functionCall 响应（如果有）
      flushPendingFunctionCalls();

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
        pendingFunctionCalls.push({ name, id });

        // 优先回放持久化下来的真实 thoughtSignature（gemini-3.5 强制校验）。
        // 没有真实签名时按 Gemini 文档形状处理：只有本轮第一个 functionCall
        // part 需要签名（哨兵兜底，防 gemini-3 400），后续 part 不带。
        const realSignature =
          typeof call.thought_signature === "string" && call.thought_signature
            ? call.thought_signature
            : undefined;
        const isFirstFunctionCallPart = !parts.some((p) => "functionCall" in p);
        parts.push({
          functionCall: {
            name,
            args: parseToolArgumentsJson(call.function?.arguments),
            id,
          },
          ...(realSignature
            ? { thoughtSignature: realSignature }
            : options.attachSkipThoughtSignature && isFirstFunctionCallPart
              ? { thoughtSignature: SKIP_THOUGHT_SIGNATURE }
              : {}),
        });
      }
      if (parts.length === 0) continue;
      pushOrMergeContent("model", parts);
      continue;
    }

    if (role === "tool") {
      const toolCallId =
        "tool_call_id" in raw && typeof (raw as { tool_call_id: unknown }).tool_call_id === "string"
          ? (raw as { tool_call_id: string }).tool_call_id
          : "";
      const rawName =
        "name" in raw && typeof (raw as { name: unknown }).name === "string"
          ? (raw as { name: string }).name.trim()
          : "";
      const name = toolNamesById.get(toolCallId) || rawName || pendingFunctionCalls[0]?.name || "tool";

      // 移除已被此 tool 响应消解的 pending 记录
      const pendingIndex = pendingFunctionCalls.findIndex(
        (p) => (toolCallId ? p.id === toolCallId : p.name === name),
      );
      if (pendingIndex !== -1) {
        pendingFunctionCalls.splice(pendingIndex, 1);
      } else if (pendingFunctionCalls.length > 0) {
        pendingFunctionCalls.shift();
      }

      const output = messageText(content as AgentRuntimeChatMessage["content"]) || "{}";
      pushOrMergeContent("user", [
        { functionResponse: { name, response: { output } } },
      ]);
    }
  }

  // 结尾清理任何残余的 pending functionCall
  flushPendingFunctionCalls();

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
    asOptionalTrimmedString(args.openAiBody.model) ??
    asOptionalTrimmedString(args.agentConfig.model) ??
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

function accumulateCcaChunks(chunks: unknown[]) {
  let text = "";
  const toolCalls: AgentRuntimeToolCall[] = [];
  let usage: Record<string, unknown> | undefined;
  // Gemini 3 Flash Preview 将 thoughtSignature 放在前置 thought part 上，
  // functionCall part 自身不带签名。用这个变量暂存最近一个 thought part
  // 的签名，传递给紧随其后的 functionCall part。
  let pendingThoughtSignature: string | undefined;

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
        const partSignature = (part as { thoughtSignature?: unknown }).thoughtSignature;
        if ("text" in part && typeof (part as { text: unknown }).text === "string") {
          const piece = (part as { text: string }).text;
          if (!(part as { thought?: boolean }).thought) {
            text += piece;
          }
        }
        // Gemini 3 Flash Preview 将 thoughtSignature 放在前置 thought part 上，
        // 而非 functionCall part 自身。捕获 thought part 的签名作为 pending
        // signature，传递给紧随其后的 functionCall part。
        if (
          (part as { thought?: boolean }).thought &&
          typeof partSignature === "string" &&
          partSignature
        ) {
          pendingThoughtSignature = partSignature;
        }
        if ("functionCall" in part && (part as { functionCall: unknown }).functionCall) {
          const call = (part as { functionCall: Record<string, unknown> }).functionCall;
          const name = typeof call.name === "string" ? call.name : "tool";
          const id = typeof call.id === "string" ? call.id : `${name}_${toolCalls.length}`;
          const argsObj = asRecordOrEmpty(call.args);
          // 优先使用 functionCall part 自身的签名；没有时回退到前置 thought
          // part 捕获的 pending 签名（gemini-3-flash-preview 的签名模式）。
          const resolvedSignature =
            typeof partSignature === "string" && partSignature
              ? partSignature
              : pendingThoughtSignature;
          pendingThoughtSignature = undefined;
          toolCalls.push({
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(argsObj) },
            ...(typeof resolvedSignature === "string" && resolvedSignature
              ? { thought_signature: resolvedSignature }
              : {}),
          });
        }
      }
    }
  }

  return { text, toolCalls, usage };
}

async function readSseJsonChunks(response: Response): Promise<unknown[]> {
  return readSseDataValues(response, parseSseDataLineJson);
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