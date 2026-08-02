import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import {
  buildHistoryLines,
  createTurnHistory,
  finalizeCurrentTurn,
  startTurn,
  appendToCurrentTurn,
  type Turn,
} from "./tuiHistory";
import {
  getActiveDensity,
  setActiveDensity,
  setActiveThemeName,
  themeColorSequence,
  type TuiDensity,
} from "./theme";
import { formatAssistantDisplay } from "../client/assistantOutput";
import { stripAnsi } from "./tuiAnsi";

// buildHistoryLines is the single paint path for both streaming and history
// redraw. These tests lock the contract that history redraw uses the full
// assistantOutput renderer (formatAssistantDisplay) — NOT the deleted
// highlightMarkdown — so list/table/link/rule markdown stays styled after a
// turn scrolls out of the live stream and back into a repaint.

const withColor = (fn: () => void) => {
  const previous = process.env.NOLO_CLI_COLOR;
  process.env.NOLO_CLI_COLOR = "1";
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.NOLO_CLI_COLOR;
    else process.env.NOLO_CLI_COLOR = previous;
  }
};

const noColor = (fn: () => void) => {
  const previous = process.env.NOLO_CLI_COLOR;
  process.env.NOLO_CLI_COLOR = "0";
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.NOLO_CLI_COLOR;
    else process.env.NOLO_CLI_COLOR = previous;
  }
};

const render = (turns: Turn[], width = 120): string =>
  buildHistoryLines(
    { ...createTurnHistory(), turns },
    width,
  ).join("\n");

