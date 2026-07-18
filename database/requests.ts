// database/requests.ts
import { isAbortError } from "../core/abortError";
import { API_ENDPOINTS } from "./config";


export const TIMEOUT = 5000;

type RequestFailureLogLevel = "error" | "warn" | "info" | "silent";

const logRequestFailure = (
  level: RequestFailureLogLevel,
  message: string
) => {
  if (level === "silent") return;
  if (level === "warn") {
    console.warn(message);
    return;
  }
  if (level === "info") {
    console.info(message);
    return;
  }
  console.error(message);
};

/**
 * 通用的Nolo服务器请求函数
 * @param server 服务器地址
 * @param config 请求配置 (url, method, body)
 * @param state Redux state (用于获取token)
 * @param signal AbortSignal 用于取消请求
 * @returns Fetch Response Promise
 */
export const noloRequest = async (
  server: string,
  config: {
    url: string;
    method?: string;
    body?: string | FormData;
    headers?: HeadersInit;
    keepalive?: boolean;
  },
  state: any,
  signal?: AbortSignal
): Promise<Response> => {
  const headers: Record<string, string> = (config.headers as Record<string, string>) || {
    "Content-Type": "application/json",
  };
  // 从 state 中安全地获取 token
  const token = state?.auth?.currentToken;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  return fetch(server + config.url, {
    method: config.method || "GET",
    headers,
    body: config.body,
    signal, // 传递 AbortSignal
    ...(config.keepalive ? { keepalive: true } : {}),
  });
};

/**
 * 向单个服务器发送 PATCH 请求 (用于更新部分数据)
 * @param server 服务器地址
 * @param dbKey 数据键
 * @param updates 要更新的数据对象
 * @param state Redux state
 * @param signal AbortSignal
 * @returns Promise<boolean> 请求是否成功 (response.ok)
 */
export const noloPatchRequest = async (
  server: string,
  dbKey: string,
  updates: any,
  state: any,
  signal?: AbortSignal,
  options?: { failureLogLevel?: RequestFailureLogLevel }
): Promise<boolean> => {
  const failureLogLevel = options?.failureLogLevel ?? "error";
  try {
    const response = await noloRequest(
      server,
      {
        url: `${API_ENDPOINTS.DATABASE}/patch/${dbKey}`,
        method: "PATCH",
        body: JSON.stringify(updates),
      },
      state,
      signal
    );
    if (!response.ok) {
      logRequestFailure(
        failureLogLevel,
        `PATCH request failed for ${dbKey} on ${server}: HTTP ${response.status}`
      );
    }
    return response.ok;
  } catch (error: any) {
    if (!isAbortError(error)) {
      logRequestFailure(
        failureLogLevel,
        `PATCH request failed for ${dbKey} on ${server}: ${error.message || "Unknown error"}`
      );
    }
    // 对于 AbortError 或其他网络错误，返回 false
    return false;
  }
};

/**
 * 向单个服务器发送 POST 请求 (用于写入完整数据)
 * @param server 服务器地址
 * @param writeConfig 写入配置 { data, customKey, userId }
 * @param state Redux state
 * @param signal AbortSignal
 * @returns Promise<boolean> 请求是否成功 (response.ok)
 */
export const noloWriteRequest = async (
  server: string,
  writeConfig: { data: any; customKey: string; userId?: string; indexKeys?: string[] },
  state: any,
  signal?: AbortSignal,
  options?: { failureLogLevel?: RequestFailureLogLevel }
): Promise<boolean> => {
  const { data, customKey, userId, indexKeys } = writeConfig;
  const failureLogLevel = options?.failureLogLevel ?? "error";
  try {
    const response = await noloRequest(
      server,
      {
        url: `${API_ENDPOINTS.DATABASE}/write/`,
        method: "POST",
        body: JSON.stringify({ data, customKey, userId, indexKeys }),
      },
      state,
      signal
    );
    if (!response.ok) {
      logRequestFailure(
        failureLogLevel,
        `Write request failed for ${customKey} on ${server}: HTTP ${response.status}`
      );
    }
    return response.ok;
  } catch (error: any) {
    if (!isAbortError(error)) {
      logRequestFailure(
        failureLogLevel,
        `Write request failed for ${customKey} on ${server}: ${error.message || "Unknown error"}`
      );
    }
    // 对于 AbortError 或其他网络错误，返回 false
    return false;
  }
};

