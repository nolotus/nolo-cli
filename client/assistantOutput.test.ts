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
    expect(rich).toContain("\x1b[36mnolo update\x1b[0m");
    expect(formatAssistantDisplay("run `nolo update` now", "plain")).toBe(
      "run `nolo update` now"
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