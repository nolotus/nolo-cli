import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getActiveThemeName, resolveTuiBrightness, setActiveThemeName, themeColorSequence } from "../tui/theme";
import {
  convertMarkdownTablesForTerminal,
  createRenderAwareStreamWriter,
  formatAssistantDisplay,
  polishAssistantStructure,
} from "./assistantOutput";

describe("assistantOutput", () => {
  test("adds spacing around markdown headings", () => {
    // Both sides: a heading flush against its own body read as one block.
    expect(polishAssistantStructure("intro\n## Title\nbody")).toBe(
      "intro\n\n## Title\n\nbody"
    );
    // Existing spacing is preserved, not doubled.
    expect(polishAssistantStructure("intro\n\n## Title\n\nbody")).toBe(
      "intro\n\n## Title\n\nbody"
    );
  });

  test("converts markdown tables into terminal-friendly bullets", () => {
    const table = [
      "| 目录 | 说明 |",
      "|---|---|",
      "| `packages/` | Monorepo 核心包 |",
      "| `docs/` | 文档 |",
    ].join("\n");
    expect(convertMarkdownTablesForTerminal(table)).toBe(
      [
        "  • `packages/` — Monorepo 核心包",
        "  • `docs/` — 文档",
        "",
      ].join("\n")
    );
  });

  test("rich mode styles headings and bold text", () => {
    const rich = formatAssistantDisplay("## Title\n这是 **Nolo** 工作区");
    const brightness = resolveTuiBrightness();
    // Headings are bold + warning at every level; bold-only is inline **bold**.
    expect(rich).toContain(
      `\x1b[1m${themeColorSequence("warning", process.env, brightness)}Title\x1b[0m`
    );
    expect(rich).toContain("\x1b[1mNolo\x1b[0m");
  });

  test("converts orphan table rows and drops orphan separators", () => {
    expect(convertMarkdownTablesForTerminal("| 97220 | native host |")).toBe(
      "  • 97220 — native host"
    );
    expect(convertMarkdownTablesForTerminal("|---|---|")).toBe("");
    // Prose with pipes is not a table row.
    expect(convertMarkdownTablesForTerminal("a | b")).toBe("a | b");
  });

  test("normalizes unordered list markers to bullet", () => {
    expect(convertMarkdownTablesForTerminal("- first\n* second\n+ third")).toBe(
      "• first\n• second\n• third"
    );
  });

  test("preserves ordered list numbers", () => {
    expect(convertMarkdownTablesForTerminal("1. first\n2. second\n3. third")).toBe(
      "1. first\n2. second\n3. third"
    );
  });

  test("preserves nested list indentation", () => {
    const nested = [
      "- top",
      "  - child",
      "    - grandchild",
      "1. ordered top",
      "  2. ordered child",
    ].join("\n");
    expect(convertMarkdownTablesForTerminal(nested)).toBe(
      [
        "• top",
        "  • child",
        "    • grandchild",
        "1. ordered top",
        "  2. ordered child",
      ].join("\n")
    );
  });

  test("leaves non-list lines untouched", () => {
    expect(convertMarkdownTablesForTerminal("just plain text")).toBe("just plain text");
    expect(convertMarkdownTablesForTerminal("- not a list-dash in mid")).toBe(
      "• not a list-dash in mid"
    );
    // Lines with dash not at start are not list items
    expect(convertMarkdownTablesForTerminal("text - with dash")).toBe("text - with dash");
  });

  test("converts task list checkboxes to symbols", () => {
    expect(convertMarkdownTablesForTerminal("- [ ] undone")).toBe("☐ undone");
    expect(convertMarkdownTablesForTerminal("- [x] done")).toBe("☑ done");
    expect(convertMarkdownTablesForTerminal("* [X] capital done")).toBe("☑ capital done");
    // Nested task list keeps indentation
    expect(convertMarkdownTablesForTerminal("  - [ ] nested")).toBe("  ☐ nested");
    // Task list takes priority over unordered marker normalization
    expect(convertMarkdownTablesForTerminal("- [ ] a\n- [x] b")).toBe("☐ a\n☑ b");
  });

  test("leaves fenced code blocks untouched", () => {
    const text = [
      "```ts",
      "| a | b |",
      "  indented();",
      "```",
    ].join("\n");
    expect(convertMarkdownTablesForTerminal(text)).toBe(text);
    const rich = formatAssistantDisplay(text);
    // Code-block syntax highlighting now interleaves ANSI between characters,
    // so a contiguous-content substring assertion is no longer possible. The
    // intent these assertions guard (indentation preserved, table-like lines
    // NOT converted to bullets) still holds — verify against the ANSI-stripped
    // text instead of the raw colored output.
    const stripped = rich.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toContain("| a | b |");
    expect(stripped).toContain("  indented();");
    expect(rich).toContain("\x1b[2m```ts\x1b[0m");
  });

  test("rich mode styles inline code spans with the muted token, not info", () => {
    const rich = formatAssistantDisplay("run `nolo update` now");
    const brightness = resolveTuiBrightness();
    // Pin the actual token. The previous version of this test only checked
    // that the text survived and that some reset was emitted, so it stayed
    // green while inline code was rendered in the same bright info hue as
    // code blocks — the regression this assertion exists to catch.
    expect(rich).toContain(
      `${themeColorSequence("muted", process.env, brightness)}nolo update\x1b[0m`
    );
    expect(rich).not.toContain(themeColorSequence("info", process.env, brightness));
  });

  test("rich mode renders markdown links as OSC 8 clickable hyperlinks", () => {
    const rich = formatAssistantDisplay("See [docs](https://nolo.chat/docs) here");
    // OSC 8 escape wraps the visible text — Cmd/Ctrl-Click opens the URL in
    // supporting terminals (iTerm2, Ghostty, WezTerm, etc.).
    expect(rich).toContain("\x1b]8;;https://nolo.chat/docs\x1b\\");
    expect(rich).toContain("docs (https://nolo.chat/docs)");
    expect(rich).toContain("\x1b]8;;\x1b\\");
  });

  test("stream writer never leaks raw table pipes", () => {
    const chunks: string[] = [];
    const writer = createRenderAwareStreamWriter({
      write: (chunk) => chunks.push(chunk),
    });

    writer.push("| pid | 说明 |\n");
    writer.push("|---|---|\n");
    writer.push("| 97220 | native host |\n");
    writer.push("done\n");
    writer.flush();

    const output = chunks.join("");
    // Bullet marker is now accent-colored; check content is present and pipes gone.
    expect(output).toContain("97220 — native host");
    expect(output).toContain("•");
    expect(output).not.toContain("| pid |");
  });

  test("stream writer passes fenced code through with indentation", () => {
    const chunks: string[] = [];
    const writer = createRenderAwareStreamWriter({
      write: (chunk) => chunks.push(chunk),
    });

    writer.push("```ts\n  const x = 1;\n| not a table |\n```\n");
    writer.flush();

    const output = chunks.join("");
    // Code-block syntax highlighting now interleaves ANSI between characters,
    // so a contiguous-content substring assertion is no longer possible. The
    // intent (indentation preserved, table-like lines inside fences not
    // converted) still holds — verify against ANSI-stripped output.
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toContain("  const x = 1;");
    expect(stripped).toContain("| not a table |");
  });

  test("render-aware stream writer applies rich formatting while streaming", () => {
    const chunks: string[] = [];
    const writer = createRenderAwareStreamWriter({
      write: (chunk) => chunks.push(chunk),
    });

    writer.push("## Title\n");
    writer.push("这是 **Nolo**");
    writer.flush();

    const output = chunks.join("");
    expect(output).toContain(
      `\x1b[1m${themeColorSequence("warning", process.env, resolveTuiBrightness())}Title\x1b[0m`
    );
    expect(output).toContain("\x1b[1mNolo\x1b[0m");
  });

  test("stream writer inserts blank line between list block and following prose", () => {
    // Live TUI streams one finished line at a time — without stream-path
    // breathing, polishAssistantStructure never sees the list↔prose pair and
    // the dense wall the owner reported stays dense. Strip ANSI and assert
    // the same blank the whole-message path inserts.
    const chunks: string[] = [];
    const writer = createRenderAwareStreamWriter({
      write: (chunk) => chunks.push(chunk),
    });
    writer.push("intro\n");
    writer.push("- one\n");
    writer.push("- two\n");
    writer.push("next paragraph\n");
    writer.flush();
    const stripped = chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toBe("intro\n\n• one\n• two\n\nnext paragraph\n");
  });

  test("inserts blank line between list block and following prose", () => {
    // A bullet list run-on into the next paragraph is the core readability
    // problem this task targets; the polish step inserts one blank line.
    expect(polishAssistantStructure("• one\n• two\nnext paragraph")).toBe(
      "• one\n• two\n\nnext paragraph"
    );
    expect(polishAssistantStructure("1. first\n2. second\nthen prose")).toBe(
      "1. first\n2. second\n\nthen prose"
    );
  });

  test("inserts blank line between prose and following list block", () => {
    // Symmetric: prose running straight into a list is just as unreadable.
    expect(polishAssistantStructure("intro\n• one\n• two")).toBe(
      "intro\n\n• one\n• two"
    );
    expect(polishAssistantStructure("intro\n1. first\n2. second")).toBe(
      "intro\n\n1. first\n2. second"
    );
  });

  test("does not insert blank lines between consecutive list items", () => {
    // Siblings keep their tight grouping — no blank between `• one` and
    // `• two`, including with nesting indentation.
    expect(polishAssistantStructure("• one\n• two\n• three")).toBe(
      "• one\n• two\n• three"
    );
    expect(polishAssistantStructure("• top\n • child\n • grandchild")).toBe(
      "• top\n • child\n • grandchild"
    );
    expect(polishAssistantStructure("1. first\n2. second")).toBe(
      "1. first\n2. second"
    );
  });

  test("treats circled-number ①-⑳ section markers as list-like for breathing", () => {
    // ①-⑳ (U+2460–U+2473) are used as section markers like `①CLI 自动 bump`.
    // They must join the list↔prose breathing so a ① block is separated from
    // adjacent prose by one blank line, while consecutive ① lines stay tight.
    // Note: the circled number is followed directly by text with NO space, so
    // the list-like check must not require `\s` after it.
    expect(polishAssistantStructure("intro\n①CLI 自动 bump\n②docs\nnext")).toBe(
      "intro\n\n①CLI 自动 bump\n②docs\n\nnext"
    );
    // Consecutive ① siblings keep tight grouping (no blank between them).
    expect(polishAssistantStructure("①one\n②two\n③three")).toBe(
      "①one\n②two\n③three"
    );
    // ① block breathing is symmetric: prose → ① also gets a blank line.
    expect(polishAssistantStructure("prose here\n①first\n②second")).toBe(
      "prose here\n\n①first\n②second"
    );
  });

  test("does not alter spacing inside fenced code that looks like a list", () => {
    // Fence interior masking means `•`/`1.` inside a code block never get
    // blank lines inserted around them.
    const input = "```ts\n• not a real list\n1. not ordered\ncode();\n```";
    expect(polishAssistantStructure(input)).toBe(input);
    // List immediately before a fence gets a blank line (list↔fence-line is
    // list↔prose); the fence interior stays untouched.
    const mixed = "• one\n• two\n```ts\n1. inside\n```";
    expect(polishAssistantStructure(mixed)).toBe(
      "• one\n• two\n\n```ts\n1. inside\n```"
    );
  });

  test("styles ordered list markers with accent", () => {
    // `1.` should be accent-colored like a bullet, body still inline-markdown.
    const rich = formatAssistantDisplay("1. first step");
    const brightness = resolveTuiBrightness();
    expect(rich).toContain(
      `${themeColorSequence("accent", process.env, brightness)}1.\x1b[0m`
    );
    expect(rich).toContain("first step");
  });

  test("styles task list checkbox markers with accent", () => {
    // ☐/☑ markers get the same accent as • so task lists scan like bullets.
    const brightness = resolveTuiBrightness();
    const todo = formatAssistantDisplay("☐ undone");
    const done = formatAssistantDisplay("☑ done");
    expect(todo).toContain(
      `${themeColorSequence("accent", process.env, brightness)}☐\x1b[0m`
    );
    expect(done).toContain(
      `${themeColorSequence("accent", process.env, brightness)}☑\x1b[0m`
    );
  });

  test("rich mode renders italic markers as dim without leaking asterisks", () => {
    // *italic* should lose the asterisks and gain dim styling. **bold** must
    // still take priority — a single bold run should not be half-consumed by
    // the italic rule.
    const rich = formatAssistantDisplay("this is *important* text");
    expect(rich).toContain("\x1b[2mimportant\x1b[0m");
    expect(rich).not.toContain("*important*");
    // Bold is untouched by the italic pass.
    const bold = formatAssistantDisplay("**bold** and *italic*");
    expect(bold).toContain("\x1b[1mbold\x1b[0m");
    expect(bold).toContain("\x1b[2mitalic\x1b[0m");
  });

  test("rich mode does not corrupt snake_case identifiers as italic", () => {
    // _italic_ is intentionally NOT supported (CommonMark intra-word rule).
    // snake_case variables like foo_bar_baz must pass through untouched —
    // no dim styling injected on the middle segment.
    const snake = formatAssistantDisplay("call foo_bar_baz here");
    expect(snake).not.toContain("\x1b[2mbar\x1b[0m");
    expect(snake).toContain("foo_bar_baz");
  });

  test("rich mode renders strikethrough markers as dim+strike without leaking tildes", () => {
    const rich = formatAssistantDisplay("this is ~~removed~~ text");
    expect(rich).toContain("\x1b[2m\x1b[9mremoved");
    expect(rich).not.toContain("~~removed~~");
  });

  test("rich mode dims the 进入 nolo-plan status line with chrome", () => {
    // Repo convention forces every reply to start with "进入 nolo-plan…"；
    // back-to-back replies stack these into visual noise. The status line is
    // downgraded to chrome + dim so it sits below body text. Must match
    // highlightMarkdown in tui/theme.ts (stream vs history repaint parity).
    const brightness = resolveTuiBrightness();
    const rich = formatAssistantDisplay("进入 nolo-plan（4 项串行小改）。");
    expect(rich).toContain(
      `${themeColorSequence("chrome", process.env, brightness)}\x1b[2m进入 nolo-plan（4 项串行小改）。`
    );
    // Not bold (body text isn't, and it must read as de-emphasized).
    expect(rich).not.toContain("\x1b[1m");
  });

  describe("polishAssistantStructure code fence masking", () => {
    test("1. shell comments in code fence are not expanded with blank lines", () => {
      const input = "```sh\n# setup\necho ok\n```";
      expect(polishAssistantStructure(input)).toBe(input);
    });

    test("2. multi-level heading inside py block stays intact", () => {
      const input = "```py\n### section\nx=1\n```";
      expect(polishAssistantStructure(input)).toBe(input);
    });

    test("3. real heading outside code fence still receives blank lines", () => {
      expect(polishAssistantStructure("intro\n## Title\nbody")).toBe(
        "intro\n\n## Title\n\nbody"
      );
    });

    test("4. mixed scenario: heading outside gets blank lines, comment inside does not", () => {
      const input = "intro\n## Real\n```sh\n# fake\nls\n```\ntail";
      const expected = "intro\n\n## Real\n\n```sh\n# fake\nls\n```\ntail";
      expect(polishAssistantStructure(input)).toBe(expected);
    });

    test("5. consecutive blank lines inside code fence are preserved", () => {
      const input = "```sh\nline1\n\n\n\n\nline2\n```";
      expect(polishAssistantStructure(input)).toBe(input);
    });

    test("6. unclosed fence masks comments through end of text", () => {
      const input = "intro\n```sh\n# setup\necho ok";
      const expected = "intro\n```sh\n# setup\necho ok";
      expect(polishAssistantStructure(input)).toBe(expected);
    });

    test("7. zero regression for text without code fences", () => {
      const input = "paragraph 1\n## Heading 1\nsome text\n### Heading 2\n\nfinal text";
      const expected = "paragraph 1\n\n## Heading 1\n\nsome text\n\n### Heading 2\n\nfinal text";
      expect(polishAssistantStructure(input)).toBe(expected);
    });

    test("8. a literal NUL in code content cannot be mistaken for a mask sentinel", () => {
      // The mask encodes fence interiors as \x00F<n>\x00. Content that already
      // contained that shape would be restored as the wrong line, so NUL is
      // stripped before masking rather than trusting callers to sanitize.
      const NUL = String.fromCharCode(0);
      const source = ["```sh", `${NUL}F0${NUL}`, "# a", "echo ok", "```"].join("\n");
      const out = polishAssistantStructure(source, { trimEdges: false });
      expect(out).not.toContain(NUL);
      // The fence protection still holds: the comment is not padded.
      expect(out).not.toContain("\n\n# a");
      expect(out).toContain("echo ok");
    });
  });
});

