import { describe, expect, test } from "bun:test";

import { createStreamingTextWriter, splitStreamingText } from "./streamingOutput";

describe("streamingOutput", () => {
  test("splits text into user-visible characters instead of UTF-16 code units", () => {
    expect(splitStreamingText("A你👍🏽B")).toEqual(["A", "你", "👍🏽", "B"]);
  });

  test("flushes text in small character batches", () => {
    const chunks: string[] = [];
    const writer = createStreamingTextWriter({
      write: (chunk) => chunks.push(chunk),
      batchSize: 2,
    });

    writer.push("abcd");
    writer.flushAll();

    expect(chunks).toEqual(["ab", "cd"]);
  });
});
