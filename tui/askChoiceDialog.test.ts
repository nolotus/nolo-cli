import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  createInitialAskChoiceState,
  type AskChoiceQuestion,
} from "../ai/tools/askChoiceState";
import {
  renderAskChoiceFrame,
  runAskChoiceDialog,
} from "./askChoiceDialog";
import { getCliLocale, setCliLocale } from "./i18n";
import { createRawKeyReader } from "./selectDialog";
import { displayWidth, stripAnsi } from "./tuiAnsi";

function makeQuestion(
  overrides: Partial<AskChoiceQuestion> = {},
): AskChoiceQuestion {
  return {
    id: "q0",
    question: "选哪个？",
    choices: [
      { id: "a", label: "选项 A", userMessage: "我选 A" },
      { id: "b", label: "选项 B", userMessage: "我选 B" },
    ],
    multiSelect: false,
    allowOther: true,
    required: true,
    ...overrides,
  };
}

describe("renderAskChoiceFrame", () => {
  const original = getCliLocale();
  afterEach(() => setCliLocale(original));

  test("localizes chrome strings in zh", () => {
    setCliLocale("zh");
    const state = createInitialAskChoiceState([makeQuestion()]);
    const frame = renderAskChoiceFrame(state);
    const plain = stripAnsi(frame.text);
    expect(plain).toContain("问题");
    expect(plain).toContain("其他");
    expect(plain).toContain("输入回答后按 Enter 保存");
    expect(plain).toContain("↵ 选择/提交");
    expect(frame.otherCursor).toBeNull();
  });

  test("localizes chrome strings in en", () => {
    setCliLocale("en");
    const state = createInitialAskChoiceState([makeQuestion()]);
    const frame = renderAskChoiceFrame(state);
    const plain = stripAnsi(frame.text);
    expect(plain).toContain("question");
    expect(plain).toContain("Other");
    expect(plain).toContain("Type your answer, then press Enter to save.");
    expect(plain).toContain("↵ pick/submit");
  });

  test("multi-select shows checkboxes and multi footer", () => {
    setCliLocale("en");
    const state = createInitialAskChoiceState([
      makeQuestion({ multiSelect: true, allowOther: false }),
    ]);
    state.questionStates[0].selectedIds = ["a"];
    const frame = renderAskChoiceFrame(state);
    const plain = stripAnsi(frame.text);
    expect(plain).toContain("◉");
    expect(plain).toContain("○");
    expect(plain).toContain("Space to toggle");
    expect(plain).toContain("space toggle");
  });

  test("overflow hint uses the shared dialogFrame renderer with localized copy", () => {
    setCliLocale("en");
    const state = createInitialAskChoiceState([
      makeQuestion({
        choices: Array.from({ length: 20 }, (_, i) => ({
          id: `c${i}`,
          label: `C${i}`,
          userMessage: `C${i}`,
        })),
      }),
    ]);
    state.questionStates[0].cursorIndex = 12; // 20 choices + Other row = 21 rows
    const frame = renderAskChoiceFrame(state);
    const plain = stripAnsi(frame.text);
    // Same 2-space chrome indent as selectDialog/multiSelectDialog overflow.
    expect(plain).toContain("  ↑ 8 more");
    expect(plain).toContain("  ↓ 5 more");
    setCliLocale("zh");
    const zhPlain = stripAnsi(renderAskChoiceFrame(state).text);
    expect(zhPlain).toContain("  ↑ 8 更多");
    expect(zhPlain).toContain("  ↓ 5 更多");
  });

  test("Other focus reports a CUP cursor at the end of CJK text", () => {
    setCliLocale("zh");
    const state = createInitialAskChoiceState([makeQuestion()]);
    state.questionStates[0].cursorIndex = 2; // Other row
    state.questionStates[0].otherFocused = true;
    state.questionStates[0].otherText = "你觉得别";
    const frame = renderAskChoiceFrame(state);
    expect(frame.otherCursor).not.toBeNull();
    // No fake block cursor glyph in the painted text.
    expect(frame.text).not.toContain("█");
    const plain = stripAnsi(frame.text);
    const lines = plain.split("\n");
    const otherLine = lines[frame.otherCursor!.lineIndex];
    expect(otherLine).toContain("其他: 你觉得别");
    // Column must match the visible width of the prefix+text (CJK = 2 cols).
    expect(frame.otherCursor!.col).toBe(displayWidth(otherLine));
  });
});

