// 文件路径: ai/tools/apifyActorClient.ts

import { callToolApi } from "./toolApiClient";

export type ApifyResultType = "datasetItems" | "run" | "kvOutput";

export interface CallApifyActorParams {
  actorId: string; // 如 "apify~website-content-crawler"
  input: any;      // 直接给 Apify 的 inputSchema
  resultType?: ApifyResultType; // 默认 "datasetItems"
  displayName?: string; // 用于 UI 提示用的名字，如 "YouTube Scraper"
}

/**
 * 通用的 Apify Actor 调用封装。
 * 所有具体 scraping 工具都通过它调用后端 /api/apify-actor。
 */
export async function callApifyActor(
  thunkApi: any,
  params: CallApifyActorParams
): Promise<{ rawData: any; displayData: string }> {
  const { actorId, input, resultType = "datasetItems", displayName } = params;

  const data = await callToolApi(
    thunkApi,
    "/api/apify-actor",
    { actorId, input, resultType },
    { withAuth: true }
  );

  const isArray = Array.isArray(data);
  const count = isArray ? data.length : undefined;

  const title = displayName || actorId;
  const preview =
    typeof data === "string"
      ? data.slice(0, 400)
      : JSON.stringify(isArray ? data[0] : data, null, 2).slice(0, 800);

  return {
    rawData: data,
    displayData: `✅ ${title} 调用成功${typeof count === "number" ? `，返回 ${count} 条记录` : ""
      }\n\n**结果预览：**\n${preview}`,
  };
}