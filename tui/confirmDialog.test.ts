import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { PermissionRequest } from "../agent-runtime/actionGate";
import { getCliLocale, setCliLocale } from "./i18n";
import { runConfirmDialog } from "./confirmDialog";
import { createRawKeyReader } from "./selectDialog";

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

  test("external_file_access action uses localized title and body in both locales", async () => {
    const extRequest: PermissionRequest = {
      id: "permission-ext-file",
      tool: "readFile",
      action: "external_file_access",
      title: "确认读取工作区外部文件",
      body: "该路径位于当前工作区之外。确认后本次访问放行，否则拒绝。",
    };

    {
      setCliLocale("zh");
      const { input, output, stdout } = makeStreams();
      await runConfirmDialog({
        request: extRequest,
        input,
        output,
        readKey: async () => "\u001b",
      });
      const out = stdout();
      expect(out).toContain("确认读取工作区外部文件");
      expect(out).toContain("该路径位于当前工作区之外。确认后本次访问放行，否则拒绝。");
    }

    {
      setCliLocale("en");
      const { input, output, stdout } = makeStreams();
      await runConfirmDialog({
        request: extRequest,
        input,
        output,
        readKey: async () => "\u001b",
      });
      const out = stdout();
      expect(out).toContain("Confirm reading a file outside the workspace");
      expect(out).toContain("This path is outside the current workspace. Allow this one-time access, or deny it.");
    }
  });

  test("a wheel report is swallowed: no move, no repaint, no cancel", async () => {
    // confirm is a NON-list modal (spec): the wheel must be silently swallowed
    // — it must NOT move the Allow/Deny highlight, NOT repaint, NOT cancel.
    // The previous version of this test asserted wheel-down "moved the
    // highlight and clamped at Deny", which is the opposite of the spec, and
    // its assertion (`result === false`) passed under both the swallow and
    // the move implementations because the initial index is already Deny — so
    // it proved nothing. This rewrite fixes the semantics and makes the test
    // fail if the wheel does anything at all.
    setCliLocale("en");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const writes: string[] = [];
    const output = {
      isTTY: true,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const resultPromise = runConfirmDialog({
      request: baseRequest,
      input,
      output,
      readKey,
    });
    await new Promise((r) => setTimeout(r, 10));

    // Snapshot the rendered frame right before the wheel. The initial index
    // is 1 (Cancel), so Allow is the OTHER row.
    const frameBeforeWheel = writes.join("");
    expect(frameBeforeWheel).toContain("Allow");
    expect(frameBeforeWheel).toContain("Cancel");
    const initialAllowFocused = frameBeforeWheel.match(/❯ .*Allow/)?.[0] != null;
    const initialCancelFocused = frameBeforeWheel.match(/❯ .*Cancel/)?.[0] != null;
    // Sanity: exactly one of Allow/Cancel is focused, and it's Cancel (initialIndex 1).
    expect(initialAllowFocused).toBe(false);
    expect(initialCancelFocused).toBe(true);

    // Wheel-up. If the wheel were treated as "move", it would move the
    // highlight from Cancel (index 1) to Allow (index 0) — which is exactly
    // the wrong behavior the spec forbids (a stray wheel would silently
    // approve a destructive command). Under the correct "ignore" policy the
    // highlight stays on Cancel and nothing is repainted.
    writes.length = 0;
    input.emit("data", "\x1b[<64;3;3M");
    await new Promise((r) => setTimeout(r, 10));
    // No repaint for a swallowed wheel event.
    expect(writes.length).toBe(0);

    // Wheel-down too: still no move, no repaint.
    input.emit("data", "\x1b[<65;3;3M");
    await new Promise((r) => setTimeout(r, 10));
    expect(writes.length).toBe(0);

    // Submit — the dialog is still open (wheel did not cancel) and the
    // highlight never left Cancel, so Enter picks Cancel → false.
    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toBe(false);
  });

  test("a wheel-up from the initial Cancel does NOT move to Allow", async () => {
    // The single most important regression for confirm: wheel-up on a dialog
    // that starts on Cancel must NOT flip to Allow. Under the old "move"
    // policy this would have moved index 1 → 0 and silently approved a
    // destructive command. This test fails against any "move" implementation.
    setCliLocale("en");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const writes: string[] = [];
    const output = {
      isTTY: true,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const resultPromise = runConfirmDialog({
      request: baseRequest,
      input,
      output,
      readKey,
    });
    await new Promise((r) => setTimeout(r, 10));

    // Wheel-up: highlight must stay on Cancel.
    input.emit("data", "\x1b[<64;3;3M");
    await new Promise((r) => setTimeout(r, 10));
    // No repaint ⇒ no move happened. If a move had occurred the frame would
    // have been repainted with Allow focused.
    expect(writes.join("").match(/❯ .*Allow/)).toBeNull();

    // Submit Cancel to prove the dialog is still open and unchanged.
    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toBe(false);
  });

  test("a bare Escape still cancels a confirm dialog", async () => {
    setCliLocale("en");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const output = { isTTY: true, write: () => true } as unknown as NodeJS.WritableStream;
    const resultPromise = runConfirmDialog({
      request: baseRequest,
      input,
      output,
      readKey,
    });
    input.emit("data", "\x1b");
    const result = await resultPromise;
    expect(result).toBe(false); // cancel → deny
  });

  test("a non-wheel SGR mouse click does not cancel a confirm dialog", async () => {
    setCliLocale("en");
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as { isTTY?: boolean }).isTTY = true;
    const readKey = createRawKeyReader(input);
    const output = { isTTY: true, write: () => true } as unknown as NodeJS.WritableStream;
    const resultPromise = runConfirmDialog({
      request: baseRequest,
      input,
      output,
      readKey,
    });
    // A plain left-click report, emitted whole, must be swallowed, not turned
    // into a cancel. After the click, move up to Allow and submit — if the
    // click had cancelled the dialog this Enter would never arrive.
    input.emit("data", "\x1b[<0;1;1M");
    await new Promise((r) => setTimeout(r, 10));
    input.emit("data", "\x1b[A"); // up to Allow
    await new Promise((r) => setTimeout(r, 10));
    input.emit("data", "\r");
    const result = await resultPromise;
    expect(result).toBe(true); // Allow — proves the click did not cancel
  });
});