// ai/llm/fireworks.ts
import {
    FIREWORKS_KIMI_CURRENT_MODEL,
    FIREWORKS_KIMI_K2P6_MODEL,
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
            cachingRead: 0.19 * 8,
        },
        maxOutputTokens: 262144,
        contextWindow: 262144,
        supportsTool: true,
    },
    {
        name: FIREWORKS_KIMI_CURRENT_MODEL,
        displayName: "MoonshotAI: Kimi K2.7 Code",
        hasVision: true,
        price: {
            input: 0.95 * 8,
            output: 4.0 * 8,
            cachingRead: 0.19 * 8,
        },
        maxOutputTokens: 262144,
        contextWindow: 262144,
        supportsTool: true,
    },
    {
        name: FIREWORKS_KIMI_K2P6_MODEL,
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
        name: "accounts/fireworks/models/minimax-m3",
        displayName: "MiniMax: MiniMax M3",
        hasVision: true,
        price: {
            input: 0.3 * 8,
            output: 1.2 * 8,
            cachingRead: 0.06 * 8,
        },
        contextWindow: 512000,
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
    {
        name: "accounts/fireworks/models/glm-5p2",
        displayName: "Z.AI: GLM 5.2",
        hasVision: false,
        price: {
            input: 1.4 * 8,
            output: 4.4 * 8,
            cachingRead: 0.25 * 8,
        },
        contextWindow: 1048576,
        maxOutputTokens: 1048576,
        supportsTool: true,
        supportsReasoningEffort: true,
    },
];