/**
 * 向单个服务器发送 POST 请求 (用于文件上传)
 * @param server 服务器地址
 * @param uploadConfig 上传配置 { file, metadata, customKey, userId }
 * @param state Redux state
 * @param signal AbortSignal
 * @returns Promise<boolean> 请求是否成功 (response.ok)
 */
export const noloUploadRequest = async (
  server: string,
  uploadConfig: {
    file: File;
    metadata: any;
    customKey: string;
    userId?: string;
  },
  state: any,
  signal?: AbortSignal
): Promise<boolean> => {
  const { file, metadata, customKey, userId } = uploadConfig;
  try {
    const isReactNative =
      typeof navigator !== "undefined" && (navigator as any).product === "ReactNative";
    const isRNFile = (f: any) => f && typeof f.uri === 'string' && typeof f.name === 'string' && typeof f.type === 'string';
    const normalizeBlobUtilPath = (uri: string): string =>
      uri.startsWith("file://") ? uri.slice("file://".length) : uri;

    if (isReactNative && isRNFile(file)) {
      const ReactNativeBlobUtil = (await import("react-native-blob-util")).default;
      const wrappedPath = ReactNativeBlobUtil.wrap(normalizeBlobUtilPath((file as any).uri));
      const token = state?.auth?.currentToken;
      const headers: Record<string, string> = {
        "Content-Type": "multipart/form-data",
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await ReactNativeBlobUtil.fetch(
        "POST",
        server + `${API_ENDPOINTS.DATABASE}/upload`,
        headers,
        [
          {
            name: "file",
            filename: (file as any).name,
            type: (file as any).type,
            data: wrappedPath,
          },
          { name: "metadata", data: JSON.stringify(metadata) },
          { name: "customKey", data: customKey },
          ...(userId ? [{ name: "userId", data: userId }] : []),
        ]
      );
      const status = response.info().status;
      const ok = status >= 200 && status < 300;

      if (!ok) {
        console.error(
          `Upload request failed for ${customKey} on ${server}: HTTP ${status}`
        );
      }

      return ok;
    }

    // 创建 FormData 对象，用于 multipart/form-data 请求
    const formData = new FormData();

    if (isRNFile(file)) {
      // RN 的 FormData append 允许传对象，但 TS 定义可能不匹配
      formData.append("file", {
        uri: (file as any).uri,
        type: (file as any).type,
        name: (file as any).name,
      } as any);
    } else {
      // Web 环境：直接 append File 对象
      formData.append("file", file);
    }

    formData.append("metadata", JSON.stringify(metadata)); // 添加文件元数据
    formData.append("customKey", customKey); // 添加自定义键
    if (userId) {
      formData.append("userId", userId); // 添加用户ID（如果有）
    }

    const response = await noloRequest(
      server,
      {
        url: `${API_ENDPOINTS.DATABASE}/upload`,
        method: "POST",
        body: formData as any, // Cast to any to avoid TS mismatch with Bun/DOM FormData
        headers: {}, // 不设置 Content-Type，让浏览器自动处理 multipart/form-data
      },
      state,
      signal
    );
    if (!response.ok) {
      console.error(
        `Upload request failed for ${customKey} on ${server}: HTTP ${response.status}`
      );
    }
    return response.ok;
  } catch (error: any) {
    if (!isAbortError(error)) {
      console.error(
        `Upload request failed for ${customKey} on ${server}: ${error.message || "Unknown error"}`
      );
    }
    // 对于 AbortError 或其他网络错误，返回 false
    return false;
  }
};

/**
 * 向单个服务器发送 GET 请求 (用于读取文件内容或元数据)
 * @param server 服务器地址
 * @param fileId 文件ID或自定义键
 * @param options 可选参数 { type: 'metadata' | 'content' }
 * @param state Redux state
 * @param signal AbortSignal
 * @returns Promise<{ success: boolean, data?: any }> 请求是否成功以及返回的数据
 */
export const noloReadFileRequest = async (
  server: string,
  fileId: string,
  options: {
    type?: "metadata" | "content"; // metadata: 只获取元数据, content: 获取文件内容
  } = { type: "metadata" },
  state: any,
  signal?: AbortSignal
): Promise<{ success: boolean; data?: any }> => {
  const { type = "metadata" } = options;

  try {
    // 根据类型构建 URL
    const url =
      type === "content"
        ? `${API_ENDPOINTS.DATABASE}/file/content/${fileId}`
        : `${API_ENDPOINTS.DATABASE}/file/metadata/${fileId}`;

    const response = await noloRequest(
      server,
      {
        url,
        method: "GET",
      },
      state,
      signal
    );

    if (!response.ok) {
      console.error(
        `Read file request failed for ${fileId} on ${server}: HTTP ${response.status}`
      );
      return { success: false };
    }

    // 根据类型处理响应数据
    let data;
    if (type === "content") {
      // 文件内容可能较大，建议以流式或 Blob 形式处理
      data = await response.blob(); // 以 Blob 形式返回文件内容
    } else {
      data = await response.json(); // 元数据以 JSON 形式返回
    }

    return { success: true, data };
  } catch (error: any) {
    if (!isAbortError(error)) {
      console.error(
        `Read file request failed for ${fileId} on ${server}: ${error.message || "Unknown error"}`
      );
    }
    return { success: false };
  }
};

/**
 * 通用的服务器同步函数，带有超时和错误处理
 * @param servers 服务器地址列表
 * @param requestFn 实际执行请求的函数 (应返回 Promise<boolean>)
 * @param errorMessage 失败时的错误消息前缀
 * @param requestArgs 传递给 requestFn 的额外参数 (除了 server 和 signal)
 */
export const syncWithServers = <TArgs extends any[]>(
  servers: string[],
  requestFn: (
    server: string,
    ...args: [...TArgs, AbortSignal?]
  ) => Promise<boolean>,
  errorMessage: string,
  ...requestArgs: TArgs
): void => {
  servers.forEach((server) => {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      // console.warn(`Request to ${server} timed out after ${TIMEOUT}ms`); // 可选：超时警告
      abortController.abort(); // 超时时中止请求
    }, TIMEOUT);

    // 执行请求函数
    requestFn(server, ...requestArgs, abortController.signal)
      .then((success) => {
        clearTimeout(timeoutId); // 清除超时定时器
        if (!success) {
          // 只在请求明确失败时提示（非超时）
          // 注意：noloPatchRequest/noloWriteRequest 内部已打印详细错误
          // 此处 toast 可考虑移除或改为更通用的后台同步失败提示
          // toast.error(`${errorMessage} ${server}`);
          console.warn(`${errorMessage} ${server}`); // 使用 console.warn 代替 toast
        }
      })
      .catch((error) => {
        clearTimeout(timeoutId); // 清除超时定时器
        // AbortError 通常由超时引起，已在 requestFn 中处理或此处忽略
        if (!isAbortError(error)) {
          console.error(
            `Unexpected error during sync with ${server}: ${error.message || "Unknown error"}`
          );
          // toast.error(`Sync failed with ${server}`); // 可选的通用失败提示
        }
      });
  });
};

