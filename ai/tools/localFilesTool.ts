import {
  buildToolRequestHeaders,
  getRequestConfig,
  resolveToolApiBaseUrl,
} from "./toolApiClient";

export type LocalFileOperation = {
  kind: "mkdir" | "move" | "rename" | "writeText" | "deleteToTrash";
  sourceRelativePath?: string;
  destinationRelativePath?: string;
  content?: string;
  reason: string;
  conflictPolicy: "skip" | "overwrite" | "rename";
};

type ToolResult = {
  rawData: any;
  displayData?: string;
};

type LocalFilesDeps = {
  getBaseUrl?: (thunkApi: any) => string;
  fetchImpl?: typeof fetch;
};

export const listLocalRootsFunctionSchema = {
  name: "listLocalRoots",
  description: "列出当前桌面客户端里已经授权的本地文件夹 roots，供后续的本地文件读取和整理工具使用。",
  parameters: {
    type: "object",
    properties: {},
  },
};

export const requestLocalFolderAccessFunctionSchema = {
  name: "requestLocalFolderAccess",
  description: "为桌面客户端请求授权一个本地文件夹。传入绝对路径后，返回可供后续 listLocalFiles/readLocalFile 使用的 rootId。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "要授权的本地文件夹绝对路径，例如 /Users/me/Desktop 或 C:\\Users\\me\\Downloads。" },
      label: { type: "string", description: "可选的人类可读名称，例如 Desktop、Downloads、Project Root。" },
      id: { type: "string", description: "可选的 rootId；如果省略则由桌面端生成。" },
    },
    required: ["path"],
  },
};

export const listLocalFilesFunctionSchema = {
  name: "listLocalFiles",
  description: "列出桌面客户端中用户已授权本地文件夹内的文件和目录。只能访问已授权根目录内的相对路径。",
  parameters: {
    type: "object",
    properties: {
      rootId: { type: "string", description: "已授权的本地文件夹 ID。" },
      relativePath: { type: "string", description: "相对已授权根目录的路径，例如 . 或 Documents。" },
    },
    required: ["rootId"],
  },
};

export const readLocalFileFunctionSchema = {
  name: "readLocalFile",
  description: "读取桌面客户端中用户已授权本地文件夹内的文本文件。路径必须是授权根目录内的相对路径。",
  parameters: {
    type: "object",
    properties: {
      rootId: { type: "string", description: "已授权的本地文件夹 ID。" },
      relativePath: { type: "string", description: "相对已授权根目录的文本文件路径。" },
    },
    required: ["rootId", "relativePath"],
  },
};

export const proposeLocalFileChangesFunctionSchema = {
  name: "proposeLocalFileChanges",
  description: "为用户已授权的本地文件夹创建整理计划。该工具只创建待确认计划，不会直接修改本地文件。",
  parameters: {
    type: "object",
    properties: {
      rootId: { type: "string", description: "已授权的本地文件夹 ID。" },
      summary: { type: "string", description: "本次整理计划摘要。" },
      operations: {
        type: "array",
        description: "待执行的文件操作列表。",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["mkdir", "move", "rename", "writeText", "deleteToTrash"] },
            sourceRelativePath: { type: "string" },
            destinationRelativePath: { type: "string" },
            content: { type: "string" },
            reason: { type: "string" },
            conflictPolicy: { type: "string", enum: ["skip", "overwrite", "rename"] },
          },
          required: ["kind", "reason", "conflictPolicy"],
        },
      },
      riskLevel: { type: "string", enum: ["low", "medium", "high"] },
    },
    required: ["rootId", "summary", "operations"],
  },
};

export const executeApprovedLocalFileChangesFunctionSchema = {
  name: "executeApprovedLocalFileChanges",
  description: "执行用户已经确认的本地文件整理计划。必须传入 proposeLocalFileChanges 返回的 planId。",
  parameters: {
    type: "object",
    properties: {
      planId: { type: "string", description: "已确认计划的 ID。" },
    },
    required: ["planId"],
  },
};

export const undoLocalFileChangeBatchFunctionSchema = {
  name: "undoLocalFileChangeBatch",
  description: "撤销一个本地文件整理批次中可撤销的移动或重命名操作。",
  parameters: {
    type: "object",
    properties: {
      batchId: { type: "string", description: "执行历史批次 ID。" },
    },
    required: ["batchId"],
  },
};

