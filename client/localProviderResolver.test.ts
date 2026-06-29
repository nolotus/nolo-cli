import { describe, expect, test } from "bun:test";

import { resolveCliOpenAiProviderConfig } from "./localProviderResolver";

describe("CLI local provider resolver", () => {
  test("uses agent customProviderUrl as the OpenAI-compatible chat completions endpoint", async () => {
    expect(await resolveCliOpenAiProviderConfig({
      agentConfig: {
        key: "agent-user-1-custom",
        model: "qwen-coder",
        provider: "custom",
        apiSource: "custom",
        customProviderUrl: "https://provider.example/v1/chat/completions",
        apiKey: "sk-agent-custom",
        apiKeyHeader: "api-key",
      },
      env: {
        OPENAI_API_KEY: "sk-env-should-not-win",
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      },
    })).toEqual({
      model: "qwen-coder",
      endpoint: "https://provider.example/v1/chat/completions",
      apiKey: "sk-agent-custom",
      apiKeyHeader: "api-key",
      provider: "custom",
      requestOptions: {},
    });
  });

  test("appends chat completions to custom provider base urls", async () => {
    expect((await resolveCliOpenAiProviderConfig({
      agentConfig: {
        key: "agent-user-1-custom",
        customProviderUrl: "https://provider.example/v1/",
      },
      env: {},
    })).endpoint).toBe("https://provider.example/v1/chat/completions");
  });

  test("falls back to the env OpenAI-compatible base url", async () => {
    expect(await resolveCliOpenAiProviderConfig({
      agentConfig: {
        key: "agent-user-1-openai",
      },
      env: {
        NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1/",
        NOLO_LOCAL_OPENAI_API_KEY: "sk-local",
      },
    })).toEqual({
      model: "gpt-4.1-mini",
      endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      apiKey: "sk-local",
      provider: "openai-compatible",
      requestOptions: {},
    });
  });

  test("defaults Xiaomi custom endpoints to api-key auth header", async () => {
    expect(await resolveCliOpenAiProviderConfig({
      agentConfig: {
        key: "agent-user-1-mimo",
        provider: "custom",
        apiSource: "custom",
        model: "mimo-v2.5-pro",
        customProviderUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        apiKey: "mimo-monthly-key",
      },
      env: {},
    })).toEqual({
      model: "mimo-v2.5-pro",
      endpoint: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
      apiKey: "mimo-monthly-key",
      apiKeyHeader: "api-key",
      provider: "custom",
      requestOptions: {},
    });
  });

  test("carries explicit agent inference options for request body construction", async () => {
    expect((await resolveCliOpenAiProviderConfig({
      agentConfig: {
        key: "agent-user-1-tuned",
        temperature: 0.2,
        top_p: 0.9,
        frequency_penalty: 0.1,
        presence_penalty: 0.3,
        max_tokens: 4096,
        reasoning_effort: "medium",
      },
      env: {},
    })).requestOptions).toEqual({
      temperature: 0.2,
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.3,
      max_tokens: 4096,
      reasoning_effort: "medium",
    });
  });

});
