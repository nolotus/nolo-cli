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
    "访问指定的网页 URL，使用真实浏览器渲染后提取 Markdown 内容，支持 JS 动态渲染页面（SPA/React 等）。" +
    "对于 docs.* 文档站，会自动通过 /llms.txt 和 /llms-full.txt 规范化 URL。" +
    "适合文章阅读、内容总结、网页数据提取。" +
    "如果用户明确给了 URL 并要求据此更新代码/文档，应优先直接抓取这些 URL，并把抓到的字段视为权威来源。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "要抓取其内容的网页的完整 URL 地址（http/https）。对于 docs.* 文档站，可提供大致推测的页面路径，工具会先尝试规范化到权威文档 URL。",
      },
      waitForNetworkIdle: {
        type: "boolean",
        description: "是否等待网络请求结束再提取（适合 SPA/动态页面），默认 false。",
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
