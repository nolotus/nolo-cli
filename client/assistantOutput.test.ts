import { describe, expect, test } from "bun:test";
import {
  convertMarkdownTablesForTerminal,
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
});