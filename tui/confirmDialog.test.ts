import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "../agent-runtime/actionGate";
import { runConfirmDialog } from "./confirmDialog";

describe("runConfirmDialog", () => {
  const request: PermissionRequest = {
    id: "permission-shell-destructive-action",
    tool: "execShell",
    action: "destructive_shell_command",
    title: "确认执行破坏性 shell 命令",
    body: "该命令可能删除或重置用户内容，需要用户明确确认后才能执行。",
  };

  test("returns true when user selects Allow", async () => {
    const keys = ["\x1b[A", "\r"];
    const input = {
      isTTY: true,
      setRawMode: () => {},
      on: () => {},
      off: () => {},
      resume: () => {},
      pause: () => {},
    } as unknown as NodeJS.ReadStream;
    const chunks: string[] = [];
    const output = {
      isTTY: true,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const result = await runConfirmDialog({
      request,
      input,
      output,
      readKey: async () => keys.shift() ?? null,
    });

    expect(result).toBe(true);
    const stdout = chunks.join("");
    expect(stdout).toContain("确认执行破坏性 shell 命令");
    expect(stdout).toContain("Allow");
  });

  test("returns false when user selects Cancel", async () => {
    const keys = ["\r"];
    const input = {
      isTTY: true,
      setRawMode: () => {},
      on: () => {},
      off: () => {},
      resume: () => {},
      pause: () => {},
    } as unknown as NodeJS.ReadStream;
    const output = {
      isTTY: true,
      write: () => true,
    } as unknown as NodeJS.WritableStream;

    const result = await runConfirmDialog({
      request,
      input,
      output,
      readKey: async () => keys.shift() ?? null,
    });

    expect(result).toBe(false);
  });

  test("returns false when cancelled with escape", async () => {
    const input = {
      isTTY: true,
      setRawMode: () => {},
      on: () => {},
      off: () => {},
      resume: () => {},
      pause: () => {},
    } as unknown as NodeJS.ReadStream;
    const output = {
      isTTY: true,
      write: () => true,
    } as unknown as NodeJS.WritableStream;

    const result = await runConfirmDialog({
      request,
      input,
      output,
      readKey: async () => "\u001b",
    });

    expect(result).toBe(false);
  });

  test("returns false in non-tty mode", async () => {
    const input = { isTTY: false } as unknown as NodeJS.ReadStream;
    const output = { isTTY: false } as unknown as NodeJS.WritableStream;

    const result = await runConfirmDialog({ request, input, output });

    expect(result).toBe(false);
  });
});
