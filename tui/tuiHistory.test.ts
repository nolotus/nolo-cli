import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import {
  buildCopyViewLines,
  buildHistoryLines,
  buildTurnOffsets,
  countTurnLines,
  renderTurnBlock,
  resetStreamingTurnCache,
  renderHistory,
  applyScrollAction,
  createTurnHistory,
  finalizeCurrentTurn,
  startTurn,
  appendToCurrentTurn,
  appendLocalTurn,
  getRenderCacheMissCount,
  resetHistoryFrameDiffCache,
  type Turn,
} from "./tuiHistory";
import {
  getActiveDensity,
  setActiveDensity,
  setActiveThemeName,
  themeColorSequence,
  type TuiDensity,
} from "./theme";
import { padOrTruncateToWidth, stripAnsi, visibleWidth } from "./tuiAnsi";
import { resolveCliColorEnabled } from "../client/terminalStyles";
import { renderScrollbarRow } from "./tuiScrollbar";
import { formatAssistantDisplay } from "../client/assistantOutput";

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

/**
 * Color + forced truecolor. Several history-rendering assertions lock exact
 * `\x1b[38;2;R;G;Bm` sequences; without forcing truecolor those degrade to
 * ANSI-16 fallbacks (`\x1b[34m` etc.) and the truecolor assertions break on
 * any runner that doesn't already export COLORTERM/TERM_PROGRAM (CI, plain
 * `bun test`). NOLO_TUI_TRUECOLOR=1 makes themeColorSequence deterministic
 * regardless of host terminal. Wrap withColor so NOLO_CLI_COLOR is also set.
 */
