// packages/ai/tools/cloudflareCrawlTool.ts
// Cloudflare Browser Rendering /crawl 工具
// Docs: https://developers.cloudflare.com/browser-rendering/rest-api/crawl-endpoint/

import { callToolApi } from "./toolApiClient";
import { assertFetchableDocsUrl, discoverCanonicalDocsUrl } from "./fetchWebpageSupport";

// ──────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────
export const cloudflareCrawlFunctionSchema = {
  name: "cloudflareCrawl",
  description:
    "使用 Cloudflare Browser Rendering 的 /crawl 接口，从指定 URL 出发自动发现并爬取整个站点（或指定深度/页数），" +
    "支持 JS 渲染，返回 Markdown 格式内容，适合需要抓取多页且页面依赖 JavaScript 渲染的场景。" +
    "如果目标是单页静态内容，优先使用 fetchWebpage；此工具适合多页爬取或需要完整站点索引的任务。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "爬取起始 URL，必须是完整的 http/https 地址。",
      },
      limit: {
        type: "integer",
        description: "最多爬取的页面数量（默认 10，最大 100000）。建议先从小值开始测试。",
        default: 10,
      },
      depth: {
        type: "integer",
        description: "从起始 URL 开始的最大链接层深度（默认不限）。",
      },
      formats: {
        type: "array",
        items: { type: "string", enum: ["markdown", "html"] },
        description: "返回格式，支持 markdown（推荐）和 html，默认 [\"markdown\"]。",
        default: ["markdown"],
      },
      render: {
        type: "boolean",
        description:
          "是否启动无头浏览器执行 JavaScript（默认 true）。" +
          "静态网站可设为 false 以加快速度。",
        default: true,
      },
      source: {
        type: "string",
        enum: ["all", "sitemaps", "links"],
        description: "URL 发现来源：all（默认）、sitemaps 或 links。",
      },
      includeSubdomains: {
        type: "boolean",
        description: "是否跟踪子域名链接（默认 false）。",
      },
      includePatterns: {
        type: "array",
        items: { type: "string" },
        description: "只访问匹配这些通配符的 URL（* 匹配单段，** 匹配多段）。",
      },
      excludePatterns: {
        type: "array",
        items: { type: "string" },
        description: "跳过匹配这些通配符的 URL（优先级高于 includePatterns）。",
      },
      wait: {
        type: "boolean",
        description:
          "是否等待爬取完成后再返回结果（默认 true，服务端最多等 60s）。" +
          "设为 false 时立即返回 jobId，可用 cloudflareCrawlStatus 工具轮询结果。",
        default: true,
      },
    },
    required: ["url"],
  },
};

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────
interface CrawlRecord {
  url: string;
  status: string;
  markdown?: string;
  html?: string;
  metadata?: {
    status: number;
    title: string;
    url: string;
  };
}

interface CrawlResult {
  jobId: string;
  status?: string;
  total?: number;
  finished?: number;
  browserSecondsUsed?: number;
  records?: CrawlRecord[];
  cursor?: number;
}

