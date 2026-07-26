import { describe, expect, test } from "bun:test";
import { resolveTuiBrightness, themeColorSequence } from "../tui/theme";
import {
  convertMarkdownTablesForTerminal,
  createRenderAwareStreamWriter,
  formatAssistantDisplay,
  normalizeRenderDisplayMode,
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
    expect(normalizeRenderDisplayMode(undefined)).toBe("rich");
    const rich = formatAssistantDisplay("## Title\n这是 **Nolo** 工作区", "rich");
    const brightness = resolveTuiBrightness();
    // Headings are bold + warning at every level; bold-only is inline **bold**.
    expect(rich).toContain(
      `\x1b[1m${themeColorSequence("warning", process.env, brightness)}Title\x1b[0m`
    );
    expect(rich).toContain("\x1b[1mNolo\x1b[0m");
    expect(formatAssistantDisplay("## Title\nplain body", "plain")).toBe(
      "## Title\n\nplain body"
    );
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
    const rich = formatAssistantDisplay(text, "rich");
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
    const rich = formatAssistantDisplay("run `nolo update` now", "rich");
    const brightness = resolveTuiBrightness();
    // Pin the actual token. The previous version of this test only checked
    // that the text survived and that some reset was emitted, so it stayed
    // green while inline code was rendered in the same bright info hue as
    // code blocks — the regression this assertion exists to catch.
    expect(rich).toContain(
      `${themeColorSequence("muted", process.env, brightness)}nolo update\x1b[0m`
    );
    expect(rich).not.toContain(themeColorSequence("info", process.env, brightness));
    expect(formatAssistantDisplay("run `nolo update` now", "plain")).toBe(
      "run `nolo update` now"
    );
  });

  test("rich mode renders markdown links as OSC 8 clickable hyperlinks", () => {
    const rich = formatAssistantDisplay("See [docs](https://nolo.chat/docs) here", "rich");
    // OSC 8 escape wraps the visible text — Cmd/Ctrl-Click opens the URL in
    // supporting terminals (iTerm2, Ghostty, WezTerm, etc.).
    expect(rich).toContain("\x1b]8;;https://nolo.chat/docs\x1b\\");
    expect(rich).toContain("docs (https://nolo.chat/docs)");
    expect(rich).toContain("\x1b]8;;\x1b\\");
  });

  test("plain mode leaves links as raw markdown", () => {
    expect(formatAssistantDisplay("See [docs](https://nolo.chat/docs) here", "plain")).toBe(
      "See [docs](https://nolo.chat/docs) here"
    );
  });

  test("stream writer never leaks raw table pipes", () => {
    const chunks: string[] = [];
    const writer = createRenderAwareStreamWriter({
      write: (chunk) => chunks.push(chunk),
      renderMode: "rich",
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
      renderMode: "rich",
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
      renderMode: "rich",
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
});

describe("code block syntax highlighting", () => {
  const brightness = resolveTuiBrightness();
  const seq = (token: "accent" | "success" | "chrome" | "warning" | "info") =>
    themeColorSequence(token, process.env, brightness);
  const fence = (lang: string, body: string) => ["```" + lang, body, "```"].join("\n");
  /** The rendered line for `body`, i.e. everything between the fence rows. */
  const codeLine = (lang: string, body: string) =>
    formatAssistantDisplay(fence(lang, body), "rich").split("\n")[1] ?? "";

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

  test("plain render mode emits no color inside code blocks", () => {
    const out = formatAssistantDisplay(fence("ts", "const x = 1;"), "plain");
    expect(out).not.toContain("\x1b");
  });

  test("streaming and whole-message rendering agree on code lines", () => {
    // The two renderers have separate fence bookkeeping; if they drift, a reply
    // looks different while streaming than it does after /resume replays it.
    const source = fence("ts", "const x = 1; // note");
    const chunks: string[] = [];
    const writer = createRenderAwareStreamWriter({
      write: (chunk) => chunks.push(chunk),
      renderMode: "rich",
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
