import { expect, test } from "bun:test";

import { allocateCollapsedPaste, createCollapsedPasteStore } from "../core/collapsedPaste";

import { createReadPastedTextExecutor } from "./cliLocalToolExecutors";

function createPasteExecutor(makeLine: (index: number) => string, lineCount: number) {
  const store = createCollapsedPasteStore();
  const { id } = allocateCollapsedPaste(
    store,
    Array.from({ length: lineCount }, (_, index) => makeLine(index + 1)).join("\n"),
  );
  return { id, executor: createReadPastedTextExecutor(store) };
}

function read(
  executor: ReturnType<typeof createReadPastedTextExecutor>,
  args: Record<string, unknown>,
) {
  return executor({ arguments: JSON.stringify(args) } as any);
}

test("readPastedText honors a slightly over-cap explicit range in one call", async () => {
  const { id, executor } = createPasteExecutor((line) => `paste-line-${line}`, 220);

  const result = await read(executor, { pasteId: id, startLine: 1, endLine: 210 });

  // 210 lines fit in one call: no tail-fetching second read is needed.
  expect(result.content).toContain("paste-line-210");
  expect(result.content).not.toContain("paste-line-211");
  expect(result.content).not.toContain("Continue with startLine");
  expect(result.metadata).toMatchObject({ startLine: 1, endLine: 210, truncated: true });

  // A request past EOF clamps to the last line and must not suggest a
  // continuation beyond it.
  const pastEof = await read(executor, { pasteId: id, startLine: 250, endLine: 300 });
  expect(pastEof.metadata).toMatchObject({ startLine: 220, endLine: 220, truncated: false });
  expect(pastEof.content).not.toContain("Continue with startLine");
});

test("readPastedText appends the exact next startLine when paging", async () => {
  const { id, executor } = createPasteExecutor((line) => `paste-line-${line}`, 220);

  const result = await read(executor, { pasteId: id });

  expect(result.content).toContain("paste-line-200");
  expect(result.content).not.toContain("paste-line-201");
  expect(result.content).toContain("Continue with startLine=201");
  expect(result.metadata).toMatchObject({ endLine: 200, nextStartLine: 201 });
});

test("readPastedText answers covered re-reads with a notice, force refetches", async () => {
  const { id, executor } = createPasteExecutor((line) => `paste-line-${line}`, 220);

  await read(executor, { pasteId: id, startLine: 1, endLine: 200 });

  const repeat = await read(executor, { pasteId: id, startLine: 1, endLine: 200 });
  expect(repeat.metadata).toMatchObject({ deduped: true });
  expect(repeat.content).toContain("not resending");
  expect(repeat.content).not.toContain("paste-line-1");

  const subset = await read(executor, { pasteId: id, startLine: 50, endLine: 120 });
  expect(subset.metadata).toMatchObject({ deduped: true });

  const forced = await read(executor, { pasteId: id, startLine: 50, endLine: 120, force: true });
  expect(forced.metadata?.deduped).toBeUndefined();
  expect(forced.content).toContain("paste-line-50");

  // A range with new lines is delivered normally (no dedup).
  const tail = await read(executor, { pasteId: id, startLine: 200, endLine: 220 });
  expect(tail.metadata?.deduped).toBeUndefined();
  expect(tail.content).toContain("paste-line-220");
});

test("readPastedText dedup gate measures the persisted content, not the raw slice", async () => {
  // Recorded chars = content + bounded metadata suffix, so a bare content
  // length just under the cap can persist above it and must stay re-readable.
  const small = createPasteExecutor(() => "s".repeat(4500), 1);
  await read(small.executor, { pasteId: small.id });
  const smallRepeat = await read(small.executor, { pasteId: small.id });
  expect(smallRepeat.metadata).toMatchObject({ deduped: true });

  const big = createPasteExecutor(() => "b".repeat(4700), 1);
  await read(big.executor, { pasteId: big.id });
  const bigRepeat = await read(big.executor, { pasteId: big.id });
  expect(bigRepeat.metadata?.deduped).toBeUndefined();
  expect(bigRepeat.content).toContain("b".repeat(100));
});

test("readPastedText never dedups deliveries larger than the historical retention cap", async () => {
  // 60 lines x ~105 chars > the 4800-char historical cap: such a read cannot
  // stay intact in history, so re-reading it stays legitimate.
  const { id, executor } = createPasteExecutor(
    (line) => `paste-line-${line}: ${"x".repeat(90)}`,
    60,
  );

  const first = await read(executor, { pasteId: id });
  expect(first.content.length).toBeGreaterThan(4800);

  const second = await read(executor, { pasteId: id });
  expect(second.metadata?.deduped).toBeUndefined();
  expect(second.content).toContain("paste-line-1");
});