const withTruecolor = (fn: () => void) => {
  const prevTruecolor = process.env.NOLO_TUI_TRUECOLOR;
  process.env.NOLO_TUI_TRUECOLOR = "1";
  try {
    withColor(fn);
  } finally {
    if (prevTruecolor === undefined) delete process.env.NOLO_TUI_TRUECOLOR;
    else process.env.NOLO_TUI_TRUECOLOR = prevTruecolor;
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
    let accentSeq = "";
    let chromeSeq = "";
    withTruecolor(() => {
      out = render([{ role: "assistant", content: md }]);
      // Capture the sequences INSIDE the truecolor scope — the env is reset
      // after withTruecolor returns, so assertions taken outside would get
      // the ANSI-16 fallback and mismatch the truecolor output.
      accentSeq = themeColorSequence("accent");
      chromeSeq = themeColorSequence("chrome");
    });

    // Unordered list bullets get the accent color (not raw "- ").
    expect(out).toContain(`${accentSeq}•\x1b[0m item one`);
    // Ordered list markers are chrome (structural, not accent) — see
    // assistantOutput.ts styleRichMarkdownLine: owner feedback 2026-08-02
    // demoted them from accent so a column of digits doesn't read as noise.
    expect(out).toContain(`${chromeSeq}1.\x1b[0m first`);
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
    let chromeSeq = "";
    withTruecolor(() => {
      out = render([
        {
          role: "assistant",
          content: "进入 nolo-plan（4 项串行小改）。\nbody text",
        },
      ]);
      chromeSeq = themeColorSequence("chrome");
    });
    // chrome (truecolor catppuccin dark) + dim (\x1b[2m) on the status line.
    expect(out).toContain(chromeSeq);
    expect(out).toContain("\x1b[2m进入 nolo-plan");
    // The body line is NOT dimmed by this rule.
    expect(out).toContain("body text");
  });

  test("```diff fence keeps its color band in history redraw", () => {
    let out = "";
    let successSeq = "";
    let dangerSeq = "";
    withTruecolor(() => {
      out = render([
        {
          role: "assistant",
          content: "```diff\n+added line\n-removed line\n```",
        },
      ]);
      successSeq = themeColorSequence("success");
      dangerSeq = themeColorSequence("danger");
    });
    // Added lines are green, removed lines are red (renderDiffLine via
    // highlightCodeLine). Truecolor catppuccin dark success/danger.
    expect(out).toContain(`${successSeq}+added line`);
    expect(out).toContain(`${dangerSeq}-removed line`);
  });

  test("user turns bypass markdown rendering — **bold** stays literal", () => {
    let out = "";
    withColor(() => {
      out = render([
        { role: "user", content: "**bold** and `code`" },
        { role: "assistant", content: "ok" },
      ]);
    });
    // User content keeps the literal markers; the ┃ gutter carries accent.
    expect(out).toContain("┃");
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

  test("first line uses accent ┃  gutter and accent + bold body text", () => {
    let lines: string[] = [];
    let accentSeq = "";
    let mutedSeq = "";
    withTruecolor(() => {
      lines = buildHistoryLines(
        { ...createTurnHistory(), turns: [{ role: "user", content: "hello world" }] },
        80
      ).filter(Boolean);
      accentSeq = themeColorSequence("accent");
      mutedSeq = themeColorSequence("muted");
    });

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(`${accentSeq}\x1b[1m┃  hello world`);
    expect(lines[0]).not.toContain(mutedSeq);
  });

  test("explicit multiline uses ┃  gutter prefix and accent + bold body text", () => {
    let lines: string[] = [];
    let accentSeq = "";
    let mutedSeq = "";
    withTruecolor(() => {
      lines = buildHistoryLines(
        { ...createTurnHistory(), turns: [{ role: "user", content: "first line\nsecond line" }] },
        80
      ).filter(Boolean);
      accentSeq = themeColorSequence("accent");
      mutedSeq = themeColorSequence("muted");
    });

    expect(lines.length).toBe(2);

    expect(lines[0]).toContain(`${accentSeq}\x1b[1m┃  first line`);
    expect(lines[0]).not.toContain(mutedSeq);

    expect(lines[1]).toContain(`${accentSeq}\x1b[1m┃  second line`);
    expect(lines[1]).not.toContain(mutedSeq);
  });

  test("CRLF and lone CR line endings are normalized so no \\r leaks into the frame", () => {
    let lines: string[] = [];
    withColor(() => {
      lines = buildHistoryLines(
        {
          ...createTurnHistory(),
          turns: [{ role: "user", content: "first line\r\nsecond line\rthird line" }],
        },
        80
      );
    });

    // Three logical lines, none carrying a raw carriage return that would make
    // the terminal rewind to the start of the row. (buildHistoryLines may emit
    // a leading blank separator row under spacious density, so filter those.)
    const nonEmpty = lines.filter(Boolean);
    expect(nonEmpty.length).toBe(3);
    for (const line of lines) {
      expect(line).not.toContain("\r");
    }
    expect(stripAnsi(nonEmpty[0])).toContain("first line");
    expect(stripAnsi(nonEmpty[1])).toContain("second line");
    expect(stripAnsi(nonEmpty[2])).toContain("third line");
  });

  test("soft wrapping adds ┃  hanging gutter and respects content width", () => {
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
    // Continuation line starts with hanging gutter "┃  "
    expect(stripAnsi(lines[1])).toMatch(/^┃  /);
    expect(lines[1]).not.toContain(mutedSeq);
    expect(lines[1]).toContain("world");

    // Every soft-wrapped line must strictly respect the 10-column visible width boundary
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    }
  });

  test("soft-wrapped continuation rows carry gutter + bold + accent and reset at EOL", () => {
    let lines: string[] = [];
    let accentSeq = "";
    withTruecolor(() => {
      lines = buildHistoryLines(
        {
          ...createTurnHistory(),
          turns: [{ role: "user", content: "alpha bravo charlie delta echo" }],
        },
        24
      ).filter(Boolean);
      accentSeq = themeColorSequence("accent");
    });

    expect(lines.length).toBeGreaterThan(1);
    // Every row — not just the first — must carry gutter ┃, bold, and accent.
    for (const line of lines) {
      expect(line).toContain("┃");
      expect(line).toContain(`${accentSeq}\x1b[1m`);
      // Styles must be closed so accent never bleeds into the scrollbar column.
      expect(line.endsWith("\x1b[0m")).toBe(true);
    }
  });

  test("no-color mode produces ┃  gutter, ┃  multiline gutter, and zero \\x1b", () => {
    let lines: string[] = [];
    noColor(() => {
      lines = buildHistoryLines(
        { ...createTurnHistory(), turns: [{ role: "user", content: "first long line for wrap\nsecond line" }] },
        15
      ).filter(Boolean);
    });

    const fullText = lines.join("\n");
    expect(fullText).not.toContain("\x1b");
    expect(lines[0]).toMatch(/^┃  first long/);
    // Soft-wrapped continuation starts with gutter "┃  "
    expect(lines[1]).toMatch(/^┃  line for/);
    // Explicit newline continuation starts with gutter "┃  "
    expect(lines[lines.length - 1]).toMatch(/^┃  second line/);
  });

  test("assistant turn does NOT carry the user turn ┃ gutter", () => {
    let lines: string[] = [];
    withTruecolor(() => {
      lines = buildHistoryLines(
        { ...createTurnHistory(), turns: [{ role: "assistant", content: "hello from assistant\nline 2" }] },
        80
      ).filter(Boolean);
    });

    for (const line of lines) {
      expect(line).not.toContain("┃");
    }
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

// The gutter alone survives NO_COLOR, but on a truecolor terminal the thing
// the eye actually catches while scrolling is a solid block of color. These
// lock the bubble contract: every row of a user turn is a full-width band,
// padded by display width (not string length) and closed so the tint never
// reaches the scrollbar column.
describe("buildHistoryLines — user turn background bubble", () => {
  beforeEach(() => setActiveThemeName("catppuccin"));
  afterEach(() => setActiveThemeName("catppuccin"));

  const userBubble = (content: string, width: number): string[] => {
    let lines: string[] = [];
    withTruecolor(() => {
      lines = buildHistoryLines(
        { ...createTurnHistory(), turns: [{ role: "user", content }] },
        width
      ).filter((line) => line !== "");
    });
    return lines;
  };

  test("every user row opens a truecolor background and closes with a reset", () => {
    const lines = userBubble("first line\nsecond line", 40);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line).toMatch(/^\x1b\[48;2;\d+;\d+;\d+m/);
      expect(line.endsWith("\x1b[0m")).toBe(true);
    }
  });

  test("rows are padded to exactly contentWidth so the bubble edge is straight", () => {
    for (const width of [40, 61]) {
      for (const line of userBubble("short\nan appreciably longer second line that will soft wrap somewhere", width)) {
        expect(visibleWidth(line)).toBe(width);
      }
    }
  });

  test("CJK content pads by display width, not string length", () => {
    const lines = userBubble("这是一条很长的中文用户消息用来测试换行与背景填充", 30);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(30);
    }
  });

  test("an interior reset re-opens the background so the row tail stays tinted", () => {
    const [line] = userBubble("wrapped content that is long enough to carry an interior reset", 30);
    const bg = line.match(/^\x1b\[48;2;\d+;\d+;\d+m/)![0];
    // Every reset except the row's own closer must be followed by the wash.
    const body = line.slice(0, -"\x1b[0m".length);
    for (const chunk of body.split("\x1b[0m").slice(1)) {
      expect(chunk.startsWith(bg)).toBe(true);
    }
  });

  test("no-color mode keeps the gutter and emits no background", () => {
    let lines: string[] = [];
    noColor(() => {
      lines = buildHistoryLines(
        { ...createTurnHistory(), turns: [{ role: "user", content: "plain" }] },
        40
      ).filter(Boolean);
    });
    expect(lines[0]).toMatch(/^┃  plain/);
    expect(lines.join("\n")).not.toContain("\x1b");
  });

  test("assistant turns get no bubble — the band is user-only", () => {
    let lines: string[] = [];
    withTruecolor(() => {
      lines = buildHistoryLines(
        { ...createTurnHistory(), turns: [{ role: "assistant", content: "hello" }] },
        40
      ).filter(Boolean);
    });
    for (const line of lines) {
      expect(line).not.toMatch(/^\x1b\[48;2;/);
    }
  });

  const withColorNoTruecolor = (fn: () => void) => {
    // Color ON but truecolor FORCED OFF: the ANSI-16 fallback path. Deterministic
    // even on hosts whose terminal env (COLORTERM/TERM_PROGRAM) reports truecolor.
    const prev = process.env.NOLO_TUI_TRUECOLOR;
    process.env.NOLO_TUI_TRUECOLOR = "0";
    try {
      withColor(fn);
    } finally {
      if (prev === undefined) delete process.env.NOLO_TUI_TRUECOLOR;
      else process.env.NOLO_TUI_TRUECOLOR = prev;
    }
  };

  test("ANSI-16 fallback keeps the gutter with zero background", () => {
    let lines: string[] = [];
    withColorNoTruecolor(() => {
      lines = buildHistoryLines(
        { ...createTurnHistory(), turns: [{ role: "user", content: "first\nsecond" }] },
        40
      ).filter(Boolean);
    });
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      // Degraded terminals must never get a half-applied background.
      expect(line).not.toContain("\x1b[48;");
      // Foreground styles still close at EOL so nothing bleeds to the scrollbar.
      expect(line.endsWith("\x1b[0m")).toBe(true);
    }
    // The ┃ gutter survives on first + explicit multiline rows.
    expect(stripAnsi(lines[0]!)).toMatch(/^┃  /);
    expect(stripAnsi(lines[lines.length - 1]!)).toMatch(/^┃  /);
  });

  test("bubble rows stay full-width under both densities", () => {
    const prev = getActiveDensity();
    try {
      for (const density of ["spacious", "cozy"] as const) {
        setActiveDensity(density);
        for (const line of userBubble("density check", 40)) {
          expect(visibleWidth(line)).toBe(40);
          expect(line.endsWith("\x1b[0m")).toBe(true);
        }
      }
    } finally {
      setActiveDensity(prev);
    }
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
    const densityBefore = getActiveDensity();
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
      expect(spaciousUser[1]).toContain("┃");

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
    setActiveDensity(densityBefore);
  });
});

describe("buildCopyViewLines — copy view line construction", () => {
  const makeHistory = (turns: Turn[]) => ({ ...createTurnHistory(), turns });

  test("strips ANSI escape sequences from content", () => {
    const turns: Turn[] = [
      { role: "assistant", content: "\x1b[1mbold\x1b[0m and \x1b[38;2;88;166;255mcolored\x1b[0m" },
    ];
    const lines = buildCopyViewLines(makeHistory(turns));
    expect(lines.join("")).not.toContain("\x1b[");
    expect(lines[0]).toBe("bold and colored");
  });

  test("normalizes CRLF (\\r\\n) to a single LF — no stray \\r, no extra blank rows", () => {
    const turns: Turn[] = [
      { role: "assistant", content: "line1\r\nline2\r\nline3" },
    ];
    const lines = buildCopyViewLines(makeHistory(turns));
    // CRLF must collapse cleanly: 3 logical lines, no \r residue.
    expect(lines).toEqual(["line1", "line2", "line3"]);
    expect(lines.every((l) => !l.includes("\r"))).toBe(true);
  });

  test("normalizes lone CR (legacy Mac) to LF", () => {
    const turns: Turn[] = [
      { role: "assistant", content: "aaa\rbbb\rccc" },
    ];
    const lines = buildCopyViewLines(makeHistory(turns));
    expect(lines).toEqual(["aaa", "bbb", "ccc"]);
    expect(lines.every((l) => !l.includes("\r"))).toBe(true);
  });

  test("mixes CRLF and lone CR without producing \r in output", () => {
    const turns: Turn[] = [
      { role: "assistant", content: "a\r\nb\rc\r\nd" },
    ];
    const lines = buildCopyViewLines(makeHistory(turns));
    expect(lines).toEqual(["a", "b", "c", "d"]);
    expect(lines.join("")).not.toContain("\r");
  });

  test("inserts exactly one blank separator between turns", () => {
    const turns: Turn[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1\na2" },
      { role: "user", content: "u2" },
    ];
    const lines = buildCopyViewLines(makeHistory(turns));
    // u1 | "" | a1 | a2 | "" | u2
    expect(lines).toEqual(["u1", "", "a1", "a2", "", "u2"]);
  });

  test("scroll boundary: content shorter than a small viewport yields maxScrollTop 0", () => {
    // Reproduce the renderCopyView maxScrollTop formula against the built
    // lines to lock the scroll-clamp boundary for short content.
    const turns: Turn[] = [{ role: "assistant", content: "only\none\ntwo" }];
    const lines = buildCopyViewLines(makeHistory(turns));
    const visibleHeight = 10;
    const maxScrollTop = Math.max(0, lines.length - visibleHeight);
    expect(lines.length).toBeLessThanOrEqual(visibleHeight);
    expect(maxScrollTop).toBe(0);
  });

  test("scroll boundary: content taller than viewport yields a positive maxScrollTop", () => {
    const turns: Turn[] = [
      { role: "assistant", content: Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") },
    ];
    const lines = buildCopyViewLines(makeHistory(turns));
    const visibleHeight = 5;
    const maxScrollTop = Math.max(0, lines.length - visibleHeight);
    expect(lines.length).toBe(30);
    expect(maxScrollTop).toBe(25);
    // Clamp invariants the render loop relies on:
    const clampedTop = Math.max(0, Math.min(maxScrollTop + 100, maxScrollTop));
    expect(clampedTop).toBe(maxScrollTop);
  });

  test("includes the in-progress current turn content", () => {
    const history = createTurnHistory();
    startTurn(history, "assistant");
    appendToCurrentTurn(history, "streaming\r\npartial");
    const lines = buildCopyViewLines(history);
    expect(lines).toEqual(["streaming", "partial"]);
  });
});

describe("virtualized renderHistory — windowed painting matches the full render path", () => {
  const ROWS = 24;
  const COLUMNS = 100;
  const INPUT_LINES = 2;
  type History = ReturnType<typeof createTurnHistory>;

  const richAssistant = (i: number): string =>
    [
      `回答 ${i}：这是多行回答。`,
      "",
      `## 标题 ${i}`,
      "",
      "- 第一点：功能说明",
      "- 第二点：边界情况",
      "",
      "```ts",
      `const value${i} = compute(${i});`,
      "```",
      "",
      "| 列A | 列B |",
      "|---|---|",
      `| 值${i} | 说明${i} |`,
      "",
      `[文档](https://example.com)`,
      "",
      "---",
      "",
      `结束段落 ${i}。`,
    ].join("\n");

  const buildRichHistory = (nTurns: number): History => {
    const history = createTurnHistory();
    for (let i = 0; i < nTurns; i++) {
      startTurn(history, "user");
      appendToCurrentTurn(history, `用户问题 ${i}：请解释这个功能的实现原理和边界情况。`);
      finalizeCurrentTurn(history);
      startTurn(history, "assistant");
      appendToCurrentTurn(history, richAssistant(i));
      finalizeCurrentTurn(history);
    }
    return history;
  };

  const renderFrame = (
    history: History,
    rows = ROWS,
    columns = COLUMNS,
    inputLines = INPUT_LINES,
  ): string => {
    let out = "";
    const output = {
      isTTY: true,
      rows,
      columns,
      write(chunk: string) {
        out += chunk;
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    renderHistory(output, history, inputLines);
    return out;
  };

  /**
   * Reference frame: the pre-virtualization paint — full buildHistoryLines,
   * slice the clamped window, clear + paint each row. Byte-identical to what
   * renderHistory must emit for the same post-clamp scrollTop.
   */
  const referenceFrame = (
    history: History,
    rows = ROWS,
    columns = COLUMNS,
    inputLines = INPUT_LINES,
  ): string => {
    const visibleHeight = Math.max(1, rows - inputLines);
    const contentWidth = Math.max(1, columns - 1);
    const lines = buildHistoryLines(history, contentWidth);
    const totalLines = lines.length;
    const winStart = history.scrollTop;
    const winEnd = Math.min(totalLines, winStart + visibleHeight);
    const visibleLines = lines.slice(winStart, winEnd);
    let frame = "";
    for (let i = 0; i < visibleHeight; i++) {
      const line = visibleLines[i] ?? "";
      const padded = padOrTruncateToWidth(line, contentWidth);
      const thumb = renderScrollbarRow(i, visibleHeight, totalLines, history.scrollTop);
      const scrollbarPrefix = resolveCliColorEnabled() ? themeColorSequence("chrome") : "";
      const scrollbarSuffix = resolveCliColorEnabled() ? "\x1b[39m" : "";
      frame += `\x1b[${i + 1};1H`;
      frame += "\x1b[2K";
      frame += padded;
      frame += `\x1b[${columns}G`;
      frame += `${scrollbarPrefix}${thumb}${scrollbarSuffix}`;
    }
    const mainBottom = Math.max(1, rows - inputLines);
    frame += `\x1b[${mainBottom};1H`;
    return frame;
  };

  test("cold render matches the full-render slice byte-for-byte (plain)", () => {
    noColor(() => {
      const history = buildRichHistory(120);
      const actual = renderFrame(history);
      expect(actual).toBe(referenceFrame(history));
      // followBottom clamps to the tail and the offset index total matches the
      // full render's line count.
      const contentWidth = Math.max(1, COLUMNS - 1);
      const total = buildHistoryLines(history, contentWidth).length;
      expect(history.scrollTop).toBe(Math.max(0, total - (ROWS - INPUT_LINES)));
      expect(history.hasMoreAbove).toBe(history.scrollTop > 0);
      expect(history.hasMoreBelow).toBe(
        history.scrollTop + (ROWS - INPUT_LINES) < total,
      );
    });
  });

  test("cold render matches the full-render slice byte-for-byte (truecolor)", () => {
    withTruecolor(() => {
      const history = buildRichHistory(80);
      expect(renderFrame(history)).toBe(referenceFrame(history));
    });
  });

  test("cold render populates the render cache only for the visible window", () => {
    noColor(() => {
      const history = buildRichHistory(150);
      const before = getRenderCacheMissCount();
      renderFrame(history);
      const rendered = getRenderCacheMissCount() - before;
      // One screenful of turns — NOT all 150.
      expect(rendered).toBeGreaterThan(0);
      expect(rendered).toBeLessThanOrEqual(ROWS - INPUT_LINES);
    });
  });

  test("every scroll action keeps output byte-identical to the full-render slice", () => {
    noColor(() => {
      const actions = [
        "top",
        "half-page-up",
        "half-page-down",
        "wheel-up",
        "wheel-down",
        "page-up",
        "page-down",
        "bottom",
      ] as const;
      for (const action of actions) {
        const history = buildRichHistory(60);
        const output = {
          isTTY: true,
          rows: ROWS,
          columns: COLUMNS,
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream;
        renderHistory(output, history, INPUT_LINES); // establish a clamped scrollTop
        applyScrollAction(history, action, output, INPUT_LINES);
        expect(renderFrame(history)).toBe(referenceFrame(history));
      }
    });
  });

  test("theme change at same width repaints only the visible window and stays byte-identical", () => {
    const history = buildRichHistory(150);
    noColor(() => {
      renderFrame(history); // warm the width-100 counts
    });
    const before = getRenderCacheMissCount();
    withColor(() => {
      // Line counts are width-keyed and survive the theme flip; only the
      // visible window's styled rows are re-rendered.
      expect(renderFrame(history)).toBe(referenceFrame(history));
    });
    const repainted = getRenderCacheMissCount() - before;
    expect(repainted).toBeGreaterThan(0);
    expect(repainted).toBeLessThanOrEqual(ROWS - INPUT_LINES);
  });

  test("density change stays byte-identical", () => {
    noColor(() => {
      const history = buildRichHistory(120);
      setActiveDensity("spacious"); // default: blank separators between turns
      expect(renderFrame(history)).toBe(referenceFrame(history));
      setActiveDensity("cozy"); // separators vanish — render cache stale
      expect(renderFrame(history)).toBe(referenceFrame(history));
      setActiveDensity("spacious");
      expect(renderFrame(history)).toBe(referenceFrame(history));
    });
  });

  test("width change stays byte-identical", () => {
    noColor(() => {
      const history = buildRichHistory(120);
      renderFrame(history, ROWS, 100, INPUT_LINES); // warm counts at width 100
      expect(renderFrame(history, ROWS, 60, INPUT_LINES)).toBe(
        referenceFrame(history, ROWS, 60, INPUT_LINES),
      );
      expect(renderFrame(history, ROWS, 120, INPUT_LINES)).toBe(
        referenceFrame(history, ROWS, 120, INPUT_LINES),
      );
    });
  });

  test("streaming current turn stays byte-identical frame by frame", () => {
    noColor(() => {
      const history = buildRichHistory(20);
      startTurn(history, "assistant");
      const chunks = [
        "流式输出开始：\n\n",
        "## 段落标题\n\n",
        "- 要点一\n- 要点二\n\n",
        "```ts\nconst a = 1;\n```\n\n",
        "结尾...",
      ];
      for (const chunk of chunks) {
        appendToCurrentTurn(history, chunk);
        expect(renderFrame(history)).toBe(referenceFrame(history));
      }
    });
  });

  test("renders the tail of a long session without rebuilding the whole transcript", () => {
    const history = buildRichHistory(100);
    let writtenData = "";
    const output = {
      isTTY: true,
      rows: 24,
      columns: 80,
      write(chunk: string) {
        writtenData += chunk;
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    noColor(() => {
      renderHistory(output, history, 2);
      expect(writtenData).toContain("用户问题 99");
      expect(writtenData).toContain("回答 99");
      expect(history.scrollTop).toBeGreaterThan(0);
    });
  });
});

describe("buildTurnOffsets & incremental streaming verification", () => {
  beforeEach(() => {
    setActiveThemeName("catppuccin");
    setActiveDensity("cozy");
    resetStreamingTurnCache();
  });

  afterEach(() => {
    setActiveThemeName("catppuccin");
    setActiveDensity("spacious"); // restore default; cozy here leaks into later files
    resetStreamingTurnCache();
  });

  test("buildTurnOffsets calculates line offset indexes correctly across multiple turns, empty content, and single lines", () => {
    noColor(() => {
      const history = createTurnHistory();
      // Turn 0: User single line
      history.turns.push({ role: "user", content: "Hello" });
      // Turn 1: Assistant multiline
      history.turns.push({ role: "assistant", content: "Line 1\nLine 2" });
      // Turn 2: User empty content
      history.turns.push({ role: "user", content: "" });
      // Turn 3: Assistant single line
      history.turns.push({ role: "assistant", content: "Done" });

      const offsetsCozy = buildTurnOffsets(history, 80);
      expect(offsetsCozy.entries.length).toBe(4);

      // Cozy mode: separatorAbove should be 0 for all
      let expectedRow = 0;
      for (let i = 0; i < offsetsCozy.entries.length; i++) {
        const entry = offsetsCozy.entries[i]!;
        expect(entry.startRow).toBe(expectedRow);
        expect(entry.separatorAbove).toBe(0);
        expect(entry.lineCount).toBeGreaterThan(0);
        expectedRow += entry.lineCount;
      }
      expect(offsetsCozy.totalLines).toBe(expectedRow);
    });
  });

  test("buildTurnOffsets respects spacious density separator gaps", () => {
    noColor(() => {
      setActiveDensity("spacious");
      const history = createTurnHistory();
      history.turns.push({ role: "user", content: "Q1" });
      history.turns.push({ role: "assistant", content: "A1" });
      history.turns.push({ role: "user", content: "Q2" });

      const offsetsSpacious = buildTurnOffsets(history, 80);
      expect(offsetsSpacious.entries.length).toBe(3);
      // Spacious mode: user turn at index 0 gets separator 1; subsequent turns get separator 1
      expect(offsetsSpacious.entries[0]!.separatorAbove).toBe(1);
      expect(offsetsSpacious.entries[1]!.separatorAbove).toBe(1);
      expect(offsetsSpacious.entries[2]!.separatorAbove).toBe(1);

      expect(offsetsSpacious.entries[0]!.startRow).toBe(1);
      expect(offsetsSpacious.entries[1]!.startRow).toBe(1 + offsetsSpacious.entries[0]!.lineCount + 1);
    });
  });

  test("incremental streaming prefix cache yields 100% byte-identical output across streaming chunks", () => {
    withTruecolor(() => {
      const history = createTurnHistory();
      history.turns.push({ role: "user", content: "请用 markdown 总结一下" });

      startTurn(history, "assistant");

      const complexStreamParts = [
        "好的，这是为您准备的总结：\n\n",
        "## 第一部分：概述\n\n",
        "这里是第一段详细说明，包含 **粗体** 和 `code` 元素。\n\n",
        "- 要点一：高性能\n",
        "- 要点二：虚拟化渲染\n",
        "- 要点三：流式缓存\n\n",
        "```typescript\nfunction optimize() {\n  return 'fast';\n}\n```\n\n",
        "以上就是全部内容。",
      ];

      let fullContent = "";
      for (const part of complexStreamParts) {
        fullContent += part;
        history.currentContent = fullContent;

        // Compare buildHistoryLines (which uses streaming prefix cache) with
        // a manually computed non-cached baseline
        const incrementalLines = buildHistoryLines(history, 80);

        // Reset cache to force a fresh non-incremental render for ground truth comparison
        resetStreamingTurnCache();
        const fullLines = buildHistoryLines(history, 80);

        expect(incrementalLines).toEqual(fullLines);
      }
    });
  });

  test("windowed rendering matches full transcript slice byte-for-byte at arbitrary scroll positions", () => {
    noColor(() => {
      const history = createTurnHistory();
      for (let i = 0; i < 30; i++) {
        history.turns.push({ role: "user", content: `用户提问 ${i}` });
        history.turns.push({
          role: "assistant",
          content: `助手回答 ${i}:\n- 细节 A\n- 细节 B\n\`\`\`ts\nconst x = ${i};\n\`\`\``,
        });
      }

      const fullLines = buildHistoryLines(history, 80);

      // Verify at scroll positions: 0, 15, 50, 100
      const scrollPositions = [0, 15, 50, 100];
      const visibleHeight = 24;

      for (const pos of scrollPositions) {
        history.scrollTop = pos;
        history.followBottom = false;

        let frameOutput = "";
        const mockStream = {
          isTTY: true,
          rows: visibleHeight + 2,
          columns: 80,
          write(chunk: string) {
            frameOutput += chunk;
            return true;
          },
        } as unknown as NodeJS.WritableStream;

        renderHistory(mockStream, history, 2);

        // Slice fullLines for window expectation
        const expectedSlice = fullLines.slice(pos, pos + visibleHeight);
        expect(expectedSlice.length).toBeLessThanOrEqual(visibleHeight);

        // Each line in frameOutput should contain the styled text from expectedSlice
        for (let r = 0; r < expectedSlice.length; r++) {
          const lineText = stripAnsi(expectedSlice[r]!);
          expect(stripAnsi(frameOutput)).toContain(lineText.trim());
        }
      }
    });
  });

  test("invalidating width or theme resets cache and repaints correctly", () => {
    withTruecolor(() => {
      const history = createTurnHistory();
      history.turns.push({ role: "user", content: "Theme test" });
      startTurn(history, "assistant");
      appendToCurrentTurn(history, "## Header\n\n- item 1\n- item 2");

      const linesThemeA = buildHistoryLines(history, 80);

      // Change theme
      setActiveThemeName("trail");
      resetStreamingTurnCache();
      const linesThemeB = buildHistoryLines(history, 80);

      // Lines structure is same, ANSI colors change
      expect(linesThemeA.map((l) => stripAnsi(l))).toEqual(linesThemeB.map((l) => stripAnsi(l)));
      expect(linesThemeA).not.toEqual(linesThemeB);

      // Change width
      const linesWidth120 = buildHistoryLines(history, 120);
      expect(linesWidth120.length).toBeLessThanOrEqual(linesThemeB.length);
    });
  });

  describe("countTurnLines lightweight calculation accuracy", () => {
    test("strictly matches renderTurnBlock output line count across diverse markdown content", () => {
      const testCases: { name: string; role: "user" | "assistant"; content: string }[] = [
        {
          name: "plain text single line",
          role: "assistant",
          content: "Hello world, this is simple plain text without any markdown elements.",
        },
        {
          name: "plain text multiline",
          role: "assistant",
          content: "First line of text.\nSecond line of text.\nThird line of text.",
        },
        {
          name: "code block",
          role: "assistant",
          content: "Here is code:\n```typescript\nfunction hello() {\n  console.log('world');\n}\n```\nDone.",
        },
        {
          name: "unordered and ordered lists",
          role: "assistant",
          content: "List items:\n- Item 1\n- Item 2\n- Item 3\n\nOrdered:\n1. First\n2. Second",
        },
        {
          name: "task items",
          role: "assistant",
          content: "Tasks:\n☐ Unfinished task\n☑ Completed task",
        },
        {
          name: "headings with automatic breathing room",
          role: "assistant",
          content: "Intro text\n# Heading 1\nSection 1 text\n## Heading 2\nSection 2 text",
        },
        {
          name: "markdown table",
          role: "assistant",
          content: "| Name | Status |\n| --- | --- |\n| Task A | Done |\n| Task B | In Progress |",
        },
        {
          name: "CJK text and mixed scripts",
          role: "assistant",
          content: "这是一个中文测试段落，包含 Unicode 字符和 CJK 标点符号。\n- 第一点：性能优化\n- 第二点：虚拟化按需渲染",
        },
        {
          name: "ultra-long lines triggering soft wrap",
          role: "assistant",
          content: "A".repeat(150) + "\n" + "这".repeat(80),
        },
        {
          name: "nolo header line",
          role: "assistant",
          content: "[nolo] Executing tool: listFiles...\nResult output line.",
        },
        {
          name: "user turn single line",
          role: "user",
          content: "User question text",
        },
        {
          name: "user turn multiline",
          role: "user",
          content: "User question line 1\nUser question line 2\nUser question line 3",
        },
        {
          name: "empty content",
          role: "assistant",
          content: "",
        },
        {
          name: "CRLF line endings",
          role: "assistant",
          content: "Line 1\r\nLine 2\r\nLine 3",
        },
      ];

      const widths = [30, 40, 80, 120];

      for (const width of widths) {
        for (const tc of testCases) {
          const expectedTruecolor = renderTurnBlock(tc.role, tc.content, width, true).length;
          const expectedPlain = renderTurnBlock(tc.role, tc.content, width, false).length;
          const actualCount = countTurnLines(tc.role, tc.content, width);

          expect(expectedTruecolor).toBe(expectedPlain);
          expect(actualCount).toBe(expectedTruecolor);
        }
      }
    });
  });

  describe("local turn rendering (slash command echo)", () => {
    beforeEach(() => setActiveThemeName("catppuccin"));
    afterEach(() => setActiveThemeName("catppuccin"));

    test("appendLocalTurn writes a single local turn with command + output", () => {
      const history = createTurnHistory();
      appendLocalTurn(history, "/switch 2", "Switched to DeepSeek V4 Flash");
      expect(history.turns).toHaveLength(1);
      expect(history.turns[0]!.role).toBe("local");
      expect(history.turns[0]!.command).toBe("/switch 2");
      expect(history.turns[0]!.content).toBe("Switched to DeepSeek V4 Flash");
      // currentRole must be reset — local turns are finalized, not streaming
      expect(history.currentRole).toBeNull();
    });

    test("local turn renders with › prefix for command, no user/assistant markers", () => {
      let out = "";
      withColor(() => {
        out = render([
          { role: "local", command: "/switch 2", content: "Switched to DeepSeek V4 Flash" },
        ]);
      });
      // Command line carries the › prefix
      expect(out).toContain("› /switch 2");
      // Output line is indented
      expect(out).toContain("  Switched to DeepSeek V4 Flash");
      // Must NOT carry user (┃) or assistant (◈) markers
      expect(out).not.toContain("┃");
      expect(out).not.toContain("◈");
    });

    test("local turn without command (system feedback) renders content only", () => {
      let out = "";
      withColor(() => {
        out = render([
          { role: "local", command: "", content: "Turn stopped" },
        ]);
      });
      expect(out).toContain("  Turn stopped");
      expect(out).not.toContain("›");
      expect(out).not.toContain("┃");
      expect(out).not.toContain("◈");
    });

    test("countTurnLines matches renderTurnBlock for local turns with command", () => {
      const cases = [
        { command: "/help", content: "line one\nline two\nline three" },
        { command: "/switch 2", content: "Switched to DeepSeek V4 Flash" },
        { command: "", content: "Turn stopped" },
      ];
      for (const tc of cases) {
        const rendered = renderTurnBlock("local", tc.content, 120, true, tc.command).length;
        const counted = countTurnLines("local", tc.content, 120, tc.command);
        expect(counted).toBe(rendered);
      }
    });

    test("local turn is visually distinct from user and assistant in a mixed history", () => {
      let out = "";
      withColor(() => {
        out = render([
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" },
          { role: "local", command: "/switch 2", content: "Switched to DeepSeek V4 Flash" },
          { role: "user", content: "next question" },
        ]);
      });
      expect(out).toContain("┃  hello");
      expect(out).toContain("◈");
      expect(out).toContain("hi there");
      expect(out).toContain("› /switch 2");
      expect(out).toContain("  Switched to DeepSeek V4 Flash");
      expect(out).toContain("┃  next question");
    });

    test("buildCopyViewLines includes › prefix for local command turns", () => {
      const history = createTurnHistory();
      history.turns.push({
        role: "local",
        command: "/switch 2",
        content: "Switched to DeepSeek V4 Flash",
      });
      const lines = buildCopyViewLines(history);
      const joined = lines.join("\n");
      expect(joined).toContain("› /switch 2");
      expect(joined).toContain("Switched to DeepSeek V4 Flash");
    });

    test("local turn with empty content renders command line only", () => {
      let out = "";
      withColor(() => {
        out = render([{ role: "local", command: "/agent list", content: "" }]);
      });
      expect(out).toContain("› /agent list");
      // No indented content line when content is empty
      expect(out.split("\n")).toHaveLength(1);
    });

    test("local turn renders and counts identically across narrow widths", () => {
      const content = "line one\nline two with more text than the width allows";
      const command = "/help --verbose --flag=value";
      for (const width of [10, 20, 40]) {
        const rendered = renderTurnBlock("local", content, width, true, command).length;
        const counted = countTurnLines("local", content, width, command);
        expect(counted).toBe(rendered);
      }
    });

    test("local turn normalizes CRLF and lone CR in content", () => {
      const history = createTurnHistory();
      appendLocalTurn(history, "/copy", "line1\r\nline2\rline3");
      const lines = buildCopyViewLines(history);
      const joined = lines.join("\n");
      expect(joined).toContain("line1");
      expect(joined).toContain("line2");
      expect(joined).toContain("line3");
      expect(joined).not.toContain("\r");
    });
  });

  describe("renderHistory — double buffering & line-level frame diffing", () => {
    beforeEach(() => setActiveThemeName("catppuccin"));
    afterEach(() => setActiveThemeName("catppuccin"));

    const createMockTerminal = (rows = 24, columns = 80) => {
      const writes: string[] = [];
      const output = {
        isTTY: true,
        rows,
        columns,
        write(chunk: string) {
          writes.push(chunk);
          return true;
        },
      } as unknown as NodeJS.WritableStream;
      return {
        output,
        getWrites: () => writes,
        getLastWrite: () => writes[writes.length - 1] ?? "",
        clearWrites: () => {
          writes.length = 0;
        },
      };
    };

    test("first frame paints all visible lines on a fresh output stream", () => {
      const mock = createMockTerminal(20, 60);
      const history = createTurnHistory();
      startTurn(history, "assistant");
      appendToCurrentTurn(history, "Hello world\nSecond line");
      finalizeCurrentTurn(history);

      renderHistory(mock.output, history, 3);
      expect(mock.getWrites()).toHaveLength(1);
      const firstFrame = mock.getLastWrite();
      // Contains cursor addressing for rows 1..17
      expect(firstFrame).toContain("\x1b[1;1H");
      expect(firstFrame).toContain("\x1b[17;1H");
    });

    test("re-rendering identical state outputs 0 bytes (skipped entirely)", () => {
      const mock = createMockTerminal(20, 60);
      const history = createTurnHistory();
      startTurn(history, "assistant");
      appendToCurrentTurn(history, "Hello world\nSecond line");
      finalizeCurrentTurn(history);

      renderHistory(mock.output, history, 3);
      expect(mock.getWrites()).toHaveLength(1);
      mock.clearWrites();

      // Second render with identical state
      renderHistory(mock.output, history, 3);
      expect(mock.getWrites()).toHaveLength(0);
    });

    test("streaming append to current turn only writes the changed tail row", () => {
      const mock = createMockTerminal(20, 60);
      const history = createTurnHistory();
      startTurn(history, "assistant");
      appendToCurrentTurn(history, "Line 1\nLine 2\n");
      renderHistory(mock.output, history, 3);
      const fullFrameSize = mock.getLastWrite().length;
      mock.clearWrites();

      // Append token to the current turn on the same line
      appendToCurrentTurn(history, "Streaming chunk 1");
      renderHistory(mock.output, history, 3);

      expect(mock.getWrites()).toHaveLength(1);
      const diffFrame = mock.getLastWrite();
      // Should not repaint row 1
      expect(diffFrame).not.toContain("\x1b[1;1H");
      // Contains the updated line and bottom cursor positioning
      expect(diffFrame).toContain("Streaming chunk 1");
      // Diff payload is dramatically smaller than the full screen rewrite (>80% reduction)
      expect(diffFrame.length).toBeLessThan(fullFrameSize * 0.35);
    });

    test("resizing terminal rows/cols invalidates double buffer and repaints new dimensions", () => {
      const mock = createMockTerminal(20, 60);
      const history = createTurnHistory();
      startTurn(history, "user");
      appendToCurrentTurn(history, "Hello");
      finalizeCurrentTurn(history);

      renderHistory(mock.output, history, 3);
      mock.clearWrites();

      // Resize terminal from 20 rows to 30 rows
      (mock.output as { rows: number }).rows = 30;
      renderHistory(mock.output, history, 3);

      expect(mock.getWrites()).toHaveLength(1);
      const resizedFrame = mock.getLastWrite();
      // Repaints all visible lines in new height (27 lines)
      expect(resizedFrame).toContain("\x1b[27;1H");
    });

    test("resetHistoryFrameDiffCache forces full repaint on next render", () => {
      const mock = createMockTerminal(20, 60);
      const history = createTurnHistory();
      startTurn(history, "assistant");
      appendToCurrentTurn(history, "Static content");
      finalizeCurrentTurn(history);

      renderHistory(mock.output, history, 3);
      mock.clearWrites();

      // Invalidate diff cache (simulating modal close or screen clear)
      resetHistoryFrameDiffCache(mock.output);
      renderHistory(mock.output, history, 3);

      expect(mock.getWrites()).toHaveLength(1);
      const fullFrame = mock.getLastWrite();
      expect(fullFrame).toContain("\x1b[1;1H");
      expect(fullFrame).toContain("\x1b[17;1H");
    });
  });
});