describe("code block syntax highlighting", () => {
  // Pin trail so accent ≠ info; catppuccin and iris map both tokens to the
  // same sequence, which makes the keyword-vs-identifier assertion vacuous
  // and order-dependent on whatever theme a prior file left active.
  let prevTheme: string;
  beforeAll(() => {
    prevTheme = getActiveThemeName();
    setActiveThemeName("trail");
  });
  afterAll(() => setActiveThemeName(prevTheme));

  const brightness = resolveTuiBrightness();
  const seq = (token: "accent" | "success" | "chrome" | "warning" | "info") =>
    themeColorSequence(token, process.env, brightness);
  const fence = (lang: string, body: string) => ["```" + lang, body, "```"].join("\n");
  /** The rendered line for `body`, i.e. everything between the fence rows. */
  const codeLine = (lang: string, body: string) =>
    formatAssistantDisplay(fence(lang, body)).split("\n")[1] ?? "";

  test("an unlabeled fence is left exactly as it was before highlighting", () => {
    // Zero-regression guarantee: blocks with no language tag must keep the old
    // single-color treatment, so nothing changes for the majority of replies
    // that omit the tag.
    const line = codeLine("", "const plain = 2;");
    expect(line).toBe(`${seq("info")}const plain = 2;\x1b[0m`);
  });

  test("keywords are accented while identifiers stay in the base color", () => {
    const line = codeLine("ts", "const answer = 1;");
    expect(line).toContain(`${seq("accent")}const`);
    // The identifier must not be keyword-colored.
    expect(line).not.toContain(`${seq("accent")}answer`);
    expect(line).toContain(`${seq("warning")}1`);
  });

  test("keywords inside a string are not highlighted as keywords", () => {
    // The classic failure of a naive highlighter: matching keywords before
    // carving out string regions paints "def" inside the quoted text.
    const line = codeLine("py", 'x = "def not_a_keyword"');
    expect(line).toContain(`${seq("success")}"def not_a_keyword"`);
    expect(line).not.toContain(`${seq("accent")}def`);
  });

  test("trailing comments are dimmed chrome", () => {
    const line = codeLine("sh", "echo hi # comment");
    expect(line).toContain(`${seq("chrome")}\x1b[2m# comment`);
  });

  test("streaming and whole-message rendering agree on code lines", () => {
    // The two renderers have separate fence bookkeeping; if they drift, a reply
    // looks different while streaming than it does after /resume replays it.
    const source = fence("ts", "const x = 1; // note");
    const chunks: string[] = [];
    const writer = createRenderAwareStreamWriter({
      write: (chunk) => chunks.push(chunk),
    });
    for (const char of source) writer.push(char);
    writer.flush();
    const streamedCode = chunks
      .join("")
      .split("\n")
      .find((line) => line.includes("const"));
    expect(streamedCode).toBe(codeLine("ts", "const x = 1; // note"));
  });
});

