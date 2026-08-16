// /ai/tools/fetchWebpageTool.ts
// 现在底层走 Cloudflare Browser Rendering，支持 JS 动态渲染

import { callToolApi } from "./toolApiClient";
import {
  assertFetchableDocsUrl,
  detectExtractionIssue,
  discoverCanonicalDocsUrl,
  extractAdvertisedMarkdownUrl,
} from "./fetchWebpageSupport";

/**
 * [Schema] 定义了 'fetchWebpage' 工具的结构，供 LLM 调用。
 */
export const fetchWebpageFunctionSchema = {
  name: "fetchWebpage",
  description:
    "访问指定网页 URL 并提取 Markdown 内容（支持 JS 渲染/SPA）。" +
    "对于 docs.* 文档站自动通过 /llms.txt 规范化。" +
    "用户若已提供明确 URL，优先直接抓取作为权威来源，避免额外搜索步骤。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "要抓取的网页完整 URL 地址（http/https）。docs.* 站点可传推测路径，工具会自动规范化。",
      },
      waitForNetworkIdle: {
        type: "boolean",
        description: "是否等待网络请求结束再提取（适合 SPA 动态页面），默认 false。",
        default: false,
      },
    },
    required: ["url"],
  },
};

/**
 * [Executor] 'fetchWebpage' 工具的执行函数。
 * 底层调用 Cloudflare Browser Rendering /api/cf-markdown，支持 JS 渲染。
 */
export async function fetchWebpageFunc(
  args: { url: string; waitForNetworkIdle?: boolean },
  thunkApi: any
): Promise<{ rawData: string; displayData: string }> {
  const { url, waitForNetworkIdle = false } = args;
  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    throw new Error(
      "访问网页失败：必须提供一个有效的、以 http 或 https 开头的 URL。"
    );
  }

  const gotoOptions = waitForNetworkIdle ? { waitUntil: "networkidle0" } : undefined;
  const resolution = await discoverCanonicalDocsUrl(url);
  const targetUrl = resolution.resolvedUrl;

  await assertFetchableDocsUrl(targetUrl, fetch, url);

  let data = await callToolApi<{
    markdown: string;
    success: boolean;
    browserMsUsed?: number;
    source: string;
  }>(thunkApi, "/api/cf-markdown", { url: targetUrl, gotoOptions }, { withAuth: true });

  let finalUrl = targetUrl;
  const advertisedMarkdownUrl = extractAdvertisedMarkdownUrl(data.markdown ?? "", targetUrl);
  if (advertisedMarkdownUrl && advertisedMarkdownUrl !== targetUrl) {
    finalUrl = advertisedMarkdownUrl;
    data = await callToolApi<{
      markdown: string;
      success: boolean;
      browserMsUsed?: number;
      source: string;
    }>(thunkApi, "/api/cf-markdown", { url: finalUrl, gotoOptions }, { withAuth: true });
  }

  const markdown = data.markdown ?? "";
  const extractionIssue = detectExtractionIssue(markdown, finalUrl);
  if (extractionIssue) {
    throw new Error(extractionIssue.message);
  }

  const seconds = data.browserMsUsed ? (data.browserMsUsed / 1000).toFixed(2) : "?";
  const statusMsg =
    `✅ 已成功获取网页内容 (URL: ${finalUrl})\n` +
    `🌐 渲染引擎: Cloudflare Browser Rendering\n` +
    `⏱ 浏览器耗时: ${seconds}s | 字符数: ${markdown.length}` +
    (finalUrl !== url ? `\n🧭 文档地址已规范化: ${url} → ${finalUrl}` : "");

  return {
    rawData: finalUrl === url ? markdown : `[Resolved URL] ${finalUrl}\n\n${markdown}`,
    displayData: `${statusMsg}\n\n${markdown}`,
  };
}
