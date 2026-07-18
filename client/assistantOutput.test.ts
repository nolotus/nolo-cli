import { describe, expect, test } from "bun:test";
import {
  convertMarkdownTablesForTerminal,
  createRenderAwareStreamWriter,
  formatAssistantDisplay,
  normalizeRenderDisplayMode,
  polishAssistantStructure,
} from "./assistantOutput";

describe("assistantOutput", () => {
  test("adds spacing before markdown headings", () => {
    expect(polishAssistantStructure("intro\n## Title\nbody")).toBe(
      "intro\n\n## Title\nbody"
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
    expect(rich).toContain("\x1b[1mTitle\x1b[0m");
    expect(rich).toContain("\x1b[1mNolo\x1b[0m");
    expect(formatAssistantDisplay("## Title\nplain body", "plain")).toBe(
      "## Title\nplain body"
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
    expect(rich).toContain("| a | b |");
    expect(rich).toContain("  indented();");
    expect(rich).toContain("\x1b[2m```ts\x1b[0m");
  });

  test("rich mode styles inline code spans", () => {
    const rich = formatAssistantDisplay("run `nolo update` now", "rich");
    // Info token wraps inline code with the theme color (truecolor in
    // environments that support it, ANSI-16 fallback otherwise).
    expect(rich).toMatch(/nolo update/);
    expect(rich).toContain("\x1b[0m");
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
    expect(output).toContain("  • 97220 — native host");
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
    expect(output).toContain("  const x = 1;\n");
    expect(output).toContain("| not a table |\n");
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
    expect(output).toContain("\x1b[1mTitle\x1b[0m");
    expect(output).toContain("\x1b[1mNolo\x1b[0m");
  });
});