describe("buildHistoryLines — assistant markdown rendered through the full renderer", () => {
  beforeEach(() => setActiveThemeName("catppuccin"));
  afterEach(() => setActiveThemeName("catppuccin"));

  test("lists / table / link / rule are styled, not raw markdown", () => {
    const md = [
      "## Title",
      "",
      "- item one",
      "- item two",
      "",
      "1. first",
      "2. second",
      "",
      "| 水果 | 颜色 |",
      "| --- | --- |",
      "| 苹果 | 红 |",
      "",
      "[docs](https://nolo.chat/docs)",
      "",
      "---",
    ].join("\n");

    let out = "";
    withColor(() => {
      out = render([{ role: "assistant", content: md }]);
    });

    // Unordered list markers get the accent color (not raw "- ").
    expect(out).toContain("\x1b[38;2;88;166;255m•\x1b[0m item one");
    // Ordered list markers are accent-colored too.
    expect(out).toContain("\x1b[38;2;88;166;255m1.\x1b[0m first");
    // Table is converted to bullets — the raw separator must be gone.
    expect(out).not.toContain("| --- |");
    expect(out).toContain("苹果");
    expect(out).toContain("红");
    // Link is rendered as an OSC 8 hyperlink with visible fallback text.
    expect(out).toContain("\x1b]8;;https://nolo.chat/docs\x1b\\");
    expect(out).toContain("docs (https://nolo.chat/docs)");
    // Horizontal rule renders as a chrome-colored rule, not a bare "---".
    expect(out).toContain("─");
    expect(out).not.toMatch(/^---$/m);
  });

  test("进入 nolo-plan line is chrome + dim in history redraw", () => {
    // Parity with assistantOutput.ts styleRichMarkdownLine: the repo convention
    // status line must be downgraded to chrome + dim, both in the stream and
    // after the turn scrolls into history.
    let out = "";
    withColor(() => {
      out = render([
        {
          role: "assistant",
          content: "进入 nolo-plan（4 项串行小改）。\nbody text",
        },
      ]);
    });
    // chrome (truecolor catppuccin overlay0) + dim (\x1b[2m) on the
    // status line.
    expect(out).toContain("\x1b[38;2;110;118;129m");
    expect(out).toContain("\x1b[2m进入 nolo-plan");
    // The body line is NOT dimmed by this rule.
    expect(out).toContain("body text");
  });

  test("```diff fence keeps its color band in history redraw", () => {
    let out = "";
    withColor(() => {
      out = render([
        {
          role: "assistant",
          content: "```diff\n+added line\n-removed line\n```",
        },
      ]);
    });
    // Added lines are green, removed lines are red (renderDiffLine via
    // highlightCodeLine). Truecolor catppuccin success/danger.
    expect(out).toContain("\x1b[38;2;63;185;80m+added line");
    expect(out).toContain("\x1b[38;2;255;123;114m-removed line");
  });

  test("user turns bypass markdown rendering — **bold** stays literal", () => {
    let out = "";
    withColor(() => {
      out = render([
        { role: "user", content: "**bold** and `code`" },
        { role: "assistant", content: "ok" },
      ]);
    });
    // User content keeps the literal markers; the ❯ marker carries accent.
    expect(out).toContain("❯");
    expect(out).toContain("**bold**");
    expect(out).toContain("`code`");
    // And it is NOT turned into bold escapes.
    expect(out).not.toContain("\x1b[1mbold\x1b[22m");
  });

  test("colorEnabled=false → history output contains no \\x1b", () => {
    let out = "";
    noColor(() => {
      out = render([
        {
          role: "assistant",
          content: "## Title\n- item\n[docs](https://nolo.chat/docs)",
        },
        { role: "user", content: "hi" },
      ]);
    });
    expect(out).not.toContain("\x1b");
    // Plain text content is still present.
    expect(out).toContain("Title");
    expect(out).toContain("item");
    expect(out).toContain("docs");
  });

  test("idempotent: re-rendering already-rendered content doesn't grow blank lines", () => {
    // buildHistoryLines repaints the same history on every scroll/resize; each
    // repaint re-runs formatAssistantDisplay → polishAssistantStructure. If that
    // pipeline were not idempotent on already-rendered content, blank lines
    // would accumulate over dozens of repaints.
    //
    // Why this shape and not the old one: the OLD version of this test was
    // fake-green. polishAssistantStructure's blank-insertion points are at
    // list↔prose boundaries, which land in the MIDDLE of the output. A bug
    // that only grew lines at the very END would be eaten by formatAssistantDisplay's
    // top-level trim() and never change the line count — so "equal line count"
    // was no proof. The content below has prose → list → prose → list, giving
    // FOUR middle boundaries where breathing inserts blanks, so any spurious
    // growth lands between real content lines where trim() can't reach it.
    //
    // We assert BOTH the line count AND the exact joined string after each of
    // 10 re-renders equals the first — count alone could still pass if blanks
    // migrated without growing; comparing the full string closes that gap.
    //
    // We feed the plain-text result back through the same renderer: that is the
    // "already-rendered content" a repaint would see. (buildHistoryLines output
    // itself carries UI decoration — the ◈ anchor prefix and wrapping — that
    // must not be fed back; the renderer under test is formatAssistantDisplay,
    // which buildHistoryLines delegates to.)
    const md = [
      "prose paragraph one opens the turn",
      "- first list item",
      "- second list item",
      "prose paragraph two resumes",
      "- third list item",
      "- fourth list item",
    ].join("\n");

    let first = "";
    let firstCount = 0;
    withColor(() => {
      first = stripAnsi(formatAssistantDisplay(md));
      firstCount = first.split("\n").length;
      let content = first;
      for (let i = 0; i < 10; i++) {
        content = stripAnsi(formatAssistantDisplay(content));
        // No drift: both count and exact text must equal the first render.
        expect(content.split("\n").length).toBe(firstCount);
        expect(content).toBe(first);
      }
    });
    // Sanity: the render produced real structure (lists survived as bullets,
    // and breathing put blank lines between the prose↔list boundaries).
    expect(firstCount).toBeGreaterThan(6);
    expect(first.split("\n").filter((l) => l === "").length).toBeGreaterThanOrEqual(3);
  });
});

