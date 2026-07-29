import { describe, expect, test } from "bun:test";
import {
  formatFetchTreeLines,
  formatHomePath,
  formatReadItemPath,
  formatReadTreeLines,
  formatRunTreeLines,
  formatSearchTreeLines,
} from "./formatReadPathTree";

describe("formatReadPathTree", () => {
  test("formatHomePath replaces home directory with ~", () => {
    expect(formatHomePath("/Users/nolotus/bun-nolo/packages/cli/tui/sessionTypes.ts", "/Users/nolotus")).toBe(
      "~/bun-nolo/packages/cli/tui/sessionTypes.ts"
    );
    expect(formatHomePath("/home/user/project/file.ts", "/home/user")).toBe(
      "~/project/file.ts"
    );
  });

  test("formatReadItemPath appends line range selectors when present or from metadata", () => {
    expect(
      formatReadItemPath("/Users/nolotus/bun-nolo/packages/cli/tui/sessionTypes.ts:2-49", undefined, "/Users/nolotus")
    ).toBe("~/bun-nolo/packages/cli/tui/sessionTypes.ts:2-49");

    expect(
      formatReadItemPath(
        "/Users/nolotus/bun-nolo/packages/cli/tui/sessionTypes.ts",
        { startLine: 2, endLine: 49, totalLines: 100, truncated: true },
        "/Users/nolotus"
      )
    ).toBe("~/bun-nolo/packages/cli/tui/sessionTypes.ts:2-49");
  });

  test("formatReadTreeLines constructs spec-compliant tree headers and lines", () => {
    const items = [
      { path: "/Users/nolotus/bun-nolo/packages/cli/tui/sessionTypes.ts:2-49" },
      { path: "/Users/nolotus/bun-nolo/packages/cli/tui/sessionTypes.ts" },
      { path: "/Users/nolotus/bun-nolo/packages/cli/tui/sessionRender.ts" },
      { path: "/Users/nolotus/bun-nolo/packages/cli/tui/readlineWorkspace.ts:203-387,627-1679" },
    ];

    const result = formatReadTreeLines(items, "/Users/nolotus");
    expect(result.header).toBe("Read (4)");
    expect(result.count).toBe(4);
    expect(result.lines).toEqual([
      { connector: "├── ", pathWithRange: "~/bun-nolo/packages/cli/tui/sessionTypes.ts:2-49" },
      { connector: "├── ", pathWithRange: "~/bun-nolo/packages/cli/tui/sessionTypes.ts" },
      { connector: "├── ", pathWithRange: "~/bun-nolo/packages/cli/tui/sessionRender.ts" },
      { connector: "└── ", pathWithRange: "~/bun-nolo/packages/cli/tui/readlineWorkspace.ts:203-387,627-1679" },
    ]);
  });

  test("formatSearchTreeLines constructs tree output for consecutive search queries matching user spec", () => {
    const items = [
      { query: "selectionStart|selectionEnd|setSelectionRange|cursor|caret" },
      { query: "contenteditable|textarea|onInput|onChange.*content|editor|Editor" },
    ];

    const result = formatSearchTreeLines(items);
    expect(result.header).toBe("Search (2)");
    expect(result.count).toBe(2);
    expect(result.lines).toEqual([
      { connector: "├── ", queryText: "selectionStart|selectionEnd|setSelectionRange|cursor|caret" },
      { connector: "└── ", queryText: "contenteditable|textarea|onInput|onChange.*content|editor|Editor" },
    ]);
  });

  test("formatFetchTreeLines builds connectors and url leaves matching spec", () => {
    const items = [
      { url: "https://example.com/page1" },
      { url: "https://example.com/page2" },
      { url: "https://example.com/page3" },
    ];

    const result = formatFetchTreeLines(items);
    expect(result.header).toBe("Fetch (3)");
    expect(result.count).toBe(3);
    expect(result.lines).toEqual([
      { connector: "├── ", urlText: "https://example.com/page1" },
      { connector: "├── ", urlText: "https://example.com/page2" },
      { connector: "└── ", urlText: "https://example.com/page3" },
    ]);
  });

  test("formatFetchTreeLines falls back to webpage for empty url", () => {
    const result = formatFetchTreeLines([{ url: "" }, { url: "   " }]);
    expect(result.header).toBe("Fetch (2)");
    expect(result.lines).toEqual([
      { connector: "├── ", urlText: "webpage" },
      { connector: "└── ", urlText: "webpage" },
    ]);
  });

  test("formatFetchTreeLines truncates long urls to 80 chars", () => {
    const longUrl = `https://example.com/${"a".repeat(100)}`;
    const result = formatFetchTreeLines([{ url: longUrl }]);
    expect(result.count).toBe(1);
    expect(result.lines[0].urlText.length).toBe(80);
    expect(result.lines[0].urlText.endsWith("…")).toBe(true);
    expect(result.lines[0].urlText).toBe(`${longUrl.slice(0, 79)}…`);
  });

  test("formatRunTreeLines compacts multiline commands to single line without raw newlines", () => {
    const multilineCmd = "python3 << 'PYEOF'\np = \"packages/server/handlers/chatProxyRouting.ts\"\ns = open(p).read()";
    const result = formatRunTreeLines([{ command: multilineCmd }]);
    expect(result.count).toBe(1);
    expect(result.lines[0].commandText).not.toContain("\n");
    expect(result.lines[0].commandText).toBe("python3 << 'PYEOF' p = \"packages/server/handlers/chatProxyRouting.ts\" s = open(…");
  });
});
