// packages/ai/tools/cfBrowserTools.ts
// Cloudflare Browser Rendering 工具：截图、Markdown、PDF、JSON 结构化提取
// Docs: https://developers.cloudflare.com/browser-rendering/rest-api/

import { callToolApi } from "./toolApiClient";
import {
  assertFetchableDocsUrl,
  detectExtractionIssue,
  discoverCanonicalDocsUrl,
} from "./fetchWebpageSupport";

async function resolveCfBrowserUrl(url?: string) {
  if (!url) {
    return {
      targetUrl: url,
      originalUrl: url,
      rewritten: false,
    };
  }

  const resolution = await discoverCanonicalDocsUrl(url);
  const targetUrl = resolution.resolvedUrl;
  await assertFetchableDocsUrl(targetUrl, fetch, url);

  return {
    targetUrl,
    originalUrl: url,
    rewritten: targetUrl !== url,
  };
}

function buildNormalizationNote(originalUrl?: string, targetUrl?: string) {
  if (!originalUrl || !targetUrl || originalUrl === targetUrl) return "";
  return `\n🧭 文档地址已规范化: ${originalUrl} → ${targetUrl}`;
}

// ──────────────────────────────────────────────────────────
// cfScreenshot
// ──────────────────────────────────────────────────────────
export const cfScreenshotFunctionSchema = {
  name: "cfScreenshot",
  description:
    "使用 Cloudflare Browser Rendering 对指定网页或 HTML 内容截图，支持全页截图、自定义视口。" +
    "返回 base64 图片数据，可直接在对话中展示。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "要截图的网页 URL（http/https），与 html 二选一。",
      },
      html: {
        type: "string",
        description: "直接传入 HTML 字符串进行渲染截图，与 url 二选一。",
      },
      fullPage: {
        type: "boolean",
        description: "是否截取完整页面（包括滚动区域），默认 false 只截可视区。",
        default: false,
      },
      viewport: {
        type: "object",
        description: "浏览器视口尺寸，例如 { width: 1280, height: 720 }。",
        properties: {
          width: { type: "integer" },
          height: { type: "integer" },
        },
      },
    },
  },
};

export async function cfScreenshotFunc(
  args: {
    url?: string;
    html?: string;
    fullPage?: boolean;
    viewport?: { width: number; height: number };
  },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const { url, html, fullPage = false, viewport } = args;

  if (!url && !html) throw new Error("必须提供 url 或 html 参数");
  const { targetUrl, originalUrl, rewritten } = await resolveCfBrowserUrl(url);

  const data = await callToolApi<{
    dataUrl: string;
    mimeType: string;
    browserMsUsed?: number;
    source: string;
  }>(
    thunkApi,
    "/api/cf-screenshot",
    { url: targetUrl, html, fullPage, viewport },
    { withAuth: true }
  );

  const seconds = data.browserMsUsed ? (data.browserMsUsed / 1000).toFixed(2) : "?";

  return {
    rawData: rewritten ? { ...data, originalUrl, resolvedUrl: targetUrl } : data,
    displayData:
      `📸 截图完成\n- 来源: ${data.source}\n- 浏览器耗时: ${seconds}s` +
      buildNormalizationNote(originalUrl, targetUrl) +
      `\n\n` +
      `![screenshot](${data.dataUrl})`,
  };
}

// ──────────────────────────────────────────────────────────
// cfGetMarkdown
// ──────────────────────────────────────────────────────────
export const cfGetMarkdownFunctionSchema = {
  name: "cfGetMarkdown",
  description:
    "使用 Cloudflare Browser Rendering 将网页内容转换为 Markdown 格式，支持 JS 渲染。" +
    "比 cloudflareCrawl 更快（单页），比 fetchWebpage 更准确（支持 JS 动态内容）。" +
    "适合文章阅读、内容总结、单页数据提取。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "要读取的网页 URL（http/https），与 html 二选一。",
      },
      html: {
        type: "string",
        description: "直接传入 HTML 字符串转换，与 url 二选一。",
      },
      waitForNetworkIdle: {
        type: "boolean",
        description: "是否等待网络请求结束再提取（适合 SPA/动态页面），默认 false。",
        default: false,
      },
    },
  },
};

export async function cfGetMarkdownFunc(
  args: {
    url?: string;
    html?: string;
    waitForNetworkIdle?: boolean;
  },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const { url, html, waitForNetworkIdle = false } = args;

  if (!url && !html) throw new Error("必须提供 url 或 html 参数");
  const { targetUrl, originalUrl, rewritten } = await resolveCfBrowserUrl(url);

  const gotoOptions = waitForNetworkIdle ? { waitUntil: "networkidle0" } : undefined;

  const data = await callToolApi<{
    markdown: string;
    success: boolean;
    browserMsUsed?: number;
    source: string;
  }>(thunkApi, "/api/cf-markdown", { url: targetUrl, html, gotoOptions }, { withAuth: true });

  const extractionIssue = detectExtractionIssue(data.markdown ?? "", targetUrl ?? url ?? "网页");
  if (extractionIssue) {
    throw new Error(extractionIssue.message);
  }

  const seconds = data.browserMsUsed ? (data.browserMsUsed / 1000).toFixed(2) : "?";

  return {
    rawData: rewritten ? { ...data, originalUrl, resolvedUrl: targetUrl } : data,
    displayData:
      `📄 Markdown 提取完成\n- 来源: ${data.source}\n- 浏览器耗时: ${seconds}s\n- 字符数: ${data.markdown?.length ?? 0}` +
      buildNormalizationNote(originalUrl, targetUrl) +
      `\n\n` +
      data.markdown,
  };
}

