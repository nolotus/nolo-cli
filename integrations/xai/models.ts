import { Model } from "../../ai/llm/types";

/** xAI Chat Completions model IDs. CLI list: `grok models`. API may lag; verify with a live run. */
export const xaiModels: Model[] = [
  {
    name: "grok-4.5",
    displayName: "Grok 4.5",
    hasVision: true,
    contextWindow: 500000,
    price: { input: 2 * 7, output: 6 * 7 }, // $2/$6 per MTok × 7
    fnCall: true,
    jsonOutput: true,
  },
];