// ai/tools/delayTool.ts

export const delayFunctionSchema = {
  name: "delay",
  description:
    "让计划暂停一小段时间（毫秒），用于节流批量操作（例如连续下载多个文件）。",
  parameters: {
    type: "object",
    properties: {
      ms: {
        type: "integer",
        description: "需要等待的时间（毫秒），建议 200~1000 之间。",
      },
    },
    required: ["ms"],
  },
};

export async function delayFunc(
  args: { ms: number },
  _thunkApi: any
): Promise<{ rawData: object; displayData: string }> {
  const ms = typeof args.ms === "number" && args.ms > 0 ? args.ms : 200;

  await new Promise<void>((resolve) => setTimeout(resolve, ms));

  const rawData = { success: true, ms };
  const displayData = `已等待 ${ms} 毫秒，继续执行后续步骤。`;

  return { rawData, displayData };
}