describe("buildHistoryLines — user turn bubble formatting", () => {
  beforeEach(() => setActiveThemeName("catppuccin"));
  afterEach(() => setActiveThemeName("catppuccin"));

  test("first line uses accent ❯ and default body text", () => {
    let lines: string[] = [];
    withColor(() => {
      lines = buildHistoryLines(
        { ...createTurnHistory(), turns: [{ role: "user", content: "hello world" }] },
        80
      ).filter(Boolean);
    });

    expect(lines.length).toBe(1);
    const accentSeq = themeColorSequence("accent");
    const mutedSeq = themeColorSequence("muted");
    expect(lines[0]).toContain(`${accentSeq}❯\x1b[39m`);
    expect(lines[0]).toContain("hello world");
    expect(lines[0]).not.toContain(mutedSeq);
  });

  test("explicit multiline uses chrome │ prefix and default body text", () => {
    let lines: string[] = [];
    withColor(() => {
      lines = buildHistoryLines(
        { ...createTurnHistory(), turns: [{ role: "user", content: "first line\nsecond line" }] },
        80
      ).filter(Boolean);
    });

    expect(lines.length).toBe(2);
    const accentSeq = themeColorSequence("accent");
    const chromeSeq = themeColorSequence("chrome");
    const mutedSeq = themeColorSequence("muted");

    expect(lines[0]).toContain(`${accentSeq}❯\x1b[39m`);
    expect(lines[0]).toContain("first line");
    expect(lines[0]).not.toContain(mutedSeq);

    expect(lines[1]).toContain(`${chromeSeq}│\x1b[39m`);
    expect(lines[1]).toContain("second line");
    expect(lines[1]).not.toContain(mutedSeq);
  });

  test("soft wrapping adds 2-space hanging gutter", () => {
    let lines: string[] = [];
    withColor(() => {
      // 10 columns width forces "hello world extra" to soft-wrap
      lines = buildHistoryLines(
        { ...createTurnHistory(), turns: [{ role: "user", content: "hello world extra" }] },
        10
      ).filter(Boolean);
    });

    expect(lines.length).toBeGreaterThan(1);
    const mutedSeq = themeColorSequence("muted");
    // Continuation line start with hanging gutter "  "
    expect(lines[1]).toMatch(/^  /);
    expect(lines[1]).not.toContain(mutedSeq);
    expect(lines[1]).toContain("world");
  });

  test("no-color mode produces ❯ marker, two-space multiline prefix, and zero \\x1b", () => {
    let lines: string[] = [];
    noColor(() => {
      lines = buildHistoryLines(
        { ...createTurnHistory(), turns: [{ role: "user", content: "first long line for wrap\nsecond line" }] },
        15
      ).filter(Boolean);
    });

    const fullText = lines.join("\n");
    expect(fullText).not.toContain("\x1b");
    expect(lines[0]).toMatch(/^❯ first long/);
    // Soft-wrapped continuation starts with two spaces
    expect(lines[1]).toMatch(/^  line for/);
    // Explicit newline continuation starts with two spaces
    expect(lines[lines.length - 1]).toMatch(/^  second line/);
  });

  test("user content keeps markdown literal without formatting", () => {
    let lines: string[] = [];
    withColor(() => {
      lines = buildHistoryLines(
        { ...createTurnHistory(), turns: [{ role: "user", content: "**bold** `code` # header" }] },
        80
      ).filter(Boolean);
    });

    expect(lines[0]).toContain("**bold** `code` # header");
    expect(lines[0]).not.toContain("\x1b[1mbold\x1b[22m");
  });
});

