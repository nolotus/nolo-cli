import { asOptionalFiniteNumber } from "../../core/optionalNumber";
import { asTrimmedString } from "../../core/trimmedString";
import { callToolApi } from "./toolApiClient";

const MARKDOWN_PREVIEW_LIMIT = 2500;
const MAX_LLM_CONTEXT_CHARS = 12_000;
const MAX_QUERY_CHARS = 500;

export const firecrawlScrapeSchema = {
  name: "firecrawl_scrape",
  description:
    "使用 Firecrawl 抓取单个网页或 PDF，并返回干净的 Markdown 正文。" +
    "适合反爬较强的页面、PDF 文档解析、以及 fetchWebpage 抓取失败时的备选方案。" +
    "如果用户明确给了 URL，应优先直接抓取这些 URL。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "要抓取的完整 URL（http/https），支持普通网页和 PDF。",
      },
      onlyMainContent: {
        type: "boolean",
        description: "是否只返回正文内容，过滤导航/页脚等噪音，默认 true。",
        default: true,
      },
      timeout: {
        type: "number",
        description: "请求超时（毫秒），默认 60000，最大 300000。",
      },
    },
    required: ["url"],
  },
};

export const firecrawlSearchSchema = {
  name: "firecrawl_search",
  description:
    "使用 Firecrawl 搜索互联网，并可返回每个结果的 Markdown 正文。" +
    "适合发现资料、查找 PDF/论文/GitHub 仓库，以及需要同时拿到链接和页面内容的场景。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "自然语言搜索查询。支持 site:、filetype:pdf、intitle: 等运算符。",
      },
      limit: {
        type: "number",
        description: "返回结果数量，默认 5，最大 20。",
        default: 5,
      },
      includeContent: {
        type: "boolean",
        description: "是否抓取并返回每个结果的 Markdown 正文，默认 true。",
        default: true,
      },
      categories: {
        type: "array",
        items: {
          type: "string",
          enum: ["github", "research", "pdf"],
        },
        description: "可选结果类别过滤：github、research、pdf。",
      },
      country: {
        type: "string",
        description: "ISO 国家代码，用于地域化搜索结果，例如 US、CN、JP。",
      },
    },
    required: ["query"],
  },
};

type FirecrawlScrapeResponse = {
  success?: boolean;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      sourceURL?: string;
      url?: string;
      statusCode?: number;
      contentType?: string;
    };
  };
  creditsUsed?: number;
};

type FirecrawlSearchResult = {
  title?: string;
  description?: string;
  url?: string;
  markdown?: string;
  category?: string;
};

type FirecrawlSearchResponse = {
  success?: boolean;
  data?: {
    web?: FirecrawlSearchResult[];
  };
  creditsUsed?: number;
};

function normalizeHttpUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new Error("firecrawl_scrape 需要有效的 http/https URL。");
  }
  return trimmed;
}

function normalizeScrapeTimeout(timeout?: number): number | undefined {
  if (timeout === undefined || timeout === null) return undefined;
  const finite = asOptionalFiniteNumber(timeout);
  if (finite === undefined) {
    throw new Error("firecrawl_scrape 的 timeout 必须是有效数字。");
  }
  return Math.min(Math.max(Math.floor(finite), 1000), 300_000);
}

function previewMarkdown(markdown: string | undefined, maxChars: number) {
  if (!markdown) return undefined;
  if (markdown.length <= maxChars) return markdown;
  return `${markdown.slice(0, Math.max(0, maxChars))}…`;
}

function buildSearchLlmContext(
  query: string,
  results: Array<{
    title?: string;
    url?: string;
    description?: string;
    category?: string;
    content?: string;
  }>,
) {
  const header = `Found ${results.length} Firecrawl results for "${query}".`;
  const lines = [header];
  let remaining = MAX_LLM_CONTEXT_CHARS - header.length - 1;

  results.forEach((item, index) => {
    const chunks = [
      `${index + 1}. ${item.title ?? "Untitled"}`,
      item.url ? `   URL: ${item.url}` : null,
      item.category ? `   Category: ${item.category}` : null,
      item.description ? `   Description: ${item.description}` : null,
    ].filter(Boolean) as string[];

    for (const chunk of chunks) {
      if (remaining <= 0) return;
      if (chunk.length + 1 > remaining) {
        lines.push(`${chunk.slice(0, Math.max(0, remaining - 1))}…`);
        remaining = 0;
        return;
      }
      lines.push(chunk);
      remaining -= chunk.length + 1;
    }

    if (item.content && remaining > 0) {
      const prefix = "   Content: ";
      const allowed = Math.min(
        MARKDOWN_PREVIEW_LIMIT,
        Math.max(0, remaining - prefix.length - 1),
      );
      if (allowed > 0) {
        const content = previewMarkdown(item.content, allowed);
        if (content) {
          lines.push(`${prefix}${content}`);
          remaining -= prefix.length + content.length + 1;
        }
      }
    }
  });

  return lines.join("\n");
}

