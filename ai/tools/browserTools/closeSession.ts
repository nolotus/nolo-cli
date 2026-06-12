import { executeBrowserTool } from "./common";

export const browser_closeSession_Schema = {
  name: "browser_closeSession",
  description:
    "关闭一个已有的浏览器会话并释放服务器上的浏览器槽位。完成页面操作后应尽快调用。",
  parameters: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "由 browser_openSession 返回的活跃会话 ID。",
      },
    },
    required: ["sessionId"],
  },
};

export async function browser_closeSession_Func(
  args: { sessionId: string },
  thunkApi: any
) {
  const result = await executeBrowserTool("browser_closeSession", args, thunkApi);

  return {
    rawData: result.status,
    displayData: `✅ 已关闭浏览器会话 ${args.sessionId}。`,
  };
}