/**
 * 向单个服务器发送 DELETE 请求
 * @param server 服务器地址
 * @param dbKey 数据键
 * @param options 可选参数 { type: 'messages' | 'single' }
 * @param state Redux state
 * @param signal AbortSignal
 * @returns Promise<boolean> 请求是否成功
 */
export const noloDeleteRequest = async (
  server: string,
  dbKey: string,
  options: {
    type?: "messages" | "single" | "table";
    force?: boolean;
  },
  state: any,
  signal?: AbortSignal
): Promise<boolean> => {
  const { type = "single", force = false } = options;

  try {
    // ponytail: force=true 给回收站物理擦除 tombstone 用；其它 type 行为不变。
    const queryParts: string[] = [];
    if (type === "messages") queryParts.push("type=messages");
    else if (type === "table") queryParts.push("type=table");
    if (force) queryParts.push("force=true");
    const query = queryParts.length ? `?${queryParts.join("&")}` : "";
    const url = `${API_ENDPOINTS.DATABASE}/delete/${dbKey}${query}`;

    const response = await noloRequest(
      server,
      {
        url,
        method: "DELETE",
        keepalive: true,
      },
      state,
      signal
    );

    if (!response.ok) {
      console.error(
        `DELETE request failed for ${dbKey} on ${server}: HTTP ${response.status}`
      );
      return false;
    }

    return true; // 请求成功
  } catch (error: any) {
    if (!isAbortError(error)) {
      console.error(
        `DELETE request failed for ${dbKey} on ${server}: ${error.message || "Unknown error"}`
      );
    }
    return false;
  }
};
