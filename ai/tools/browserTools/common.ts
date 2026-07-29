import { callToolApi } from "../toolApiClient";

/**
 * 调用统一的后端浏览器工具API端点。
 * @param toolName - 要调用的工具名称 (例如 'browser_openSession')。
 * @param parameters - 传递给工具的参数。
 * @param thunkApi - Redux Thunk API。
 * @returns 后端返回的执行结果。
 */
export async function executeBrowserTool(
  toolName: string,
  parameters: any,
  thunkApi: any
): Promise<any> {
  try {
    const result = await callToolApi<{ data: any }>(
      thunkApi,
      "/api/browser-tool",
      { toolName, params: parameters },
      { withAuth: true }
    );
    return result.data;
  } catch (error: any) {
    console.error(`执行浏览器工具 '${toolName}' 时发生网络或解析错误:`, error);
    throw new Error(`浏览器工具 '${toolName}' 失败: ${error.message}`);
  }
}
