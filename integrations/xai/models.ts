import { Model } from "../../ai/llm/types";

/** xAI Chat Completions model IDs. CLI list: `grok models`. API may lag; verify with a live run. */
export const xaiModels: Model[] = [
  {
    name: "grok-composer-2.5-fast",
    displayName: "Grok Composer 2.5 Fast",
    hasVision: false,
    contextWindow: 131072,
    price: { input: 3 * 7, output: 15 * 7 },
    fnCall: true,
    jsonOutput: true,
  },
  {
    name: "grok-3",
    displayName: "Grok 3",
    hasVision: false,
    contextWindow: 131072,
    price: { input: 3 * 7, output: 15 * 7 },
    fnCall: true,
    jsonOutput: true,
  },
  {
    name: "grok-4-0709",
    displayName: "Grok4 0709",
    hasVision: false,
    contextWindow: 131072,
    price: { input: 3 * 7, output: 15 * 7 }, // $3/$15 per MTok × 7
    fnCall: true,
    jsonOutput: true,
  },
];