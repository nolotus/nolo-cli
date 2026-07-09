// 文件路径: ai/tools/readTool.ts

import { readAction } from "../../database/actions/read";
import { readAndWaitAction } from "../../database/actions/readAndWait";
import { slateToSimplifiedMarkdown } from "../../create/editor/transforms/slateToSimplifiedMarkdown";
import type { PageData } from "../../render/page/types";
import { getRuntimeServerContext } from "../../database/runtimeServerContext";
import { isTableMetaKey, rowKey, isAgentKey } from "../../database/keys";
import { DataType } from "../../create/types";
import { TableMeta } from "../../render/table/types";
import { fetchAndSerializeTable } from "../../render/table/utils/tableSerialization";
import { readFileFunc } from "./readFileTool";

// ---- Types ----

export type ReadArgs = {
  /**
   * 对应 database 的 dbKey
   */
  dbKey: string;

  /**
   * 是否等待远程结果：
   * - false（默认）：使用 readAction，本地优先，远程在后台同步
   * - true：使用 readAndWaitAction，等待远程与本地决策后返回“权威”结果
   */
  waitRemote?: boolean;

  /**
   * Backward-compatible escape hatch for models that call read with a local
   * file path even when the readFile tool is available.
   */
  filePath?: string;
  path?: string;
};

// ---- 工具 Schema，供 LLM 调用 ----

export const readFunctionSchema = {
  name: "read",
  description: [
    "根据指定的 dbKey 从本地/远程数据库读取一条记录。",
    "支持所有内容类型：",
    "- page-xxx：页面内容（返回 Markdown）",
    "- dialog-xxx：对话历史（返回消息列表）",
    "- agent-xxx：Agent 配置",
    "- table-xxx：表格数据",
    "- space-xxx：Space 完整数据（含分类和内容目录）",
    "行为说明：",
    "- 默认本地优先：若本地存在则立即返回，后台同步远程；",
    "- waitRemote=true：等待远程权威结果后返回（适合需要最新数据的场景）。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      dbKey: {
        type: "string",
        description: "要读取的数据键，例如 PAGE-xxx、dialog-xxx、agent-xxx、space-xxx。",
      },
      waitRemote: {
        type: "boolean",
        description:
          "是否等待远程结果。false=本地优先并在后台同步远程；true=等待远程与本地决策后返回。",
        default: false,
      },
    },
    required: ["dbKey"],
  },
};

// ---- 执行函数 ----

export async function readFunc(
  args: ReadArgs,
  thunkApi: any,
  context?: { parentMessageId?: string; signal?: AbortSignal; toolRunId?: string; agentKey?: string; userInput?: string }
): Promise<{ rawData: any; displayData?: string }> {
  const { dbKey, waitRemote = false } = args || {};
  const localFilePath =
    typeof args?.filePath === "string"
      ? args.filePath
      : typeof args?.path === "string"
        ? args.path
        : "";

  if (!dbKey && localFilePath) {
    const result = await readFileFunc(
      {
        filePath: localFilePath,
        startLine: (args as any).startLine,
        endLine: (args as any).endLine,
      },
      thunkApi,
      context
    );
    return {
      rawData: result,
      displayData:
        typeof result === "string" ? result : JSON.stringify(result, null, 2),
    };
  }

  if (!dbKey || typeof dbKey !== "string") {
    throw new Error("read 工具需要提供字符串类型的 id（dbKey）。");
  }

  try {
    const signal = context?.signal;

    const result = waitRemote
      ? await readAndWaitAction(dbKey, thunkApi)
      : await readAction({ dbKey, signal }, thunkApi);

    if (!result) {
      throw new Error(`未找到 dbKey 为 ${dbKey} 的数据。`);
    }

    // 智能化处理：如果是页面，自动转 Markdown
    if (dbKey.startsWith("PAGE-") || (result as any).type === DataType.DOC) {
      const pageData = result as PageData;
      const markdownContent = slateToSimplifiedMarkdown(pageData.slateData || []);

      return {
        rawData: {
          ...pageData,
          content: markdownContent, // 附加转换后的内容
        },
        displayData: `已成功读取页面《${pageData.title}》。\n\n内容预览：\n\n${markdownContent}`,
      };
    }

    // 智能化处理：如果是表格，自动转 Markdown
    if (isTableMetaKey(dbKey) || (result as any).type === DataType.TABLE) {
      const tableMeta = result as TableMeta;
      const title = tableMeta.displayName || `Table (${tableMeta.tableId})`;

      // Use shared utility
      const { rows, markdown: tableMd } = await thunkApi.dispatch(
        async (_dispatch: any, getState: any, { db }: any) => {
          const state = getState();
          const { currentToken: token, remoteServers } =
            getRuntimeServerContext(state);

          return await fetchAndSerializeTable(tableMeta, db, {
            token,
            remoteServers,
          });
        }
      );

      return {
        rawData: {
          ...tableMeta,
          rows,
          markdown: tableMd,
        },
        displayData: `已成功读取表格《${title}》。共 ${rows.length} 行数据。\n\n内容预览：\n\n${tableMd}`,
      };
    }

    // 智能化处理：如果是 Agent/Cybot，显示基本信息
    if (
      isAgentKey(dbKey) ||
      (result as any).type === DataType.AGENT ||
      (result as any).type === DataType.CYBOT
    ) {
      const agent = result as any;
      const name = agent.name || "未命名 Agent";
      const desc = agent.introduction || agent.description || "无描述";
      const modelInfo = agent.model ? ` (模型: ${agent.model})` : "";

      return {
        rawData: agent,
        displayData: `已成功读取 Agent《${name}》${modelInfo}。\n\n描述：${desc}\n提示词预览：\n${agent.prompt?.slice(0, 200) || "无"
          }...`,
      };
    }

    const sourceLabel = waitRemote
      ? "已等待远程与本地完成后返回权威结果"
      : "本地优先，已触发后台与远程同步";


    return {
      rawData: result,
      displayData: `已读取数据: "${result.dbKey}"（${sourceLabel}）`,
    };
  } catch (error: any) {
    console.error("执行 read 工具时发生错误:", error);
    throw new Error(
      `读取数据 (${dbKey}) 失败：${error?.message || String(error)}`
    );
  }
}
