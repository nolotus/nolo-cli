import { convertMarxistsBookToOfflineHtml } from "./marxistsOfflineBook";

export const convertMarxistsBookToOfflineHtmlFunctionSchema = {
  name: "convertMarxistsBookToOfflineHtml",
  description:
    "将 Marxists.org 中文旧式书籍页面转换成离线单 HTML。会从章节 URL 推导目录页，下载同目录章节、CSS 和背景图，保留原始排版并内嵌资源，适合 iPad/移动设备离线阅读。",
  parameters: {
    type: "object",
    properties: {
      startUrl: {
        type: "string",
        description:
          "任意一个 Marxists.org 中文书籍章节 URL，例如 https://www.marxists.org/chinese/fromm/1973/01.htm。",
      },
      encoding: {
        type: "string",
        description: "源站 HTML/CSS 编码，老中文页面通常是 gb2312。默认 gb2312。",
        default: "gb2312",
      },
      outputMode: {
        type: "string",
        enum: ["summary", "html"],
        description:
          "summary 只返回元数据和文件引用；html 同时返回完整 HTML 字符串。需要直接拿到文件内容时用 html。",
        default: "summary",
      },
      singleFileName: {
        type: "string",
        description:
          "生成文件建议名称，默认根据书名或 URL 生成；server-side agent 可用它作为保存文件名。",
      },
      maxPages: {
        type: "number",
        description: "最多允许抓取的同目录章节页数量，默认 80，防止误抓整个站点。",
        default: 80,
      },
      saveAsFile: {
        type: "boolean",
        description:
          "server-side agent 可设为 true，将 HTML 保存为 Nolo 文件并返回下载 URL；如果只需要 HTML 字符串，可设为 false。",
        default: true,
      },
    },
    required: ["startUrl"],
  },
};

export type ConvertMarxistsBookToolArgs = {
  startUrl: string;
  encoding?: string;
  outputMode?: "summary" | "html";
  singleFileName?: string;
  maxPages?: number;
  saveAsFile?: boolean;
};

export async function convertMarxistsBookToOfflineHtmlFunc(
  args: ConvertMarxistsBookToolArgs,
): Promise<{ rawData: Record<string, unknown>; displayData: string }> {
  const result = await convertMarxistsBookToOfflineHtml({
    startUrl: args.startUrl,
    encoding: args.encoding,
    maxPages: args.maxPages,
  });

  const rawData: Record<string, unknown> = {
    title: result.title,
    startUrl: result.startUrl,
    indexUrl: result.indexUrl,
    stylesheetUrl: result.stylesheetUrl,
    pages: result.pages,
    validation: result.validation,
    fileName: args.singleFileName,
  };
  if (args.outputMode === "html") {
    rawData.html = result.html;
  }

  return {
    rawData,
    displayData: formatMarxistsOfflineBookDisplayData({
      ...rawData,
      htmlIncluded: args.outputMode === "html",
    }),
  };
}

export function formatMarxistsOfflineBookDisplayData(data: Record<string, unknown>): string {
  const validation = (data.validation ?? {}) as any;
  const pages = Array.isArray(data.pages) ? data.pages : [];
  return [
    "✅ 已生成离线 HTML",
    `书名：${data.title || "未知"}`,
    `章节数：${validation.pageCount ?? pages.length}`,
    `大小：${validation.byteLength ?? "未知"} bytes`,
    `资源内嵌：${validation.hasEmbeddedAssets ? "是" : "否"}`,
    `残留网络 URL：${validation.hasNetworkUrls ? "是" : "否"}`,
    data.fileUrl ? `文件：${data.fileUrl}` : undefined,
    data.htmlIncluded ? "已在 rawData.html 返回完整 HTML。" : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}
