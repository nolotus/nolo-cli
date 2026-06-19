import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export async function searchArxivPapers(query: string, maxResults: number = 5) {
  try {
    const limit = Math.max(1, Math.min(50, Number(maxResults) || 5));
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const text = await response.text();
    const result = parser.parse(text);
    
    // Parse the result into a friendly JSON format
    const entries = result.feed?.entry || [];
    const papers = (Array.isArray(entries) ? entries : [entries]).map((entry: any) => ({
      id: entry.id,
      title: entry.title?.replace(/\s+/g, " "),
      summary: entry.summary?.replace(/\s+/g, " "),
      published: entry.published,
      authors: Array.isArray(entry.author) ? entry.author.map((a: any) => a.name) : [entry.author?.name],
      pdfUrl: Array.isArray(entry.link) 
        ? entry.link.find((l: any) => l["@_title"] === "pdf")?.["@_href"]
        : entry.link?.["@_href"]
    }));

    return papers;
  } catch (error: any) {
    throw new Error(`Failed to search arXiv: ${error.message}`);
  }
}

export const ARXIV_TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "searchArxivPapers",
      description: "Search for academic papers and preprints on arXiv by query string.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query (e.g., 'machine learning', 'quantum computing').",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of results to return (default: 5).",
          },
        },
        required: ["query"],
      },
    },
  },
];
