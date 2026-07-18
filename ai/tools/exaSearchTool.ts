import { callToolApi } from "./toolApiClient";

export const exaSearchSchema = {
    name: "exa_search",
    description: "使用 Exa (原 Metaphor) 智能搜索引擎查找信息。这是获取高质量、最新网络信息的最佳方式。",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "要搜索的自然语言查询字符串。",
            },
            numResults: {
                type: "number",
                description: "返回的结果数量（默认为 5）。",
                default: 5,
            },
            useAutoprompt: {
                type: "boolean",
                description: "是否让 Exa 自动优化查询词（推荐 true）。",
                default: true,
            },
            type: {
                type: "string",
                enum: ["neural", "keyword"],
                description: "搜索类型：'neural' (语义搜索，默认) 或 'keyword' (精确匹配)。",
                default: "neural",
            },
            includeContent: {
                type: "boolean",
                description: "是否直接返回网页的文本内容（RAG 模式）。如果为 true，不仅返回链接，还会返回已清洗的正文。",
                default: true,
            }
        },
        required: ["query"],
    },
};

export const exaSearchFunc = async (input: any, thunkApi: any): Promise<any> => {
    const { query, numResults = 5, useAutoprompt = true, type = "neural", includeContent = true } = input;

    const data = await callToolApi(thunkApi, "/api/exa-search", {
        query,
        numResults,
        useAutoprompt,
        type,
        contents: includeContent ? { text: true } : undefined,
    }, { withAuth: true });

    const results = (data.results || []).map((item: any) => ({
        title: item.title,
        url: item.url,
        publishedDate: item.publishedDate,
        author: item.author,
        content: item.text ? item.text.slice(0, 2500) : undefined,
    }));

    return {
        summary: `Found ${results.length} results for "${query}"`,
        results,
        queryUsed: data.autopromptString || query
    };
};
