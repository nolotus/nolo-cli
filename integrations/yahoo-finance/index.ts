import YahooFinance from "yahoo-finance2";
const yahooFinance = new YahooFinance();

// 1. 获取股票实时报价 (Quote)
export async function getYahooFinanceQuote(symbol: string) {
  try {
    const quote = await yahooFinance.quote(symbol);
    return quote;
  } catch (error: any) {
    throw new Error(`Failed to get quote for ${symbol}: ${error.message}`);
  }
}

// 2. 获取股票历史数据 (Historical)
export async function getYahooFinanceHistorical(
  symbol: string,
  period1: string | Date,
  period2?: string | Date
) {
  try {
    const queryOptions: any = { period1 };
    if (period2) {
      queryOptions.period2 = period2;
    }
    const result = await yahooFinance.historical(symbol, queryOptions);
    return result;
  } catch (error: any) {
    throw new Error(`Failed to get historical data for ${symbol}: ${error.message}`);
  }
}

// 3. 工具的 OpenAI Schema 定义
export const YAHOO_FINANCE_TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "getYahooFinanceQuote",
      description: "Get real-time stock quote and financial summary for a given ticker symbol (e.g., AAPL, TSLA).",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "The stock ticker symbol to look up.",
          },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getYahooFinanceHistorical",
      description: "Get historical pricing data (open, high, low, close, volume) for a specific stock ticker.",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "The stock ticker symbol.",
          },
          period1: {
            type: "string",
            description: "Start date in YYYY-MM-DD format.",
          },
          period2: {
            type: "string",
            description: "End date in YYYY-MM-DD format (optional, defaults to current date).",
          },
        },
        required: ["symbol", "period1"],
      },
    },
  },
];
