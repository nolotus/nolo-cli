import { Model } from "../../ai/llm/types";

export const xaiModels: Model[] = [
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