// ──────────────────────────────────────────────────────────
// cfGeneratePDF
// ──────────────────────────────────────────────────────────
export const cfGeneratePDFFunctionSchema = {
  name: "cfGeneratePDF",
  description:
    "使用 Cloudflare Browser Rendering 将网页或 HTML 渲染为 PDF 文件。" +
    "适合导出文档、报告、打印版网页等场景。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "要转换为 PDF 的网页 URL（http/https），与 html 二选一。",
      },
      html: {
        type: "string",
        description: "直接传入 HTML 字符串转换为 PDF，与 url 二选一。",
      },
      pdfOptions: {
        type: "object",
        description: "PDF 生成选项，例如 { format: 'A4', landscape: false, printBackground: true }。",
        properties: {
          format: { type: "string", description: "页面大小，如 'A4'、'Letter'。" },
          landscape: { type: "boolean" },
          printBackground: { type: "boolean" },
        },
      },
    },
  },
};

export async function cfGeneratePDFFunc(
  args: {
    url?: string;
    html?: string;
    pdfOptions?: { format?: string; landscape?: boolean; printBackground?: boolean };
  },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const { url, html, pdfOptions } = args;

  if (!url && !html) throw new Error("必须提供 url 或 html 参数");
  const { targetUrl, originalUrl, rewritten } = await resolveCfBrowserUrl(url);

  const data = await callToolApi<{
    dataUrl: string;
    mimeType: string;
    filename: string;
    browserMsUsed?: number;
    source: string;
  }>(thunkApi, "/api/cf-pdf", { url: targetUrl, html, pdfOptions }, { withAuth: true });

  const seconds = data.browserMsUsed ? (data.browserMsUsed / 1000).toFixed(2) : "?";

  return {
    rawData: rewritten ? { ...data, originalUrl, resolvedUrl: targetUrl } : data,
    displayData:
      `📑 PDF 生成完成\n- 来源: ${data.source}\n- 文件名: ${data.filename}\n- 浏览器耗时: ${seconds}s` +
      buildNormalizationNote(originalUrl, targetUrl) +
      `\n\n` +
      `[下载 PDF](${data.dataUrl})`,
  };
}

// ──────────────────────────────────────────────────────────
// cfExtractJSON
// ──────────────────────────────────────────────────────────
export const cfExtractJSONFunctionSchema = {
  name: "cfExtractJSON",
  description:
    "使用 Cloudflare Browser Rendering + AI，从网页中提取结构化数据。" +
    "用自然语言描述你想要的数据（prompt），或提供 JSON Schema 定义结构，AI 自动抓取并返回结构化 JSON。" +
    "适合：商品信息、职位列表、文章元数据、价格比较、任何需要从网页提取结构化数据的场景。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "目标网页 URL（http/https），与 html 二选一。",
      },
      html: {
        type: "string",
        description: "直接传入 HTML 字符串，与 url 二选一。",
      },
      prompt: {
        type: "string",
        description:
          "用自然语言描述要提取的数据，例如：'提取所有商品的名称、价格和库存状态'。" +
          "与 response_format 至少提供一个，同时提供时 prompt 引导提取方向，response_format 约束结构。",
      },
      response_format: {
        type: "object",
        description:
          "JSON Schema 格式的结构定义，用于约束返回的数据结构。" +
          "格式: { type: 'json_schema', schema: { type: 'object', properties: {...} } }",
      },
    },
    required: [],
  },
};

export async function cfExtractJSONFunc(
  args: {
    url?: string;
    html?: string;
    prompt?: string;
    response_format?: object;
  },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const { url, html, prompt, response_format } = args;

  if (!url && !html) throw new Error("必须提供 url 或 html 参数");
  if (!prompt && !response_format) throw new Error("必须提供 prompt 或 response_format");
  const { targetUrl, originalUrl, rewritten } = await resolveCfBrowserUrl(url);

  const data = await callToolApi<{
    result: unknown;
    success: boolean;
    browserMsUsed?: number;
    source: string;
  }>(
    thunkApi,
    "/api/cf-json",
    { url: targetUrl, html, prompt, response_format },
    { withAuth: true }
  );

  const seconds = data.browserMsUsed ? (data.browserMsUsed / 1000).toFixed(2) : "?";
  const resultStr = JSON.stringify(data.result, null, 2);

  return {
    rawData: rewritten ? { ...data, originalUrl, resolvedUrl: targetUrl } : data,
    displayData:
      `🔍 结构化数据提取完成\n- 来源: ${data.source}\n- 浏览器耗时: ${seconds}s` +
      buildNormalizationNote(originalUrl, targetUrl) +
      `\n\n` +
      `\`\`\`json\n${resultStr}\n\`\`\``,
  };
}
