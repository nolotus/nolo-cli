// 文件路径: ai/chat/fetchUtils.ts
import { Agent } from "../../app/types";

import { API_ENDPOINTS } from "../../database/config";
import { performServerProxyFetchWithRetry } from "./serverProxyRetry";
import { resolveAgentCallPlan } from "../../agent-runtime/agentCallPlan";

interface BodyData {
  model: string;
  messages: any[];
  stream: boolean;
  tools?: any[];
  provider?: string;
}

interface FetchParams {
  agentConfig: Agent;
  api: string;
  bodyData: BodyData;
  currentServer: string;
  token: string;
  signal?: AbortSignal; // signal 是可选的
}

const buildProxyPayload = (
  bodyData: BodyData,
  api: string,
  agentConfig: Agent
) => {
  const apiSource =
    agentConfig.apiSource === "custom" || agentConfig.apiSource === "cli"
      ? agentConfig.apiSource
      : undefined;
  const provider =
    bodyData.provider ||
    agentConfig.provider ||
    (apiSource === "custom" ? "custom" : undefined);
  const apiKey = agentConfig.apiKey?.trim() || undefined;

  return {
    ...bodyData,
    url: api,
    provider,
    agentKey: agentConfig.dbKey,
    ...(apiSource ? { apiSource } : {}),
    ...((agentConfig as any).apiKeyHeader ? { apiKeyHeader: (agentConfig as any).apiKeyHeader } : {}),
    KEY: apiKey,
  };
};

const fetchDirectly = async ({
  api,
  agentConfig,
  bodyData,
  signal,
}: Omit<FetchParams, "currentServer" | "token">): Promise<Response> => {
  try {
    const apiKey = agentConfig.apiKey?.trim();
    return await fetch(api, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(api.includes("openrouter.ai") ? {
          "HTTP-Referer": "https://nolo.chat",
          "X-Title": "nolo"
        } : {})
      },
      body: JSON.stringify(bodyData),
      signal, // 可选参数，直接传递
    });
  } catch (error: any) {
    console.error("[fetchDirectly] 网络请求失败:", error);
    throw error; // 抛出错误，交给上层处理
  }
};

const fetchWithServerProxy = async ({
  currentServer,
  api,
  bodyData,
  agentConfig,
  token,
  signal,
}: FetchParams): Promise<Response> => {
  try {
    const payload = buildProxyPayload(bodyData, api, agentConfig);
    return await performServerProxyFetchWithRetry({
      signal,
      execute: () =>
        fetch(`${currentServer}${API_ENDPOINTS.CHAT}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`, // 使用 Authorization 头传递 token
          },
          body: JSON.stringify(payload),
          signal,
        }),
    });
  } catch (error: any) {
    console.error("[fetchWithServerProxy] 网络请求失败:", error);
    throw error; // 抛出错误，交给上层处理
  }
};
export const performFetchRequest = async (
  params: FetchParams
): Promise<Response> => {
  try {
    // Preserve the old shouldUseServerProxy(agentConfig, bodyData.provider)
    // request-provider override semantics.
    const planConfig = {
      ...params.agentConfig,
      provider: params.bodyData.provider || params.agentConfig.provider,
    };
    return resolveAgentCallPlan(planConfig as any, {}).transport ===
      "server-proxy"
      ? await fetchWithServerProxy(params)
      : await fetchDirectly(params);
  } catch (error: any) {
    console.error("[performFetchRequest] 请求过程中发生错误:", error);
    // 如果是网络错误，抛出自定义错误对象，以便上层捕获
    throw new Error(`网络请求失败: ${error.message || String(error)}`);
  }
};

// SSE 流式请求参数（与 native 版本保持一致的接口）
interface SSEFetchParams extends FetchParams {
  onChunk: (chunk: string) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

/**
 * Web 版流式 SSE 请求 - 占位函数
 * Web 版不使用此函数，而是使用 performFetchRequest + ReadableStream
 * 此函数仅为类型兼容而存在
 */
export const performSSEFetchRequest = (_params: SSEFetchParams): (() => void) => {
  throw new Error('performSSEFetchRequest should not be called on web platform');
};

/**
 * 标识当前是否为 React Native 环境
 * Web 版返回 false
 */
export const isNativeSSE = false;