export const firecrawlScrapeFunc = async (
  input: {
    url: string;
    onlyMainContent?: boolean;
    timeout?: number;
  },
  thunkApi: any,
): Promise<{ rawData: unknown; displayData: string; llmContext: string }> => {
  const { url, onlyMainContent = true, timeout } = input;
  const normalizedUrl = normalizeHttpUrl(url);
  const normalizedTimeout = normalizeScrapeTimeout(timeout);

  const data = await callToolApi<FirecrawlScrapeResponse>(
    thunkApi,
    "/api/firecrawl-scrape",
    {
      url: normalizedUrl,
      onlyMainContent,
      timeout: normalizedTimeout,
    },
    { withAuth: true },
  );

  const markdown = data.data?.markdown ?? "";
  const metadata = data.data?.metadata ?? {};
  const title = metadata.title || normalizedUrl;
  const finalUrl = metadata.url || metadata.sourceURL || normalizedUrl;

  const header = [
    `Firecrawl scrape succeeded for ${finalUrl}.`,
    metadata.statusCode ? `Status: ${metadata.statusCode}` : null,
    metadata.contentType ? `Content-Type: ${metadata.contentType}` : null,
    data.creditsUsed != null ? `Credits used: ${data.creditsUsed}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const bodyBudget = Math.max(0, MAX_LLM_CONTEXT_CHARS - header.length - 2);
  const llmContext = [
    header,
    "",
    previewMarkdown(markdown, bodyBudget) || "(empty markdown)",
  ].join("\n");

  const displayData = [
    `🔥 Firecrawl 已抓取: ${title}`,
    `URL: ${finalUrl}`,
    data.creditsUsed != null ? `Credits: ${data.creditsUsed}` : null,
    `字符数: ${markdown.length}`,
    "",
    previewMarkdown(markdown, MARKDOWN_PREVIEW_LIMIT) ?? "(无正文)",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    rawData: {
      url: finalUrl,
      title,
      markdown,
      metadata,
      creditsUsed: data.creditsUsed,
    },
    displayData,
    llmContext,
  };
};

export const firecrawlSearchFunc = async (
  input: {
    query: string;
    limit?: number;
    includeContent?: boolean;
    categories?: string[];
    country?: string;
  },
  thunkApi: any,
): Promise<{ rawData: unknown; displayData: string; llmContext: string }> => {
  const { query, limit = 5, includeContent = true, categories, country } = input;
  const trimmedQuery = asTrimmedString(query);
  if (!trimmedQuery) {
    throw new Error("firecrawl_search 需要有效的 query。");
  }
  const normalizedQuery =
    trimmedQuery.length > MAX_QUERY_CHARS
      ? `${trimmedQuery.slice(0, MAX_QUERY_CHARS)}…`
      : trimmedQuery;

  const data = await callToolApi<FirecrawlSearchResponse>(
    thunkApi,
    "/api/firecrawl-search",
    { query: trimmedQuery, limit, includeContent, categories, country },
    { withAuth: true },
  );

  const results = (data.data?.web ?? []).map((item) => ({
    title: item.title,
    url: item.url,
    description: item.description,
    category: item.category,
    content: previewMarkdown(item.markdown, MARKDOWN_PREVIEW_LIMIT),
  }));

  const llmContext = buildSearchLlmContext(normalizedQuery, results);
  const displayData = `🔎 ${llmContext.split("\n")[0]}`;

  return {
    rawData: {
      query: trimmedQuery,
      results,
      creditsUsed: data.creditsUsed,
    },
    displayData,
    llmContext,
  };
};