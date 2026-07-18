import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  renderMultiSelectFrame,
  runMultiSelectDialog,
  type MultiSelectDialogItem,
} from "./multiSelectDialog";

const ARROW_DOWN = "\x1b[B";
const ENTER = "\r";
const SPACE = " ";
const ESCAPE = "\x1b";

const items: MultiSelectDialogItem<string>[] = [
  { label: "listFiles", value: "listFiles" },
  { label: "readFile", value: "readFile" },
  { label: "execShell", value: "execShell", detail: "needs approval" },
];

function makeStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk) => chunks.push(String(chunk)));
  return { input, output, stdout: () => chunks.join("") };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function press(input: PassThrough, ...keys: string[]) {
  for (const key of keys) {
    input.write(key);
    await tick();
  }
}

describe("runMultiSelectDialog (@clack/core)", () => {
  test("Space toggles items and Enter submits the checked values", async () => {
    const { input, output } = makeStreams();
    const resultPromise = runMultiSelectDialog({ items, input, output });
    await tick();
    // Check item 0, move down, check item 1, submit.
    await press(input, SPACE, ARROW_DOWN, SPACE, ENTER);
    const result = await resultPromise;
    expect(result).toEqual({
      kind: "submitted",
      values: ["listFiles", "readFile"],
    });
  });

  test("Escape cancels without a value", async () => {
    const { input, output } = makeStreams();
    const resultPromise = runMultiSelectDialog({ items, input, output });
    await tick();
    await press(input, ARROW_DOWN, SPACE, ESCAPE);
    const result = await resultPromise;
    expect(result).toEqual({ kind: "cancelled" });
  });

  test("pre-selected items survive an immediate submit", async () => {
    const { input, output } = makeStreams();
    const resultPromise = runMultiSelectDialog({
      items: items.map((item, index) => ({ ...item, selected: index === 2 })),
      input,
      output,
    });
    await tick();
    await press(input, ENTER);
    const result = await resultPromise;
    expect(result).toEqual({ kind: "submitted", values: ["execShell"] });
  });

  test("submitting with nothing selected returns an empty list by default", async () => {
    const { input, output } = makeStreams();
    const resultPromise = runMultiSelectDialog({ items, input, output });
    await tick();
    await press(input, ENTER);
    const result = await resultPromise;
    expect(result).toEqual({ kind: "submitted", values: [] });
  });

  test("renders checked markers and the cursor row into the output stream", async () => {
    const { input, output, stdout } = makeStreams();
    const resultPromise = runMultiSelectDialog({ items, input, output });
    await tick();
    await press(input, SPACE, ARROW_DOWN, ENTER);
    await resultPromise;
    const frames = stdout();
    expect(frames).toContain("◉ listFiles");
    expect(frames).toContain("> ○ readFile");
    expect(frames).toContain("execShell  needs approval");
  });

  test("empty item list resolves to cancelled without prompting", async () => {
    const result = await runMultiSelectDialog({ items: [] });
    expect(result).toEqual({ kind: "cancelled" });
  });
});

describe("renderMultiSelectFrame", () => {
  test("windows long lists around the cursor like selectDialog", () => {
    const manyItems = Array.from({ length: 20 }, (_, index) => ({
      label: `item ${index}`,
      value: index,
    }));
    const frame = renderMultiSelectFrame({
      items: manyItems,
      cursor: 10,
      selectedValues: [10],
      maxVisible: 5,
    });
    expect(frame).toContain("more above");
    expect(frame).toContain("more below");
    expect(frame).toContain("> ◉ item 10");
    expect(frame.split("\n").length).toBeLessThanOrEqual(8);
  });
});