describe("buildHistoryLines — per-turn memoization", () => {
  let densityBefore: TuiDensity;

  beforeEach(() => {
    setActiveThemeName("catppuccin");
    densityBefore = getActiveDensity();
    setActiveDensity("spacious");
  });
  afterEach(() => {
    setActiveThemeName("catppuccin");
    setActiveDensity(densityBefore);
  });

  const multiTurnHistory = () => {
    const history = createTurnHistory();
    history.turns = [
      { role: "user", content: "你好世界 — ask about 中文 wrapping" },
      {
        role: "assistant",
        content: [
          "Here is a short answer with CJK: 中文宽度。",
          "",
          "```ts",
          "const n = 1;",
          "```",
        ].join("\n"),
      },
      { role: "user", content: "follow-up" },
    ];
    return history;
  };

  test("byte-equivalence across repeated calls and width changes", () => {
    noColor(() => {
      const history = multiTurnHistory();
      const a = buildHistoryLines(history, 80);
      const b = buildHistoryLines(history, 80);
      expect(b).toEqual(a);
      expect(b.join("\n")).toBe(a.join("\n"));

      const sameWidthAgain = buildHistoryLines(history, 80);
      expect(sameWidthAgain).toEqual(a);

      const narrow = buildHistoryLines(history, 24);
      expect(narrow).not.toEqual(a);
      expect(narrow.join("\n")).not.toBe(a.join("\n"));
      // Rebuilding at the new width is stable.
      expect(buildHistoryLines(history, 24)).toEqual(narrow);
      // Returning to the original width restores the original bytes.
      expect(buildHistoryLines(history, 80)).toEqual(a);
    });
  });

  test("appending to currentContent does not alter finalized turn lines", () => {
    noColor(() => {
      const history = createTurnHistory();
      startTurn(history, "user");
      appendToCurrentTurn(history, "solidified user");
      finalizeCurrentTurn(history);
      startTurn(history, "assistant");
      appendToCurrentTurn(history, "solidified assistant\n```js\n1\n```");
      finalizeCurrentTurn(history);

      const before = buildHistoryLines(history, 60);
      const finalizedPrefixLen = before.length;

      startTurn(history, "assistant");
      appendToCurrentTurn(history, "streaming…");
      const mid = buildHistoryLines(history, 60);
      expect(mid.slice(0, finalizedPrefixLen)).toEqual(before);

      appendToCurrentTurn(history, " more chunks 中文");
      const after = buildHistoryLines(history, 60);
      expect(after.slice(0, finalizedPrefixLen)).toEqual(before);
      expect(after.length).toBeGreaterThan(finalizedPrefixLen);
    });
  });

  test("spacious vs cozy separator position rules", () => {
    noColor(() => {
      const userFirst: Turn[] = [{ role: "user", content: "hi" }];
      const assistantFirst: Turn[] = [{ role: "assistant", content: "hello" }];
      const multi: Turn[] = [
        { role: "assistant", content: "a" },
        { role: "user", content: "b" },
      ];

      setActiveDensity("spacious");
      const spaciousUser = buildHistoryLines(
        { ...createTurnHistory(), turns: userFirst },
        80,
      );
      expect(spaciousUser[0]).toBe("");
      expect(spaciousUser[1]).toContain("❯");

      const spaciousAssistant = buildHistoryLines(
        { ...createTurnHistory(), turns: assistantFirst },
        80,
      );
      expect(spaciousAssistant[0]).not.toBe("");
      expect(spaciousAssistant[0]).toContain("◈");

      const spaciousMulti = buildHistoryLines(
        { ...createTurnHistory(), turns: multi },
        80,
      );
      // First assistant: no leading blank; blank before second (user) turn.
      expect(spaciousMulti[0]).not.toBe("");
      const blankIdx = spaciousMulti.findIndex((l, i) => i > 0 && l === "");
      expect(blankIdx).toBeGreaterThan(0);

      setActiveDensity("cozy");
      const cozyUser = buildHistoryLines(
        { ...createTurnHistory(), turns: userFirst },
        80,
      );
      expect(cozyUser[0]).not.toBe("");
      // Cozy never inserts the position-based blank separators.
      expect(cozyUser.filter((l) => l === "").length).toBe(0);
      const cozyMulti = buildHistoryLines(
        { ...createTurnHistory(), turns: multi },
        80,
      );
      expect(cozyMulti.filter((l) => l === "").length).toBe(0);
    });
  });
});