// ──────────────────────────────────────────────────────────
// Executor: 启动爬取（可选等待结果）
// ──────────────────────────────────────────────────────────
export async function cloudflareCrawlFunc(
  args: {
    url: string;
    limit?: number;
    depth?: number;
    formats?: string[];
    render?: boolean;
    source?: string;
    includeSubdomains?: boolean;
    includePatterns?: string[];
    excludePatterns?: string[];
    wait?: boolean;
  },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const {
    url,
    limit = 10,
    depth,
    formats = ["markdown"],
    render = true,
    source,
    includeSubdomains,
    includePatterns,
    excludePatterns,
    wait = true,
  } = args;

  if (!url || !url.startsWith("http")) {
    throw new Error("必须提供有效的 http/https URL");
  }

  const resolution = await discoverCanonicalDocsUrl(url);
  const targetUrl = resolution.resolvedUrl;
  if (targetUrl !== url) {
    await assertFetchableDocsUrl(targetUrl, fetch, url);
  }
  const normalizationNote =
    targetUrl !== url ? `\n🧭 文档地址已规范化: ${url} → ${targetUrl}` : "";

  const options: Record<string, any> = {};
  if (includeSubdomains !== undefined) options.includeSubdomains = includeSubdomains;
  if (includePatterns?.length) options.includePatterns = includePatterns;
  if (excludePatterns?.length) options.excludePatterns = excludePatterns;

  const body: Record<string, any> = { url: targetUrl, limit, formats, render, wait };
  if (depth !== undefined) body.depth = depth;
  if (source !== undefined) body.source = source;
  if (Object.keys(options).length > 0) body.options = options;

  const data = await callToolApi<CrawlResult>(
    thunkApi,
    "/api/cloudflare-crawl",
    body,
    { withAuth: true }
  );

  // 仅返回 jobId（未等待）
  if (!wait || data.status === "running") {
    const rawData = targetUrl === url ? data : { ...data, originalUrl: url, resolvedUrl: targetUrl };
    return {
      rawData,
      displayData:
        `🚀 爬取任务已启动 (jobId: ${data.jobId})\n目标: ${targetUrl}` +
        normalizationNote +
        `\n使用 cloudflareCrawlStatus 工具查询结果。`,
    };
  }

  // 已完成：格式化结果
  const records = data.records ?? [];
  const completedCount = records.filter((r) => r.status === "completed").length;
  const mdParts = records
    .filter((r) => r.status === "completed" && r.markdown)
    .map((r) => `## ${r.metadata?.title || r.url}\n> ${r.url}\n\n${r.markdown}`)
    .join("\n\n---\n\n");

  const rawData = {
    jobId: data.jobId,
    status: data.status,
    total: data.total,
    finished: data.finished,
    browserSecondsUsed: data.browserSecondsUsed,
    pages: records.map((r) => ({
      url: r.url,
      status: r.status,
      title: r.metadata?.title,
      content: r.markdown || r.html || "",
    })),
    ...(targetUrl === url ? {} : { originalUrl: url, resolvedUrl: targetUrl }),
  };

  const statusIcon = data.status === "completed" ? "✅" : "⚠️";
  const displayData =
    `${statusIcon} Cloudflare 爬取完成\n` +
    `- 目标: ${targetUrl}\n` +
    `- 状态: ${data.status}\n` +
    `- 已完成页面: ${completedCount} / ${data.total ?? "?"}\n` +
    `- 浏览器用时: ${data.browserSecondsUsed?.toFixed(1) ?? "?"}s` +
    normalizationNote +
    `\n\n` +
    (mdParts ? `**内容摘要（前 3 页）：**\n\n${records.slice(0, 3).map((r) => `- [${r.metadata?.title || r.url}](${r.url})`).join("\n")}` : "无可用内容");

  return { rawData, displayData };
}

// ──────────────────────────────────────────────────────────
// Schema: 查询已有任务状态
// ──────────────────────────────────────────────────────────
export const cloudflareCrawlStatusFunctionSchema = {
  name: "cloudflareCrawlStatus",
  description:
    "查询由 cloudflareCrawl 工具创建的爬取任务的当前状态和结果。" +
    "当 cloudflareCrawl 以 wait=false 模式启动时，使用此工具轮询结果。",
  parameters: {
    type: "object",
    properties: {
      jobId: {
        type: "string",
        description: "由 cloudflareCrawl 返回的任务 ID。",
      },
      limit: {
        type: "integer",
        description: "最多返回多少条记录（用于分页）。",
      },
      status: {
        type: "string",
        enum: ["queued", "completed", "disallowed", "skipped", "errored", "cancelled"],
        description: "按 URL 状态过滤结果。",
      },
      cursor: {
        type: "integer",
        description: "分页游标，从上一页响应的 cursor 字段获取。",
      },
    },
    required: ["jobId"],
  },
};

// ──────────────────────────────────────────────────────────
// Executor: 查询任务状态
// ──────────────────────────────────────────────────────────
export async function cloudflareCrawlStatusFunc(
  args: { jobId: string; limit?: number; status?: string; cursor?: number },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const { jobId, limit, status, cursor } = args;

  if (!jobId) throw new Error("必须提供 jobId");

  // 通过 GET /api/cloudflare-crawl/:jobId 查询
  const { getToolRequestContext } = await import("./toolApiClient");
  const { baseUrl, token } = getToolRequestContext(thunkApi);

  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (status) params.set("status", status);
  if (cursor !== undefined) params.set("cursor", String(cursor));
  const qs = params.toString() ? `?${params}` : "";

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(`${baseUrl}/api/cloudflare-crawl/${jobId}${qs}`, { headers });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as any;
    throw new Error(`查询爬取任务失败: ${err?.error?.message ?? resp.status}`);
  }

  const data = await resp.json() as CrawlResult & { status: string };

  const isRunning = data.status === "running";
  const statusIcon = isRunning ? "🔄" : data.status === "completed" ? "✅" : "⚠️";
  const records = (data as any).records ?? [];

  return {
    rawData: data,
    displayData:
      `${statusIcon} 任务 ${jobId} 状态: ${data.status}\n` +
      `- 总页面: ${(data as any).total ?? "?"}, 已完成: ${(data as any).finished ?? "?"}\n` +
      (records.length > 0
        ? `\n已抓取页面:\n${records.slice(0, 5).map((r: CrawlRecord) => `  - ${r.metadata?.title || r.url} (${r.status})`).join("\n")}`
        : ""),
  };
}