export function createLocalFilesToolHandlers(deps: LocalFilesDeps = {}) {
  const resolveUrl = (thunkApi: any, path: string) => {
    const { currentServer } = getRequestConfig(thunkApi);
    const baseUrl = resolveToolApiBaseUrl(currentServer, path);
    if (!baseUrl) throw new Error("无法获取工具服务器地址。");
    return `${baseUrl.replace(/\/+$/, "")}${path}`;
  };

  const request = async (
    thunkApi: any,
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal
  ) => {
    const url = deps.getBaseUrl
      ? `${deps.getBaseUrl(thunkApi).replace(/\/+$/, "")}${path}`
      : resolveUrl(thunkApi, path);
    const headers = new Headers(buildToolRequestHeaders(thunkApi, { withAuth: true }));
    const initHeaders = new Headers(init.headers);
    initHeaders.forEach((value, key) => headers.set(key, value));
    const response = await (deps.fetchImpl ?? fetch)(url, {
      ...init,
      headers,
      signal,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok || data?.ok === false || data?.error) {
      throw new Error(data?.error || `desktop files bridge failed: ${response.status}`);
    }
    return data;
  };

  const post = async (thunkApi: any, path: string, body: object, signal?: AbortSignal) => {
    return request(thunkApi, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, signal);
  };

  return {
    async listRoots(_args: Record<string, never>, thunkApi: any, context?: { signal?: AbortSignal }): Promise<ToolResult> {
      const data = await request(thunkApi, "/api/desktop/files/roots", {
        method: "GET",
      }, context?.signal);
      const rootCount = Array.isArray(data?.roots) ? data.roots.length : 0;
      return {
        rawData: data,
        displayData: `已列出已授权本地文件夹 roots（${rootCount} 个）`,
      };
    },

    async requestRoot(args: { path: string; label?: string; id?: string }, thunkApi: any, context?: { signal?: AbortSignal }): Promise<ToolResult> {
      requireString(args.path, "path");
      const body: Record<string, string> = { path: args.path };
      if (typeof args.label === "string" && args.label.trim()) body.label = args.label.trim();
      if (typeof args.id === "string" && args.id.trim()) body.id = args.id.trim();
      const data = await post(thunkApi, "/api/desktop/files/roots/request", body, context?.signal);
      return {
        rawData: data,
        displayData: `已授权本地文件夹: ${data?.root?.label || args.label || args.path}`,
      };
    },

    async list(args: { rootId: string; relativePath?: string }, thunkApi: any, context?: { signal?: AbortSignal }): Promise<ToolResult> {
      requireString(args.rootId, "rootId");
      const data = await post(thunkApi, "/api/desktop/files/list", {
        rootId: args.rootId,
        relativePath: args.relativePath || ".",
      }, context?.signal);
      return {
        rawData: data,
        displayData: `已列出本地文件: ${args.relativePath || "."}`,
      };
    },

    async read(args: { rootId: string; relativePath: string }, thunkApi: any, context?: { signal?: AbortSignal }): Promise<ToolResult> {
      requireString(args.rootId, "rootId");
      requireString(args.relativePath, "relativePath");
      const data = await post(thunkApi, "/api/desktop/files/read", args, context?.signal);
      return {
        rawData: data,
        displayData: `已读取本地文件: ${args.relativePath}`,
      };
    },

    async propose(args: { rootId: string; summary: string; operations: LocalFileOperation[]; riskLevel?: "low" | "medium" | "high" }, thunkApi: any, context?: { signal?: AbortSignal }): Promise<ToolResult> {
      requireString(args.rootId, "rootId");
      requireString(args.summary, "summary");
      if (!Array.isArray(args.operations) || args.operations.length === 0) {
        throw new Error("operations 不能为空。");
      }
      const data = await post(thunkApi, "/api/desktop/files/plan", args, context?.signal);
      return {
        rawData: data,
        displayData: `已创建本地文件整理计划，等待确认: ${args.summary}`,
      };
    },

    async proposePreview(args: { rootId: string; summary: string; operations: LocalFileOperation[] }): Promise<ToolResult> {
      return {
        rawData: {
          previewOnly: true,
          rootId: args.rootId,
          summary: args.summary,
          operations: args.operations,
        },
        displayData: `待确认本地文件整理计划: ${args.summary}（${args.operations?.length ?? 0} 项）`,
      };
    },

    async execute(args: { planId: string }, thunkApi: any, context?: { signal?: AbortSignal }): Promise<ToolResult> {
      requireString(args.planId, "planId");
      const data = await post(thunkApi, "/api/desktop/files/execute", args, context?.signal);
      return {
        rawData: data,
        displayData: `已执行本地文件整理计划: ${args.planId}`,
      };
    },

    async undo(args: { batchId: string }, thunkApi: any, context?: { signal?: AbortSignal }): Promise<ToolResult> {
      requireString(args.batchId, "batchId");
      const data = await post(thunkApi, "/api/desktop/files/undo", args, context?.signal);
      return {
        rawData: data,
        displayData: `已撤销本地文件整理批次: ${args.batchId}`,
      };
    },
  };
}

function requireString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} 必须是非空字符串。`);
  }
}

const defaultHandlers = createLocalFilesToolHandlers();

export const listLocalRootsFunc = defaultHandlers.listRoots;
export const requestLocalFolderAccessFunc = defaultHandlers.requestRoot;
export const listLocalFilesFunc = defaultHandlers.list;
export const readLocalFileFunc = defaultHandlers.read;
export const proposeLocalFileChangesFunc = defaultHandlers.propose;
export const proposeLocalFileChangesPreviewFunc = defaultHandlers.proposePreview;
export const executeApprovedLocalFileChangesFunc = defaultHandlers.execute;
export const undoLocalFileChangeBatchFunc = defaultHandlers.undo;
