import { getJson } from "serpapi";

export const SERPAPI_TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "searchGoogleScholar",
      description: "使用 Google Scholar (谷歌学术) 搜索学术论文。返回文章标题、作者、摘要、引用次数及链接。由于查询成本高，请谨慎调用并精准设置关键字。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索关键词（如 'agentic workflows in large language models'）。"
          },
          num: {
            type: "number",
            description: "返回的论文数量。默认为 5，最大不超过 10。"
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "searchGoogleWeb",
      description: "使用 Google 搜索引擎搜索全网最新信息。返回网页的标题、链接和摘要。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索关键词。"
          },
          num: {
            type: "number",
            description: "返回的结果数量。默认为 5，最大不超过 10。"
          }
        },
        required: ["query"]
      }
    }
  }
];

export async function searchGoogleScholar(query: string, num: number = 5) {
  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("Search query cannot be empty.");
  }
  const safeNum = Math.max(1, Math.min(10, Number(num) || 5));
  
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    throw new Error("SERPAPI_API_KEY is not configured.");
  }
  
  return new Promise((resolve, reject) => {
    getJson({
      engine: "google_scholar",
      q: query,
      num: safeNum,
      api_key: apiKey
    }, (json) => {
      if (json.error) return reject(new Error(json.error));
      
      const results = json.organic_results?.map((res: any) => ({
        title: res.title,
        link: res.link,
        snippet: res.snippet,
        publication_info: res.publication_info?.summary,
        cited_by: res.inline_links?.cited_by?.total
      })) || [];
      
      resolve({ results });
    });
  });
}

export async function searchGoogleWeb(query: string, num: number = 5) {
  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("Search query cannot be empty.");
  }
  const safeNum = Math.max(1, Math.min(10, Number(num) || 5));
  
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    throw new Error("SERPAPI_API_KEY is not configured.");
  }
  
  return new Promise((resolve, reject) => {
    getJson({
      engine: "google",
      q: query,
      num: safeNum,
      api_key: apiKey
    }, (json) => {
      if (json.error) return reject(new Error(json.error));
      
      const results = json.organic_results?.map((res: any) => ({
        title: res.title,
        link: res.link,
        snippet: res.snippet,
        source: res.source
      })) || [];
      
      resolve({ results });
    });
  });
}
