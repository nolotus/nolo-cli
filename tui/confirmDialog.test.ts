import { afterEach, describe, expect, test } from "bun:test";
import type { PermissionRequest } from "../agent-runtime/actionGate";
import { getCliLocale, setCliLocale } from "./i18n";
import { runConfirmDialog } from "./confirmDialog";

describe("runConfirmDialog", () => {
  const originalLocale = getCliLocale();
  afterEach(() => setCliLocale(originalLocale));

  const baseRequest: PermissionRequest = {
    id: "permission-shell-destructive-action",
    tool: "execShell",
    action: "destructive_shell_command",
    title: "确认执行破坏性 shell 命令",
    body: "该命令可能删除或重置用户内容，需要用户明确确认后才能执行。",
  };

  function makeStreams() {
    const input = {
      isTTY: true,
      setRawMode: () => {},
      on: () => {},
      off: () => {},
      resume: () => {},
      pause: () => {},
      read: () => null,
    } as unknown as NodeJS.ReadStream;
    const chunks: string[] = [];
    const output = {
      isTTY: true,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    return { input, output, stdout: () => chunks.join("") };
  }

  test("returns true when user selects Allow", async () => {
    setCliLocale("zh");
    const keys = ["\x1b[A", "\r"];
    const { input, output, stdout } = makeStreams();

    const result = await runConfirmDialog({
      request: baseRequest,
      input,
      output,
      readKey: async () => keys.shift() ?? null,
    });

    expect(result).toBe(true);
    const out = stdout();
    // Title/body now come from i18n (zh), and the Allow row is localized too.
    expect(out).toContain("确认执行破坏性 shell 命令");
    expect(out).toContain("允许");
  });

  test("renders the command the user is about to approve", async () => {
    setCliLocale("zh");
    const request: PermissionRequest = {
      ...baseRequest,
      command: "rm -rf ./tmp",
    };
    const { input, output, stdout } = makeStreams();

    await runConfirmDialog({
      request,
      input,
      output,
      readKey: async () => "\u001b",
    });

    // The exact command must appear so the user isn't signing blind.
    expect(stdout()).toContain("rm -rf ./tmp");
  });

  test("truncates long commands and marks the cut", async () => {
    setCliLocale("en");
    const longCommand = "rm -rf " + "a".repeat(200);
    const request: PermissionRequest = {
      ...baseRequest,
      command: longCommand,
    };
    // Force the conservative 80-column fallback by omitting `columns`.
    const { input, output, stdout } = makeStreams();

    await runConfirmDialog({
      request,
      input,
      output,
      readKey: async () => "\u001b",
    });

    const out = stdout();
    expect(out).toContain("(truncated)");
    // The full command must NOT fit — only the truncated prefix is shown.
    expect(out).not.toContain(longCommand);
  });

  test("measures CJK commands in terminal columns, not code units", async () => {
    // A path of Chinese directory names is ~half its real width by
    // String.length, so a length-based budget lets it through and the frame
    // wraps. Truncation must key off display columns instead.
    setCliLocale("en");
    // Deliberately sized so only a column-aware budget cuts it: 52 UTF-16
    // code units (under the 78-column budget) but 88 terminal columns (over).
    // A length-based check would wrongly pass it through untouched.
    const cjkCommand = "rm -rf " + "中文目录/".repeat(9);
    const { input, output, stdout } = makeStreams();

    await runConfirmDialog({
      request: { ...baseRequest, command: cjkCommand },
      input,
      output,
      readKey: async () => "",
    });

    const out = stdout();
    expect(out).toContain("(truncated)");
    expect(out).not.toContain(cjkCommand);

    // The kept prefix plus indent must fit the 80-column fallback.
    const shown = out
      .split("\n")
      .find((line) => line.includes("(truncated)"))!;
    const plain = shown.replace(/\x1b\[[0-9;]*m/g, "");
    let columns = 0;
    for (const char of plain) {
      columns += /[一-鿿＀-｠]/.test(char) ? 2 : 1;
    }
    expect(columns).toBeLessThanOrEqual(80);
  });

  test("returns false when user selects Cancel", async () => {
    setCliLocale("zh");
    const keys = ["\r"];
    const { input, output } = makeStreams();

    const result = await runConfirmDialog({
      request: baseRequest,
      input,
      output,
      readKey: async () => keys.shift() ?? null,
    });

    expect(result).toBe(false);
  });

  test("returns false when cancelled with escape", async () => {
    const { input, output } = makeStreams();

    const result = await runConfirmDialog({
      request: baseRequest,
      input,
      output,
      readKey: async () => "\u001b",
    });

    expect(result).toBe(false);
  });

  test("docks the prompt above the composer when anchored", async () => {
    // Regression: the confirm prompt was the only dialog that never forwarded
    // bottomAnchored, so a confirm opened mid-turn painted into the scroll
    // region and the next streaming repaint erased it. The user saw no prompt
    // while the dialog silently held the keyboard and the turn looked hung.
    const { input, output, stdout } = makeStreams();

    await runConfirmDialog({
      request: baseRequest,
      input,
      output,
      readKey: async () => "\u001b",
      bottomAnchored: true,
      bottomRow: 20,
    });

    // Anchored painting addresses absolute rows ending at bottomRow; the
    // unanchored path never emits a cursor-position sequence at all.
    expect(stdout()).toContain("\x1b[20;1H");
  });

  test("a non-shell request keeps its own title and body", async () => {
    // PermissionRequest is generic: any tool/action can raise one. Only the
    // known destructive-shell action gets the localized copy — everything else
    // must render verbatim, or unrelated approvals would be mislabelled
    // "confirm destructive shell command".
    setCliLocale("en");
    const { input, output, stdout } = makeStreams();

    await runConfirmDialog({
      request: {
        id: "permission-app-delete",
        tool: "deleteApp",
        action: "app_delete",
        title: "Delete the app",
        body: "This removes the app and its data.",
      },
      input,
      output,
      readKey: async () => "",
    });

    const out = stdout();
    expect(out).toContain("Delete the app");
    expect(out).toContain("This removes the app and its data.");
    expect(out).not.toContain("Confirm destructive shell command");
  });

  test("returns false in non-tty mode", async () => {
    const input = { isTTY: false } as unknown as NodeJS.ReadStream;
    const output = { isTTY: false } as unknown as NodeJS.WritableStream;

    const result = await runConfirmDialog({ request: baseRequest, input, output });

    expect(result).toBe(false);
  });

  test("en locale renders English copy", async () => {
    setCliLocale("en");
    const request: PermissionRequest = {
      ...baseRequest,
      command: "rm -rf ./tmp",
    };
    const { input, output, stdout } = makeStreams();

    await runConfirmDialog({
      request,
      input,
      output,
      readKey: async () => "\u001b",
    });

    const out = stdout();
    expect(out).toContain("Confirm destructive shell command");
    expect(out).toContain("Allow");
    expect(out).toContain("rm -rf ./tmp");
  });
});