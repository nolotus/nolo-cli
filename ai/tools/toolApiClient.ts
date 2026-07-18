/**
 * toolApiClient.ts
 *
 * 所有 AI tool 调用后端 API 的统一工具模块。
 *
 * 解决的问题：
 * - 相对路径（如 "/api/xxx"）在 React Native 中无法解析。
 * - 多个 tool 文件中重复定义相同的 getRequestConfig / buildRequestHeaders 等辅助函数。
 *
 * 使用方式：
 *   const data = await callToolApi(thunkApi, "/api/exa-search", body);
 *   const data = await callToolApi(thunkApi, "/api/apify-actor", body, { withAuth: true });
 */

import { compactWhitespace } from "../../core/compactWhitespace";
import { isRecord } from "../../core/isRecord";
import { extractCustomId } from "../../core/prefix";
import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";

// ─────────────────────────────────────────────
// 基础提取：从 Redux state 中获取服务器配置
// ─────────────────────────────────────────────

export interface RequestConfig {
    currentServer: string;
    token: string | null;
}

export interface ToolRequestContext extends RequestConfig {
    baseUrl: string;
}

const MAIN_SERVER = "https://nolo.chat";

const getIsDesktopApp = (): boolean =>
    typeof window !== "undefined" && Boolean((window as any).__NOLO_DESKTOP__);

const isLocalServerUrl = (value?: string | null): boolean => {
    if (!value) return false;
    try {
        const hostname = new URL(value).hostname.toLowerCase();
        return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
        return false;
    }
};

const resolveDesktopSafeServer = (value?: string | null): string => {
    if (!getIsDesktopApp()) return value || MAIN_SERVER;
    return isLocalServerUrl(value) ? MAIN_SERVER : value || MAIN_SERVER;
};

const selectCurrentServerFromState = (state: any): string =>
    resolveDesktopSafeServer(state?.settings?.currentServer);

const selectCurrentTokenFromState = (state: any): string | null =>
    typeof state?.auth?.currentToken === "string" ? state.auth.currentToken : null;

const selectCurrentDialogKeyFromState = (state: any): string | null =>
    typeof state?.dialog?.currentDialogKey === "string" ? state.dialog.currentDialogKey : null;

export const resolveToolBaseUrl = (currentServer?: string | null): string => {
    const _window = (globalThis as any).window;
    if (!_window) return (currentServer || "").replace(/\/+$/, "");
    const fallbackLocal = _window.location.origin;
    if (!currentServer) return fallbackLocal;
    return currentServer.replace(/\/+$/, "");
};

const DESKTOP_LOCAL_TOOL_PATHS = new Set([
    "/api/exec-shell",
    "/api/check-env",
    "/api/read-file",
    "/api/write-file",
    "/api/apply-edit",
    "/api/apply-line-edits",
    "/api/code-search",
    "/api/search-repo",
    "/api/desktop/files/roots",
    "/api/desktop/files/roots/request",
    "/api/desktop/files/list",
    "/api/desktop/files/read",
    "/api/desktop/files/plan",
    "/api/desktop/files/approve",
    "/api/desktop/files/execute",
    "/api/desktop/files/undo",
    "/api/desktop/files/history",
]);

const getWindowOrigin = (): string | null => {
    const _window = (globalThis as any).window;
    const origin = _window?.location?.origin;
    return typeof origin === "string" && origin ? origin.replace(/\/+$/, "") : null;
};

export const resolveToolApiBaseUrl = (
    currentServer?: string | null,
    path?: string
): string => {
    if (path && DESKTOP_LOCAL_TOOL_PATHS.has(path) && getIsDesktopApp()) {
        const localOrigin = getWindowOrigin();
        if (localOrigin) return localOrigin;
    }
    return resolveToolBaseUrl(currentServer);
};

export const getRequestConfig = (thunkApi: any): RequestConfig => {
    const state = thunkApi.getState();
    const currentServer = selectCurrentServerFromState(state);
    const token = selectCurrentTokenFromState(state);
    if (!currentServer) throw new Error("无法获取当前服务器地址。");
    return { currentServer, token };
};

export const getToolBaseUrl = (thunkApi: any): string => {
    const { currentServer } = getRequestConfig(thunkApi);
    const baseUrl = resolveToolBaseUrl(currentServer);
    if (!baseUrl) throw new Error("无法获取工具服务器地址。");
    return baseUrl;
};

export const getToolRequestContext = (thunkApi: any): ToolRequestContext => {
    const { currentServer, token } = getRequestConfig(thunkApi);
    const baseUrl = resolveToolBaseUrl(currentServer);
    if (!baseUrl) throw new Error("无法获取工具服务器地址。");
    return {
        currentServer,
        token,
        baseUrl,
    };
};