describe("diff fence rendering", () => {
  const DIFF_BODY = [
    "@@ -1,2 +1,3 @@",
    "-old line",
    "+new line",
    " context line",
    "+++ b/file",
    "--- a/file",
  ];

  /** Run `fn` with a controlled env, restoring the previous env afterwards. */
  const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
    const prev = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(env)) {
      prev.set(k, process.env[k]);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  const truecolorEnv = { COLORTERM: "truecolor", NOLO_TUI_THEME: "dark" };

  test("streamed diff lines are byte-identical to a whole-message redraw", () => {
    // The stream path (createRenderAwareStreamWriter → highlightCodeLine) and
    // the redraw path (formatAssistantDisplay → highlightCodeLine) must paint
    // the same escape sequences per line, or a reply recolors on scroll-back.
    withEnv(truecolorEnv, () => {
      const source = ["```diff", ...DIFF_BODY, "```"].join("\n");

      const redraw = formatAssistantDisplay(source);

      const chunks: string[] = [];
      const writer = createRenderAwareStreamWriter({
        write: (chunk) => chunks.push(chunk),
      });
      for (const line of source.split("\n")) writer.push(line + "\n");
      writer.flush();

      // Fence interior only (indices 1..6).
      expect(chunks.join("").split("\n").slice(1, 7)).toEqual(
        redraw.split("\n").slice(1, 7)
      );
    });
  });

  test("truecolor diff lines carry a background tint (48;2)", () => {
    withEnv(truecolorEnv, () => {
      const line =
        formatAssistantDisplay("```diff\n+new line\n```").split("\n")[1] ?? "";
      expect(line).toContain("\x1b[48;2"); // background tint
      expect(line).toContain("\x1b[38;2"); // foreground color
    });
  });

  test("diff lines end with \\x1b[0m so the tint never leaks", () => {
    withEnv(truecolorEnv, () => {
      const lines = formatAssistantDisplay(
        ["```diff", "-gone", "+added", "```"].join("\n")
      ).split("\n");
      for (const line of lines.slice(1, 3)) {
        expect(line).toMatch(/\x1b\[0m$/); // full reset (fg + bg)
        expect(line.endsWith("\x1b[39m")).toBe(false); // fg-only reset would leak the tint
      }
    });
  });

  test("+++ / --- headers are context, not added/removed", () => {
    withEnv(truecolorEnv, () => {
      const lines = formatAssistantDisplay(
        ["```diff", "+++ b/file", "--- a/file", "+real add", "-real del", "```"].join("\n")
      ).split("\n");
      // +++/--- headers share the exact context wrapper (no fg, no bg)…
      expect(lines[1]!.replace("+++ b/file", "--- a/file")).toBe(lines[2]);
      expect(lines[1]).not.toContain("38;2");
      expect(lines[1]).not.toContain("48;2");
      // …while genuine added/removed rows carry fg + bg colors.
      expect(lines[3]).toContain("38;2");
      expect(lines[3]).toContain("48;2");
      expect(lines[4]).toContain("38;2");
      expect(lines[4]).toContain("48;2");
    });
  });

  test("non-truecolor diff lines have no background (no 48;2)", () => {
    withEnv(
      {
        COLORTERM: "xterm-256color",
        NOLO_TUI_TRUECOLOR: "0",
        NOLO_TUI_THEME: "dark",
      },
      () => {
        const lines = formatAssistantDisplay(
          ["```diff", "+added", "-removed", "```"].join("\n")
        ).split("\n");
        expect(lines[1]).not.toContain("48;2");
        expect(lines[2]).not.toContain("48;2");
        // Degraded path still colors the foreground (ANSI-16 fallback).
        expect(lines[1]).toMatch(/\x1b\[3[0-9]m/);
        expect(lines[2]).toMatch(/\x1b\[3[0-9]m/);
      }
    );
  });
});
