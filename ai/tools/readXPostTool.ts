import { createXReadFailure } from "../../integrations/x-reader/types";
import type { XPost, XReadResult } from "../../integrations/x-reader/types";
import { getRequestConfig, ToolApiError } from "./toolApiClient";

export const readXPostFunctionSchema = {
  name: "read_x_post",
  description:
    "读取 X/Twitter status 链接的可见帖子正文、作者和结构化数据。适合用户给出 x.com/twitter.com 帖子链接并要求查看、总结、解释或抽取信息的场景。默认通过桌面本地 Chrome/CDP bridge 读取，不要求用户粘贴 cookie 或 token。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "要读取的 X/Twitter status URL，例如 https://x.com/user/status/123。",
      },
      keepOpen: {
        type: "boolean",
        description: "调试时是否保留临时 Chrome bridge。默认 false。",
        default: false,
      },
      profileDir: {
        type: "string",
        description:
          "桌面端本地 Chrome 专用 profile 目录。用于让用户在本机登录一次 X 后复用本地账号状态；不要传入用户日常 Chrome profile。",
      },
      headless: {
        type: "boolean",
        description:
          "是否用 headless 模式启动本地 Chrome。需要用户首次登录本地 X profile 时设为 false 并配合 keepOpen。",
        default: true,
      },
    },
    required: ["url"],
  },
};

type ReadXPostToolContext = {
  reader?: (
    url: string,
    args: { keepOpen?: boolean; profileDir?: string; headless?: boolean },
  ) => Promise<XReadResult<XPost>>;
};

async function callLocalReadXPostApi(
  thunkApi: any,
  body: object,
): Promise<XReadResult<XPost>> {
  const { currentServer, token } = getRequestConfig(thunkApi);
  const browserOrigin = (globalThis as any).window?.location?.origin;
  const baseUrl = typeof browserOrigin === "string" && browserOrigin
    ? browserOrigin
    : currentServer.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}/api/read-x-post`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new ToolApiError(
      data?.error?.message ?? `read_x_post API 请求失败，状态码: ${response.status}`,
      {
        status: response.status,
        code: data?.error?.code,
        details: data,
      },
    );
  }
  return data as XReadResult<XPost>;
}

async function callDesktopReadXPostApi(
  thunkApi: any,
  body: object,
): Promise<XReadResult<XPost>> {
  const { token } = getRequestConfig(thunkApi);
  const port = Number(process.env.NOLO_DESKTOP_SERVER_PORT ?? 3233);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`http://127.0.0.1:${port}/api/read-x-post`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new ToolApiError(
      data?.error?.message ?? `desktop read_x_post API 请求失败，状态码: ${response.status}`,
      {
        status: response.status,
        code: data?.error?.code,
        details: data,
      },
    );
  }
  return data as XReadResult<XPost>;
}

async function readWithDefaultBridge(
  url: string,
  args: { keepOpen?: boolean; profileDir?: string; headless?: boolean },
  thunkApi?: any,
): Promise<XReadResult<XPost>> {
  if (process.env.PLATFORM === "web") {
    if (thunkApi?.getState) {
      return callLocalReadXPostApi(thunkApi, { url, ...args });
    }

    if (typeof window !== "undefined" && (window as any).__NOLO_DESKTOP__) {
      try {
        const res = await fetch("/api/read-x-post", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, ...args }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data) {
          return data as XReadResult<XPost>;
        }
        return createXReadFailure({
          code: "network_error",
          message: `desktop read_x_post endpoint failed: HTTP ${res.status}`,
          nextStep: "请确认桌面端本地服务仍在运行，然后重试。",
          backend: "desktop_local_browser",
        });
      } catch (error) {
        return createXReadFailure({
          code: "network_error",
          message:
            error instanceof Error
              ? error.message
              : "desktop read_x_post endpoint request failed",
          nextStep: "请确认桌面端本地服务仍在运行，然后重试。",
          backend: "desktop_local_browser",
        });
      }
    }

    return createXReadFailure({
      code: "not_connected",
      message: "read_x_post 需要通过服务器或桌面本地 bridge 执行，不能在普通浏览器 bundle 内直接启动 Chrome/CDP。",
      nextStep: "请使用服务器 agent run 或桌面端本地 bridge 路径执行该工具。",
      backend: "desktop_local_browser",
    });
  }

  if (process.env.NOLO_DESKTOP === "1" && thunkApi?.getState) {
    return callDesktopReadXPostApi(thunkApi, { url, ...args });
  }

  const importBridge = new Function("specifier", "return import(specifier)") as <
    T = any,
  >(
    specifier: string,
  ) => Promise<T>;
  const { readXPostWithBridge } = await importBridge<{
    readXPostWithBridge: (
      url: string,
      args: { keepOpen?: boolean; profileDir?: string; headless?: boolean },
    ) => Promise<XReadResult<XPost>>;
  }>("../../integrations/x-reader/bridge/readXPostWithBridge.ts");
  return readXPostWithBridge(url, args);
}

function assertXStatusUrl(url: string) {
  if (!/^https?:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+/i.test(url)) {
    throw new Error("read_x_post 需要一个有效的 X/Twitter status URL。");
  }
}

function formatDisplay(result: XReadResult<XPost>) {
  if (!result.ok) {
    return [
      `读取 X 帖子失败：${result.message}`,
      `失败代码：${result.code}`,
      result.nextStep ? `下一步：${result.nextStep}` : "",
      `后端：${result.backend}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const post = result.data;
  return [
    `已读取 X 帖子：@${post.author.handle}${post.author.displayName ? `（${post.author.displayName}）` : ""}`,
    `URL: ${post.url}`,
    `后端：${result.backend}`,
    "",
    post.text,
  ].join("\n");
}

export async function readXPostFunc(
  args: { url: string; keepOpen?: boolean; profileDir?: string; headless?: boolean },
  thunkApi: any,
  context: ReadXPostToolContext = {},
): Promise<{ rawData: XReadResult<XPost>; displayData: string }> {
  const url = String(args?.url ?? "").trim();
  assertXStatusUrl(url);

  const keepOpen = Boolean(args?.keepOpen);
  const profileDir = String(args?.profileDir ?? "").trim() || undefined;
  const headless = args?.headless;
  const rawData =
    (await context.reader?.(url, { keepOpen, profileDir, headless })) ??
    (await readWithDefaultBridge(url, { keepOpen, profileDir, headless }, thunkApi));

  return {
    rawData,
    displayData: formatDisplay(rawData),
  };
}