describe("runAskChoiceDialog", () => {
  const original = getCliLocale();
  afterEach(() => setCliLocale(original));

  function makeKeyReader(keys: Array<string | null>) {
    let index = 0;
    const readKey = async () => {
      const next = keys[index++];
      return next === undefined ? null : next;
    };
    (readKey as any).dispose = () => {};
    return readKey;
  }

  test("single-select Enter picks and returns selected", async () => {
    setCliLocale("zh");
    const chunks: string[] = [];
    const result = await runAskChoiceDialog({
      request: {
        question: "选哪个？",
        choices: [
          { id: "a", label: "选项 A", userMessage: "我选 A" },
          { id: "b", label: "选项 B", userMessage: "我选 B" },
        ],
        blocking: true,
      },
      output: { write: (c: string) => { chunks.push(String(c)); return true; } } as any,
      input: { isTTY: false } as any,
      readKey: makeKeyReader(["\r"]),
    });
    expect(result).toEqual({
      kind: "selected",
      userMessage: "我选 A",
      label: "选项 A",
    });
  });

  test("multi-select Space toggles then Enter submits", async () => {
    setCliLocale("en");
    const result = await runAskChoiceDialog({
      request: {
        question: "Pick several",
        choices: [],
        blocking: true,
        questions: [
          {
            id: "q0",
            question: "Pick several",
            choices: [
              { id: "x", label: "X", userMessage: "chose X" },
              { id: "y", label: "Y", userMessage: "chose Y" },
            ],
            multiSelect: true,
            allowOther: false,
            required: true,
          },
        ],
      },
      output: { write: () => true } as any,
      input: { isTTY: false } as any,
      // Space toggle X, ↓, Space toggle Y, Enter submit
      readKey: makeKeyReader([" ", "\x1b[B", " ", "\r"]),
    });
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.userMessage).toBe("chose X\nchose Y");
      expect(result.label).toContain("X");
      expect(result.label).toContain("Y");
    }
  });

  test("Other typing with CJK commit + Enter saves and submits", async () => {
    setCliLocale("zh");
    const chunks: string[] = [];
    const result = await runAskChoiceDialog({
      request: {
        question: "还有别的吗？",
        choices: [
          { id: "a", label: "没有", userMessage: "没有" },
        ],
        blocking: true,
      },
      output: {
        write: (c: string) => {
          chunks.push(String(c));
          return true;
        },
        isTTY: true,
        rows: 40,
      } as any,
      input: { isTTY: true, isRaw: true, setRawMode: () => {} } as any,
      // ↓ to Other, type CJK burst, Enter to blur+auto-submit
      readKey: makeKeyReader(["\x1b[B", "你觉得别", "\r"]),
      bottomAnchored: true,
      bottomRow: 30,
    });
    expect(result).toEqual({
      kind: "selected",
      userMessage: "你觉得别",
      label: "你觉得别",
    });
    // Anchored paint must CUP the real cursor onto the Other text.
    const joined = chunks.join("");
    expect(joined).toMatch(/\x1b\[\d+;\d+H/);
    // No fake block cursor.
    expect(joined).not.toContain("█");
  });

  test("Esc cancels", async () => {
    const result = await runAskChoiceDialog({
      request: {
        question: "选哪个？",
        choices: [{ id: "a", label: "A" }],
        blocking: true,
      },
      output: { write: () => true } as any,
      input: { isTTY: false } as any,
      readKey: makeKeyReader(["\x1b"]),
    });
    expect(result).toEqual({ kind: "cancelled" });
  });

  test("unanchored Other typing restores cursor before clearing previous frame", async () => {
    setCliLocale("zh");
    const writes: string[] = [];
    const result = await runAskChoiceDialog({
      request: {
        question: "侧边栏？",
        choices: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        blocking: true,
      },
      // TTY output without bottomAnchored → unanchored canPosition path.
      output: {
        isTTY: true,
        write: (c: string) => {
          writes.push(String(c));
          return true;
        },
      } as any,
      input: { isTTY: false } as any,
      // Focus Other → type two chars (second paint must restore lift) → Enter.
      readKey: makeKeyReader(["\x1b[B", "\x1b[B", "x", "y", "\r"]),
    });
    expect(result.kind).toBe("selected");
    const joined = writes.join("");
    // After parking the cursor on Other, the next paint / exit clear must
    // walk back down before the classic `\x1b[1A\x1b[2K` clear loop.
    expect(joined).toMatch(/\x1b\[\d+B(?:\x1b\[1A\x1b\[2K)+/);
  });

  test("a wheel report moves the highlight, never cancels", async () => {
    // Regression for the reported bug: scrolling the wheel in an ask_choice
    // dialog cancelled it. The reader now recognizes the whole SGR report
    // and parseScrollAction turns it into a wheel-down that moves the
    // highlight. The report is emitted as a single chunk — see
    // selectDialog.test.ts for why the split emit + esc-pending timer was
    // removed (hand-rolled state machine, not real raw-mode delivery).
    setCliLocale("en");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const writes: string[] = [];
    const resultPromise = runAskChoiceDialog({
      request: {
        question: "Pick",
        choices: [
          { id: "a", label: "A", userMessage: "chose A" },
          { id: "b", label: "B", userMessage: "chose B" },
        ],
        blocking: true,
      },
      output: {
        isTTY: false,
        write: (c: string) => {
          writes.push(String(c));
          return true;
        },
      } as any,
      input: { isTTY: false } as any,
      readKey,
    });

    // Wheel-down moves highlight to choice B.
    input.emit("data", "\x1b[<65;3;3M");
    await new Promise((r) => setTimeout(r, 10));
    expect(writes.join("")).toContain("❯ [2] B");
    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toEqual({
      kind: "selected",
      userMessage: "chose B",
      label: "B",
    });
  });

  test("a bare Escape still cancels an ask_choice dialog", async () => {
    // A lone ESC with no continuation arriving within the 30ms bounded wait
    // is a genuine bare Escape -> cancel. The split-arrival test below
    // covers the other direction (ESC is a sequence prefix, not a cancel).
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const resultPromise = runAskChoiceDialog({
      request: {
        question: "Pick",
        choices: [{ id: "a", label: "A", userMessage: "chose A" }],
        blocking: true,
      },
      output: { write: () => true } as any,
      input: { isTTY: false } as any,
      readKey,
    });
    input.emit("data", "\x1b");
    const result = await resultPromise;
    expect(result).toEqual({ kind: "cancelled" });
  });

  test("a split SGR wheel report does not cancel an ask_choice dialog", async () => {
    // Same split-arrival regression as selectDialog: the lone ESC half of a
    // wheel report must NOT cancel. Same reader, two emits.
    setCliLocale("en");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const writes: string[] = [];
    const resultPromise = runAskChoiceDialog({
      request: {
        question: "Pick",
        choices: [
          { id: "a", label: "A", userMessage: "chose A" },
          { id: "b", label: "B", userMessage: "chose B" },
        ],
        blocking: true,
      },
      output: {
        isTTY: false,
        write: (c: string) => {
          writes.push(String(c));
          return true;
        },
      } as any,
      input: { isTTY: false } as any,
      readKey,
    });

    input.emit("data", "\x1b");
    await new Promise((r) => setTimeout(r, 5));
    input.emit("data", "[<65;3;3M");
    await new Promise((r) => setTimeout(r, 10));
    // Wheel-down moved highlight to choice B, not a cancel.
    expect(writes.join("")).toContain("❯ [2] B");

    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toEqual({
      kind: "selected",
      userMessage: "chose B",
      label: "B",
    });
  });

  test("a non-wheel SGR mouse click does not cancel an ask_choice dialog", async () => {
    setCliLocale("en");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const resultPromise = runAskChoiceDialog({
      request: {
        question: "Pick",
        choices: [{ id: "a", label: "A", userMessage: "chose A" }],
        blocking: true,
      },
      output: { write: () => true } as any,
      input: { isTTY: false } as any,
      readKey,
    });
    // A plain left-click report, emitted whole, must be swallowed.
    input.emit("data", "\x1b[<0;1;1M");
    await new Promise((r) => setTimeout(r, 10));
    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toEqual({
      kind: "selected",
      userMessage: "chose A",
      label: "A",
    });
  });
});
