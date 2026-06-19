import { YAHOO_FINANCE_TOOLS_SCHEMA, getYahooFinanceQuote, getYahooFinanceHistorical } from "../integrations/yahoo-finance";
import { ARXIV_TOOLS_SCHEMA, searchArxivPapers } from "../integrations/arxiv";
import { WORLD_BANK_TOOLS_SCHEMA, getWorldBankIndicator } from "../integrations/world-bank";
import { SERPAPI_TOOLS_SCHEMA, searchGoogleScholar, searchGoogleWeb } from "../integrations/serpapi";
import type { AgentRuntimeToolCallInput, AgentRuntimeToolResult } from "./hostAdapter";

export const EXTERNAL_TOOL_NAMES = [
  "getYahooFinanceQuote",
  "getYahooFinanceHistorical",
  "searchArxivPapers",
  "getWorldBankIndicator",
  "searchGoogleScholar",
  "searchGoogleWeb",
] as const;

export type ExternalToolName = typeof EXTERNAL_TOOL_NAMES[number];

export function isExternalToolName(toolName: unknown): toolName is ExternalToolName {
  return typeof toolName === "string" && EXTERNAL_TOOL_NAMES.includes(toolName as ExternalToolName);
}

export function filterExternalToolNames(toolNames?: string[]) {
  return (toolNames ?? []).filter(isExternalToolName);
}

export function buildExternalOpenAiTools(args: { toolNames?: string[], authenticatedBillingContext?: boolean }) {
  const toolNames = new Set(args.toolNames ?? []);
  const allSchemas: any[] = [
    ...YAHOO_FINANCE_TOOLS_SCHEMA,
    ...ARXIV_TOOLS_SCHEMA,
    ...WORLD_BANK_TOOLS_SCHEMA,
  ];
  if (args.authenticatedBillingContext) {
    allSchemas.push(...SERPAPI_TOOLS_SCHEMA);
  }
  return allSchemas.filter((schema: any) => toolNames.has(schema.function.name));
}

export function buildExternalToolExecutors(args?: {
  toolNames?: string[];
  authenticatedBillingContext?: {
    onPreflight: (toolName: string) => Promise<void>;
    onCharge: (toolName: string) => Promise<void>;
  };
}) {
  const executors: Record<string, (call: AgentRuntimeToolCallInput) => Promise<AgentRuntimeToolResult>> = {};
  const toolNames = args?.toolNames;

  if (!toolNames || toolNames.includes("getYahooFinanceQuote")) {
    executors.getYahooFinanceQuote = async (call) => {
      try {
        const { symbol } = JSON.parse(call.arguments);
        const data = await getYahooFinanceQuote(symbol);
        return {
          id: call.id,
          name: call.name,
          content: JSON.stringify(data, null, 2),
        };
      } catch (e: any) {
        return { id: call.id, name: call.name, content: `Error: ${e.message}`, isError: true };
      }
    };
  }

  if (!toolNames || toolNames.includes("getYahooFinanceHistorical")) {
    executors.getYahooFinanceHistorical = async (call) => {
      try {
        const { symbol, period1, period2 } = JSON.parse(call.arguments);
        const data = await getYahooFinanceHistorical(symbol, period1, period2);
        return {
          id: call.id,
          name: call.name,
          content: JSON.stringify(data, null, 2),
        };
      } catch (e: any) {
        return { id: call.id, name: call.name, content: `Error: ${e.message}`, isError: true };
      }
    };
  }

  if (!toolNames || toolNames.includes("searchArxivPapers")) {
    executors.searchArxivPapers = async (call) => {
      try {
        const { query, maxResults } = JSON.parse(call.arguments);
        const data = await searchArxivPapers(query, maxResults);
        return {
          id: call.id,
          name: call.name,
          content: JSON.stringify(data, null, 2),
        };
      } catch (e: any) {
        return { id: call.id, name: call.name, content: `Error: ${e.message}`, isError: true };
      }
    };
  }

  if (!toolNames || toolNames.includes("getWorldBankIndicator")) {
    executors.getWorldBankIndicator = async (call) => {
      try {
        const { countryCode, indicatorCode } = JSON.parse(call.arguments);
        const data = await getWorldBankIndicator(countryCode, indicatorCode);
        return {
          id: call.id,
          name: call.name,
          content: JSON.stringify(data, null, 2),
        };
      } catch (e: any) {
        return { id: call.id, name: call.name, content: `Error: ${e.message}`, isError: true };
      }
    };
  }

  if (args?.authenticatedBillingContext) {
    if (!toolNames || toolNames.includes("searchGoogleScholar")) {
      executors.searchGoogleScholar = async (call) => {
        try {
          await args.authenticatedBillingContext!.onPreflight(call.name);
          const { query, num } = JSON.parse(call.arguments);
          const data = await searchGoogleScholar(query, num);
          await args.authenticatedBillingContext!.onCharge(call.name);
          return {
            content: JSON.stringify(data, null, 2),
          };
        } catch (e: any) {
          return { content: `Error: ${e.message}`, metadata: { isError: true } };
        }
      };
    }

    if (!toolNames || toolNames.includes("searchGoogleWeb")) {
      executors.searchGoogleWeb = async (call) => {
        try {
          await args.authenticatedBillingContext!.onPreflight(call.name);
          const { query, num } = JSON.parse(call.arguments);
          const data = await searchGoogleWeb(query, num);
          await args.authenticatedBillingContext!.onCharge(call.name);
          return {
            content: JSON.stringify(data, null, 2),
          };
        } catch (e: any) {
          return { content: `Error: ${e.message}`, metadata: { isError: true } };
        }
      };
    }
  }

  return executors;
}
