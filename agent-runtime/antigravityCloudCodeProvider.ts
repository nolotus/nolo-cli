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
import { parseSseDataLineJson } from "./sseDataLine";
import { readSseDataValues } from "./sseFrames";
import {
  convertOpenAiMessagesToGemini,
  convertOpenAiToolsToGemini,
  accumulateGeminiChunks,
  isGemini3Model,
} from "./geminiNativeShared";

const STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse";

/**
 * Gemini 3 rejects any replayed `functionCall` part that has no
 * `thoughtSignature` ("Function call is missing a thought_signature ...", 400
 * INVALID_ARGUMENT), and gemini-3.5 在签名不合法时更隐蔽：不报错，直接返回
 * 空 STOP（0 completion tokens），表现为 agent「沉默」。
 *
 * thought_signature 捕获/回放/哨兵逻辑已提取到 geminiNativeShared.ts，
 * 供 antigravity 路径和 platform proxy native 路径共用。
 */

type AntigravityCloudCodeCallArgs = {
  agentConfig: AgentRuntimeAgentConfig;
  accessToken: string;
  metadata: Record<string, unknown> | null;
  openAiBody: {
    model?: unknown;
    messages: unknown[];
    tools?: unknown[];
  };
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

/**
 * Cloud Code Assist 对 Claude 模型期望 Claude Messages wire 格式
 * （messages 数组 + tool_use / tool_result + tool_use_id），而不是 Gemini 的
 * contents/functionCall/functionResponse。此前所有模型统一走 Gemini 格式，
 * 导致 Claude 模型在第二次调用回放 tool 结果时被网关 400 拒绝：
 *   messages.2.content.0.tool_result.tool_use_id: Field required
 *
 * 网关对请求体做严格 schema 校验，因此这里产出纯净的 Claude Messages 结构：
 * 不注入 cache_control、不注入 Claude Code 身份文本，避免未知字段被拒。
 */
/**
 * Cloud Code Assist 网关的 request schema 是 Gemini generateContent proto
 * （contents / systemInstruction / tools.functionDeclarations / generationConfig /
 * labels / sessionId），不认 Claude Messages 字段（messages/system/tools.name/
 * input_schema/max_tokens 都会被 protobuf 校验拒绝，HTTP 400）。
 *
 * Claude 模型也走 Gemini wire；网关内部把 Gemini contents 转成 Claude
 * messages 时，需要 functionResponse → tool_result 的 tool_use_id 关联，
 * 因此 convertOpenAiMessagesToGemini 在 functionResponse 上保留 OpenAI
 * tool_call_id（见 geminiNativeShared.ts）。labels.used_claude 告诉网关
 * 目标模型是 Claude。
 */
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
  const isClaude = model.toLowerCase().includes("claude");

  const { contents, systemTexts } = convertOpenAiMessagesToGemini(rawMessages, {
    attachSkipThoughtSignature: isGemini3Model(model),
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

  const tools = convertOpenAiToolsToGemini(
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
  const { text, toolCalls, usage } = accumulateGeminiChunks(chunks);
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