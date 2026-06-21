import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { startTuiWorkspace } from "./readlineWorkspace";

// 1x1 transparent PNG
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

function toPlainUint8Array(chunk: string | Uint8Array) {
  return typeof chunk === "string"
    ? Uint8Array.from(Buffer.from(chunk))
    : Uint8Array.from(chunk);
}

describe("tui image attachment integration", () => {
  let dir: string;
  let pngPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nolo-tui-image-"));
    pngPath = join(dir, "shot.png");
    writeFileSync(pngPath, new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64")));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });



  test("inline image path in chat message is detected and emitted to agent", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => chunks.push(toPlainUint8Array(chunk)));

    const calls: Array<{ message: string; imageUrls?: string[] }> = [];

    input.write(`look at ${pngPath}\n`);
    input.write("/exit\n");
    input.end();

    await Promise.race([
      startTuiWorkspace({
        scriptDir: "",
        input,
        output,
        env: {},
        agentRunner: async (options) => {
          calls.push({
            message: options.message,
            imageUrls: options.imageUrls,
          });
          output.write("\nok\n");
          return { exitCode: 0, dialogId: "01TESTDIALOG1234567890ABCD" };
        },
      }),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 3000)
      ),
    ]);

    const stdout = Buffer.concat(chunks).toString("utf8");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.message).toBe("look at");
    expect(call.imageUrls).toBeDefined();
    expect(call.imageUrls).toHaveLength(1);
    expect(call.imageUrls?.[0]).toMatch(/^data:image\/png;base64,/);
    expect(stdout).toContain("found image");
  });

  test("iTerm2-style backslash-escaped path with space is detected", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Uint8Array[] = [];
    output.on("data", (chunk) => chunks.push(toPlainUint8Array(chunk)));

    const calls: Array<{ message: string; imageUrls?: string[] }> = [];

    // 创建含空格的文件名,模拟 iTerm2 paste 行为:`\ ` escape
    const spaced = join(dir, "截图 with space.png");
    writeFileSync(spaced, new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64")));

    input.write(`看图 ${dir}/截图\\ with\\ space.png 怎么说\n`);
    input.write("/exit\n");
    input.end();

    await Promise.race([
      startTuiWorkspace({
        scriptDir: "",
        input,
        output,
        env: {},
        agentRunner: async (options) => {
          calls.push({
            message: options.message,
            imageUrls: options.imageUrls,
          });
          output.write("\nok\n");
          return { exitCode: 0, dialogId: "01TESTDIALOG1234567890ABCD" };
        },
      }),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 3000)
      ),
    ]);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.message).toBe("看图 怎么说");
    expect(call.imageUrls).toBeDefined();
    expect(call.imageUrls).toHaveLength(1);
    expect(call.imageUrls?.[0]).toMatch(/^data:image\/png;base64,/);
  });
});