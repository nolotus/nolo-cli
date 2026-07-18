// /ai/tools/googleSearchScraperTool.ts
// Apify Google Search Results Scraper
// Actor: https://apify.com/apify/google-search-scraper

import { asOptionalTrimmedString } from "../../core/optionalString";
import { callApifyActor } from "./apifyActorClient";

export const googleSearchScraperFunctionSchema = {
  name: "googleSearchScraper",
  description:
    "通过 Apify 的 Google Search Scraper 抓取 Google 搜索结果（SERP），" +
    "返回自然结果、付费广告、People Also Ask、相关搜索等结构化数据。" +
    "适合需要获取真实 Google 搜索排名和摘要的场景。" +
    "与 exa_search 的区别：此工具返回的是真实 Google SERP 数据，exa_search 是语义搜索引擎。",
  parameters: {
    type: "object",
    properties: {
      // 单数 query 是 OpenAI 风格常见写法：模型经常把 `query: "xxx"` 传过来。
      // 历史上只支持 `queries: string[]` 导致 DeepSeek / GPT-4o 等模型 5/6 调用失败。
      // 同时保留 `queries: string[]` 是 Apify Google Search Scraper Actor 的入参要求。
      query: {
        type: "string",
        description:
          "【推荐】单个搜索关键词。等价于 `queries: [query]`，与 `queries` 互斥。",
      },
      queries: {
        type: "array",
        items: { type: "string" },
        description:
          "搜索关键词列表，每个元素对应一次 Google 搜索。与 `query` 互斥。",
      },
      maxPagesPerQuery: {
        type: "integer",
        description: "每个关键词抓取的搜索结果页数（默认 1，建议不超过 3）。",
        default: 1,
      },
      resultsPerPage: {
        type: "integer",
        description: "每页结果数量（默认 10，最大 100）。",
        default: 10,
      },
      languageCode: {
        type: "string",
        description: "搜索语言代码，如 'zh-CN'（中文）、'en'（英文）、'ja'（日文）等。",
      },
      countryCode: {
        type: "string",
        description: "搜索国家/地区代码，如 'cn'（中国）、'us'（美国）、'jp'（日本）等。",
      },
      mobileResults: {
        type: "boolean",
        description: "是否模拟移动端搜索（默认 false）。",
        default: false,
      },
      includeUnfilteredResults: {
        type: "boolean",
        description: "是否包含未过滤的补充结果（默认 false）。",
        default: false,
      },
      saveHtml: {
        type: "boolean",
        description: "是否同时保存原始 HTML（默认 false）。",
        default: false,
      },
    },
    required: [],
  },
};

export async function googleSearchScraperFunc(
  args: {
    // 接受 OpenAI 风格的单数 `query` 与 Apify 风格的复数 `queries`。
    // 实现层归一化为 `string[]` 后再调用 Actor。
    query?: string;
    queries?: string | string[];
    maxPagesPerQuery?: number;
    resultsPerPage?: number;
    languageCode?: string;
    countryCode?: string;
    mobileResults?: boolean;
    includeUnfilteredResults?: boolean;
    saveHtml?: boolean;
  },
  thunkApi: unknown
) {
  const {
    maxPagesPerQuery = 1,
    resultsPerPage = 10,
    languageCode,
    countryCode,
    mobileResults = false,
    includeUnfilteredResults = false,
    saveHtml = false,
  } = args;

  // 归一化 query / queries → string[]：去空白、跳过空串。
  // 同时接受 `query: string`、`queries: string[]`、`queries: string` 三种模型常见写法。
  const collected: string[] = [];
  const singleQuery = asOptionalTrimmedString(args.query);
  if (singleQuery) {
    collected.push(singleQuery);
  }
  if (Array.isArray(args.queries)) {
    for (const q of args.queries) {
      const trimmed = asOptionalTrimmedString(q);
      if (trimmed) {
        collected.push(trimmed);
      }
    }
  } else {
    // 兼容模型把 queries 也写成单字符串的边界情况。
    const queriesAsString = asOptionalTrimmedString(args.queries);
    if (queriesAsString) {
      collected.push(queriesAsString);
    }
  }
  if (collected.length === 0) {
    throw new Error("Google 搜索：必须提供至少一个搜索关键词（query 或 queries）。");
  }

  const input: Record<string, unknown> = {
    queries: collected.join("\n"),
    maxPagesPerQuery,
    resultsPerPage,
    mobileResults,
    includeUnfilteredResults,
    saveHtml,
  };

  if (languageCode) input.languageCode = languageCode;
  if (countryCode) input.countryCode = countryCode;

  return callApifyActor(thunkApi, {
    actorId: "apify/google-search-scraper",
    input,
    resultType: "datasetItems",
    displayName: "Google Search Scraper",
  });
}
