// ai/llm/fireworks.ts
import {
    FIREWORKS_KIMI_CURRENT_MODEL,
    FIREWORKS_KIMI_LATEST_MODEL,
} from "./kimi";

export const fireworksModels = [
    // --- MoonshotAI Models (Kimi) ---
    {
        name: FIREWORKS_KIMI_LATEST_MODEL,
        displayName: "MoonshotAI: Kimi Latest",
        hasVision: true,
        price: {
            input: 0.95 * 8,
            output: 4.0 * 8,
            cachingRead: 0.16 * 8,
        },
        maxOutputTokens: 262144,
        contextWindow: 262144,
        supportsTool: true,
    },
    {
        name: FIREWORKS_KIMI_CURRENT_MODEL,
        displayName: "MoonshotAI: Kimi K2.6",
        hasVision: true,
        price: {
            input: 0.95 * 8,
            output: 4.0 * 8,
            cachingRead: 0.16 * 8,
        },
        maxOutputTokens: 262144,
        contextWindow: 262144,
        supportsTool: true,
    },
    {
        name: "accounts/fireworks/models/minimax-m2p7",
        displayName: "MiniMax: MiniMax M2.7",
        hasVision: true,
        price: {
            input: 0.3 * 8,
            output: 1.2 * 8,
            cachingRead: 0.06 * 8,
        },
        supportsTool: true,
    },
    {
        name: "accounts/fireworks/models/qwen3p6-plus",
        displayName: "Qwen: Qwen 3.6 Plus",
        hasVision: true,
        price: {
            input: 0.5 * 8,
            output: 3.0 * 8,
            cachingRead: 0.1 * 8,
        },
        supportsTool: true,
    },
    {
        name: "accounts/fireworks/models/glm-5p1",
        displayName: "Z.AI: GLM 5.1",
        hasVision: true,
        price: {
            input: 1.0 * 8,
            output: 3.2 * 8,
            cachingRead: 0.2 * 8,
        },
        supportsTool: true,
    },
];
