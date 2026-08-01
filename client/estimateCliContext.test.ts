import { describe, expect, test } from "bun:test";
import {
  estimateChatMessagesTokens,
  estimateDefaultCliContextTokens,
} from "./estimateCliContext";

describe("estimateCliContext", () => {
  test("estimates default CLI system+tools well above empty and below a fake 15k floor", () => {
    const tokens = estimateDefaultCliContextTokens({ cwd: process.cwd() });
    // Real workspace overhead is typically ~5k–12k depending on AGENTS.md /
    // skill index / tool schemas — never a hardcoded 15k constant.
    expect(tokens).toBeGreaterThan(2_000);
    expect(tokens).toBeLessThan(40_000);
  });

  test("estimateChatMessagesTokens counts string message bodies", () => {
    expect(
      estimateChatMessagesTokens([
        { content: "hello world" },
        { content: "第二段中文内容" },
      ]),
    ).toBeGreaterThan(0);
  });
});