// ─────────────────────────────────────────────
// 统一 POST 请求入口
// ─────────────────────────────────────────────

export interface CallToolApiOptions {
    /** 是否在请求头中附带 Authorization token，默认 false */
    withAuth?: boolean;
    /** 生产受控 devtool 路由需要知道是哪一个 agent 在调用。 */
    agentKey?: string | null;
}

const maybeAttachDialogId = (thunkApi: any, body: object): object => {
    if (!isRecord(body)) return body;
    if ("dialogId" in body) return body;

    const state = thunkApi.getState();
    const currentDialogKey = selectCurrentDialogKeyFromState(state);
    const dialogId = currentDialogKey ? extractCustomId(currentDialogKey) : null;
    if (!dialogId) return body;

    return {
        ...body,
        dialogId,
    };
};

export class ToolApiError extends Error {
    status?: number;
    code?: string;
    details?: unknown;

    constructor(message: string, options?: { status?: number; code?: string; details?: unknown }) {
        super(message);
        this.name = "ToolApiError";
        this.status = options?.status;
        this.code = options?.code;
        this.details = options?.details;
    }
}

export const buildToolRequestHeaders = (
    thunkApi: any,
    options: CallToolApiOptions = {}
): Record<string, string> => {
    const { withAuth = false, agentKey } = options;
    const { token } = getRequestConfig(thunkApi);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (withAuth && token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    if (agentKey && typeof agentKey === "string" && agentKey.trim()) {
        headers["X-Nolo-Agent-Key"] = agentKey.trim();
    }
    if (typeof window !== "undefined" && (window as any).__NOLO_DESKTOP__) {
        headers["X-Nolo-Desktop-Tool"] = "1";
    }
    return headers;
};

const buildResponsePreview = (text: string): string =>
    compactWhitespace(text).slice(0, 240);

const looksLikeHtmlResponse = (text: string, contentType: string | null): boolean => {
    if (contentType?.toLowerCase().includes("text/html")) return true;
    const trimmed = asTrimmedLowercaseString(text);
    return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
};

/**
 * 向本项目后端发起 POST 请求的统一封装。
 * - 自动从 Redux state 中读取 currentServer，构建完整 URL（兼容 Web & RN）。
 * - 自动处理错误响应，抛出包含状态码和错误信息的 Error。
 *
 * @param thunkApi  Redux Thunk API
 * @param path      API 路径，如 "/api/exa-search"
 * @param body      请求体对象
 * @param options   选项：{ withAuth } 是否附带 token
 * @returns         解析后的 JSON 数据
 */
export async function callToolApi<T = any>(
    thunkApi: any,
    path: string,
    body: object,
    options: CallToolApiOptions = {}
): Promise<T> {
    const { currentServer } = getRequestConfig(thunkApi);

    const baseUrl = resolveToolApiBaseUrl(currentServer, path);
    if (!baseUrl) throw new Error("无法获取工具服务器地址。");
    const url = `${baseUrl}${path}`;
    const headers = buildToolRequestHeaders(thunkApi, options);

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(maybeAttachDialogId(thunkApi, body)),
    });

    const contentType = response.headers.get("content-type");
    const responseText = await response.text();

    if (!response.ok) {
        let errorMessage = `API 请求失败，状态码: ${response.status}`;
        let errorCode: string | undefined;
        let errorDetails: unknown;
        try {
            const errorData = JSON.parse(responseText) as Record<string, any>;
            const err = errorData?.error;
            if (err) {
                errorMessage += `: ${err.message ?? JSON.stringify(err)}`;
                errorCode = typeof err.code === "string" ? err.code : undefined;
                errorDetails = err.details;
            }
        } catch {
            errorCode = looksLikeHtmlResponse(responseText, contentType)
                ? "HTML_ERROR_RESPONSE"
                : "NON_JSON_ERROR_RESPONSE";
            errorDetails = {
                contentType,
                responsePreview: buildResponsePreview(responseText),
            };
            if (typeof (errorDetails as any).responsePreview === "string" && (errorDetails as any).responsePreview) {
                errorMessage += `: ${(errorDetails as any).responsePreview}`;
            }
        }
        throw new ToolApiError(errorMessage, {
            status: response.status,
            code: errorCode,
            details: errorDetails,
        });
    }

    try {
        return JSON.parse(responseText) as T;
    } catch {
        throw new ToolApiError("服务端返回了无法解析的非 JSON 响应", {
            status: response.status,
            code: looksLikeHtmlResponse(responseText, contentType)
                ? "HTML_RESPONSE"
                : "INVALID_JSON_RESPONSE",
            details: {
                contentType,
                responsePreview: buildResponsePreview(responseText),
            },
        });
    }
}
