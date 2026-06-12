// /ai/tools/googleSearchScraperTool.ts
// Apify Google Search Results Scraper
// Actor: https://apify.com/apify/google-search-scraper

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
      queries: {
        type: "array",
        items: { type: "string" },
        description: "要搜索的关键词列表，每个元素对应一次 Google 搜索。",
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
    required: ["queries"],
  },
};

export async function googleSearchScraperFunc(
  args: {
    queries: string[];
    maxPagesPerQuery?: number;
    resultsPerPage?: number;
    languageCode?: string;
    countryCode?: string;
    mobileResults?: boolean;
    includeUnfilteredResults?: boolean;
    saveHtml?: boolean;
  },
  thunkApi: any
) {
  const {
    queries,
    maxPagesPerQuery = 1,
    resultsPerPage = 10,
    languageCode,
    countryCode,
    mobileResults = false,
    includeUnfilteredResults = false,
    saveHtml = false,
  } = args;

  if (!queries || queries.length === 0) {
    throw new Error("Google 搜索：必须提供至少一个搜索关键词（queries）。");
  }

  const input: Record<string, any> = {
    queries: queries.join("\n"),
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
