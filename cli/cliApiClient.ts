import { resolveServerUrl } from "./cliEnvHelpers";
import { requireTokenUser } from "./docCommandShared";
import type { EnvLike } from "./cliEnvHelpers";

/**
 * 通用 CLI→server JSON API 请求工具。
 * 封装 fetch + Bearer 鉴权 + JSON body + success 校验 + 错误抛出。
 * 可被任意 CLI 命令复用，不限于 app 命令组。
 */

export class CliApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface CliApiRequestArgs {
  serverUrl: string;
  authToken: string;
  path: string;
  method?: string;
  body?: Record<string, unknown> | null;
  query?: Record<string, string>;
}

/**
 * 发起一个带鉴权的 JSON API 请求，返回 success=true 的响应体。
 * 非 success 或网络错误时抛 CliApiError。
 */
export async function cliApiRequest(args: CliApiRequestArgs): Promise<Record<string, unknown>> {
  const method = args.method ?? "POST";
  let url = `${args.serverUrl.replace(/\/$/, "")}${args.path}`;
  if (args.query) {
    const params = new URLSearchParams(args.query);
    url += `?${params.toString()}`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${args.authToken}`,
  };

  const init: RequestInit = { method, headers };
  if (args.body !== undefined && args.body !== null && method !== "GET") {
    init.body = JSON.stringify(args.body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new CliApiError(`请求失败: ${(error as Error).message}`, "NETWORK_ERROR", 0);
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new CliApiError(
      `服务端返回非 JSON 响应 (HTTP ${response.status})`,
      "INVALID_RESPONSE",
      response.status,
    );
  }

  if (!response.ok || data.success !== true) {
    const errorObj = (data.error ?? {}) as Record<string, unknown>;
    const message =
      (errorObj.message as string) ||
      (data.message as string) ||
      `请求失败 (HTTP ${response.status})`;
    const code = (errorObj.code as string) || `HTTP_${response.status}`;
    throw new CliApiError(message, code, response.status);
  }

  return data;
}

/**
 * 统一打印 CLI 命令的错误到 stderr。
 */
export function printCliError(error: unknown): void {
  if (error instanceof CliApiError) {
    process.stderr.write(`错误 [${error.code}]: ${error.message}\n`);
  } else if (error instanceof Error) {
    process.stderr.write(`错误: ${error.message}\n`);
  } else {
    process.stderr.write(`错误: ${String(error)}\n`);
  }
}

/**
 * 从 args + env 解析出 { serverUrl, authToken, userId }。
 * 所有 CLI 命令共用的鉴权前置步骤。
 */
export function resolveCliContext(args: string[], env: EnvLike): {
  serverUrl: string;
  authToken: string;
  userId: string;
} {
  const serverUrl = resolveServerUrl(args, env);
  const { authToken, userId } = requireTokenUser(args, env, false);
  return { serverUrl, authToken, userId };
}