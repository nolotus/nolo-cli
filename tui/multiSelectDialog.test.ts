import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  renderMultiSelectFrame,
  runMultiSelectDialog,
  type MultiSelectDialogItem,
} from "./multiSelectDialog";
import { createRawKeyReader } from "./selectDialog";
import { getCliLocale, setCliLocale } from "./i18n";

// String assertions target the English strings; pin the locale for machines
// whose LANG resolves to zh.
const originalLocale = getCliLocale();
beforeAll(() => setCliLocale("en"));
afterAll(() => setCliLocale(originalLocale));

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

describe("runMultiSelectDialog", () => {
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
    expect(frames).toContain("❯ ○ readFile");
    expect(frames).toContain("execShell  needs approval");
  });

  test("empty item list resolves to cancelled without prompting", async () => {
    const result = await runMultiSelectDialog({ items: [] });
    expect(result).toEqual({ kind: "cancelled" });
  });

  test("a wheel report moves the cursor, never cancels", async () => {
    // Regression: scrolling the wheel used to cancel this dialog (the old
    // clack path timed the lone ESC of the SGR report out as a bare Escape).
    // The reader now recognizes the whole SGR report and parseScrollAction
    // turns it into a wheel-down that moves the highlight. The report is
    // emitted as a single chunk — see selectDialog.test.ts for why the split
    // emit + esc-pending timer was removed (hand-rolled state machine, not
    // real raw-mode delivery).
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const resultPromise = runMultiSelectDialog({ items, input, output, readKey });
    await new Promise((r) => setTimeout(r, 10));

    // Wheel-down moves cursor from item 0 to item 1; toggle it and submit.
    input.emit("data", "\x1b[<65;3;3M");
    await new Promise((r) => setTimeout(r, 10));
    input.emit("data", " ");
    await new Promise((r) => setTimeout(r, 10));
    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toEqual({ kind: "submitted", values: ["readFile"] });
    // Confirm the cursor row painted on item 1 before the toggle.
    expect(chunks.join("")).toContain("❯ ○ readFile");
  });

  test("a bare Escape still cancels a multi-select dialog", async () => {
    // A lone ESC with no continuation arriving within the 30ms bounded wait
    // is a genuine bare Escape -> cancel. The split-arrival test below
    // covers the other direction (ESC is a sequence prefix, not a cancel).
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const output = new PassThrough();
    output.on("data", () => {});
    const resultPromise = runMultiSelectDialog({ items, input, output, readKey });
    // A lone ESC with no continuation is a genuine bare Escape -> cancel.
    input.emit("data", "\x1b");
    const result = await resultPromise;
    expect(result).toEqual({ kind: "cancelled" });
  });

  test("a split SGR wheel report does not cancel a multi-select dialog", async () => {
    // Same split-arrival regression: the lone ESC half of a wheel report
    // must NOT cancel. Same reader, two emits.
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const chunks: string[] = [];
    const output = new PassThrough();
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const resultPromise = runMultiSelectDialog({ items, input, output, readKey });
    await new Promise((r) => setTimeout(r, 10));

    input.emit("data", "\x1b");
    await new Promise((r) => setTimeout(r, 5));
    input.emit("data", "[<65;1;1M");
    await new Promise((r) => setTimeout(r, 10));
    // Wheel-down moved cursor to item 1, not a cancel.
    expect(chunks.join("")).toContain("❯ ○ readFile");

    input.emit("data", " ");
    await new Promise((r) => setTimeout(r, 10));
    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toEqual({ kind: "submitted", values: ["readFile"] });
  });

  test("a non-wheel SGR mouse click does not cancel a multi-select dialog", async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const output = new PassThrough();
    output.on("data", () => {});
    const resultPromise = runMultiSelectDialog({ items, input, output, readKey });
    await new Promise((r) => setTimeout(r, 10));
    // A plain left-click report, emitted whole, is swallowed — not a cancel,
    // not a cursor move. Dialog still open: toggle item 0 and submit.
    input.emit("data", "\x1b[<0;1;1M");
    await new Promise((r) => setTimeout(r, 10));
    input.emit("data", " ");
    await new Promise((r) => setTimeout(r, 10));
    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toEqual({ kind: "submitted", values: ["listFiles"] });
  });

  test("required: true blocks an empty submit and shows an error", async () => {
    // HIGH-1: with required set, Enter on nothing checked must NOT submit —
    // the dialog stays open and paints an error. This test fails against the
    // old implementation, which ignored `required` and returned submitted:[].
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const resultPromise = runMultiSelectDialog({
      items,
      input,
      output,
      readKey,
      required: true,
    });
    await new Promise((r) => setTimeout(r, 10));

    // First Enter on an empty selection: must NOT resolve. Assert the dialog
    // is still open by checking the error banner painted into the frame.
    input.emit("data", "\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(chunks.join("")).toContain("Pick at least one option to submit");
    // The promise is still pending — prove it by NOT awaiting yet. Move down,
    // toggle item 1, then Enter must succeed.
    input.emit("data", "\x1b[B");
    await new Promise((r) => setTimeout(r, 10));
    input.emit("data", " ");
    await new Promise((r) => setTimeout(r, 10));
    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toEqual({ kind: "submitted", values: ["readFile"] });
  });

  test("required: true with a pre-checked item submits immediately", async () => {
    // required only blocks an EMPTY submit; a pre-selected item satisfies it.
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const output = new PassThrough();
    output.on("data", () => {});
    const resultPromise = runMultiSelectDialog({
      items: items.map((item, index) => ({ ...item, selected: index === 0 })),
      input,
      output,
      readKey,
      required: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toEqual({ kind: "submitted", values: ["listFiles"] });
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
    expect(frame).toContain("↑ 8 more");
    expect(frame).toContain("↓ 7 more");
    expect(frame).toContain("❯ ◉ item 10");
    // title + blank + ↑ hint + 5 windowed rows + blank + ↓ hint
    expect(frame.split("\n").length).toBeLessThanOrEqual(10);
  });
});
