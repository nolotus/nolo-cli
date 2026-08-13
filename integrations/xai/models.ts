import { Model } from "../../ai/llm/types";

/** xAI Chat Completions model IDs. CLI list: `grok models`. API may lag; verify with a live run. */
export const xaiModels: Model[] = [
  {
    name: "grok-4.6",
    displayName: "Grok 4.6",
    hasVision: true,
    contextWindow: 500000,
    // 价格沿用 grok-4.5 报价（$2/$6 ×7），换代后待 live 验证再校准。
    price: { input: 2 * 7, output: 6 * 7 },
    fnCall: true,
    jsonOutput: true,
  },
];