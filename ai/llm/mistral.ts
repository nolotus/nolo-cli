// ai/llm/mistral.ts

import type { Model } from "./types";

export const mistralModels: Model[] = [
    {
        // 实际使用时建议改成你真实调用用的 model id
        name: "devstral-2512",
        displayName: "Mistral: Devstral 2",
        hasVision: false,
        price: {
            input: 0.1 * 7,
            output: 0.1 * 7,
        },
        maxOutputTokens: 262144,
        contextWindow: 262144, // 256k ≈ 256 * 1024
        supportsTool: true,
        // 如果后面确认支持 reasoning effort，可以加上：
        // supportsReasoningEffort: true,
    },
];
