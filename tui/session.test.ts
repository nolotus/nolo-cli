import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyTuiInputKey,
  completeSlashCommand,
  createInitialTuiState,
  handleTuiInput,
  isLikelySlashCommand,
  stripImageTokens,
} from "./session";
import { detectImagePaths } from "./pasteImage";

// 1x1 transparent PNG
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "nolo-session-test-"));
}

describe("handleTuiInput - image attachments", () => {
  let cwd: string;
  let pngPath: string;

  beforeEach(() => {
    cwd = makeTempDir();
    pngPath = join(cwd, "shot.png");
    writeFileSync(pngPath, new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64")));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("creates initial state with empty attachedImages", () => {
    const state = createInitialTuiState({});
    expect(state.attachedImages).toEqual([]);
  });



  test("/new clears attachedImages", () => {
    const state = {
      ...createInitialTuiState({}),
      attachedImages: [
        {
          dataUrl: "data:image/png;base64,a",
          mime: "image/png",
          filename: "a.png",
          sizeBytes: 100,
          sourcePath: "/tmp/a.png",
        },
      ],
    };
    const result = handleTuiInput("/new", state);
    expect(result.nextState.attachedImages).toEqual([]);
  });

  test("/new resets dialog and attached state and emits a clear action", () => {
    const state = {
      ...createInitialTuiState({}),
      dialogId: "01TESTDIALOG00000000000000AB",
      attachedImages: [
        {
          dataUrl: "data:image/png;base64,a",
          mime: "image/png",
          filename: "a.png",
          sizeBytes: 100,
          sourcePath: "/tmp/a.png",
        },
      ],
      attachedDocs: ["note"],
    };
    const result = handleTuiInput("/new", state);
    expect(result.nextState.dialogId).toBeUndefined();
    expect(result.nextState.attachedImages).toEqual([]);
    expect(result.nextState.attachedDocs).toEqual([]);
    expect(result.action?.type).toBe("clear");
  });
});

describe("applyTuiInputKey", () => {
  test("handles multiline, submit, backspace, and abort keys", () => {
    expect(applyTuiInputKey("a", "\x1b[13;2~").buffer).toBe("a\n");
    expect(applyTuiInputKey("a", "\x1b[27;2;13~").buffer).toBe("a\n");
    expect(applyTuiInputKey("a", "\n").buffer).toBe("a\n");
    expect(applyTuiInputKey("ab", "\x7f").buffer).toBe("a");
    expect(applyTuiInputKey("abc", "\r", { name: "enter" })).toEqual({
      buffer: "",
      submit: "abc",
    });
    expect(applyTuiInputKey("abc", "\u0003").abort).toBe(true);
  });

  test("opens copy view with Ctrl+O without changing the draft", () => {
    expect(applyTuiInputKey("draft", "\u000f")).toEqual({
      buffer: "draft",
      copyView: true,
    });
  });

  test("handles forward Delete key and modifier Delete/Backspace variants", () => {
    // Forward Delete (basic)
    expect(applyTuiInputKey("abc", "\x1b[3~").buffer).toBe("ab");
    // Ctrl+Delete
    expect(applyTuiInputKey("abc", "\x1b[3;5~").buffer).toBe("ab");
    // Alt+Delete
    expect(applyTuiInputKey("abc", "\x1b[3;3~").buffer).toBe("ab");
    // Shift+Delete
    expect(applyTuiInputKey("abc", "\x1b[3;2~").buffer).toBe("ab");
    // Shift+Backspace (xterm modifier encoding)
    expect(applyTuiInputKey("abc", "\x1b[27;2;8~").buffer).toBe("ab");
    // Ctrl+Backspace (xterm modifier encoding)
    expect(applyTuiInputKey("abc", "\x1b[27;5;8~").buffer).toBe("ab");
  });

  test("Delete on empty buffer is a no-op", () => {
    expect(applyTuiInputKey("", "\x1b[3~").buffer).toBe("");
    expect(applyTuiInputKey("", "\x1b[3;5~").buffer).toBe("");
  });
});

describe("handleTuiInput - copy view", () => {
  test("keeps /copy as direct copy and routes /copy view separately", () => {
    const state = createInitialTuiState({});
    expect(handleTuiInput("/copy", state).action).toEqual({ type: "copy-last" });
    expect(handleTuiInput("/copy view", state).action).toEqual({ type: "copy-view" });
  });

  test("rejects unsupported /copy arguments", () => {
    const result = handleTuiInput("/copy something", createInitialTuiState({}));
    expect(result.action).toBeUndefined();
    expect(result.output).toContain("/copy view");
  });
});

describe("handleTuiInput - inline image detection in chat path", () => {
  let cwd: string;
  let pngPath: string;

  beforeEach(() => {
    cwd = makeTempDir();
    pngPath = join(cwd, "shot.png");
    writeFileSync(pngPath, new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64")));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("plain text chat action does not include imagePaths", () => {
    const state = { ...createInitialTuiState({}), cwd };
    const result = handleTuiInput("hello world", state);
    expect(result.action?.type).toBe("chat");
    if (result.action?.type === "chat") {
      expect(result.action.imagePaths).toBeUndefined();
      expect(result.action.message).toBe("hello world");
    }
  });

  test("chat with inline image path strips token and emits imagePaths", () => {
    const state = { ...createInitialTuiState({}), cwd };
    const result = handleTuiInput(`look at this ${pngPath} please`, state);
    expect(result.action?.type).toBe("chat");
    if (result.action?.type === "chat") {
      expect(result.action.message).toBe("look at this please");
      expect(result.action.imagePaths).toEqual([pngPath]);
    }
    expect(result.output).toContain("found image");
  });

  test("line that is only a path is preserved in message and emits imagePaths", () => {
    const state = { ...createInitialTuiState({}), cwd };
    const result = handleTuiInput(pngPath, state);
    if (result.action?.type === "chat") {
      expect(result.action.imagePaths).toEqual([pngPath]);
      // message 不应被 strip 成空(否则 workspace 会发空 message)
      expect(result.action.message.length).toBeGreaterThan(0);
    }
  });

  test("missing image path does not trip detection", () => {
    const state = { ...createInitialTuiState({}), cwd };
    const ghost = join(cwd, "ghost.png");
    const result = handleTuiInput(`look at this ${ghost}`, state);
    if (result.action?.type === "chat") {
      expect(result.action.imagePaths).toBeUndefined();
      expect(result.action.message).toBe(`look at this ${ghost}`);
    }
  });

  test("non-image extension path is treated as text", () => {
    const state = { ...createInitialTuiState({}), cwd };
    const txt = join(cwd, "notes.txt");
    writeFileSync(txt, "hello");
    const result = handleTuiInput(`open ${txt}`, state);
    if (result.action?.type === "chat") {
      expect(result.action.imagePaths).toBeUndefined();
      expect(result.action.message).toBe(`open ${txt}`);
    }
  });
});

describe("detectImagePaths and stripImageTokens", () => {
  let cwd: string;
  let pngPath: string;

  beforeEach(() => {
    cwd = makeTempDir();
    pngPath = join(cwd, "x.png");
    writeFileSync(pngPath, new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64")));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("detectImagePaths returns absolute path", () => {
    const hints = detectImagePaths(`/see ${pngPath}`, cwd);
    expect(hints).toEqual([{ raw: pngPath, resolvedPath: pngPath }]);
  });

  test("detectImagePaths expands ~", () => {
    if (!process.env.HOME) return;
    const home = process.env.HOME;
    const filename = `.tmp-fake-image-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const target = join(home, filename);
    writeFileSync(target, "");
    try {
      const hints = detectImagePaths(`see ~/${filename}`, cwd);
      expect(hints.find((h) => h.resolvedPath === target)).toBeTruthy();
    } finally {
      rmSync(target, { force: true });
    }
  });

  test("stripImageTokens collapses whitespace", () => {
    const stripped = stripImageTokens(`look ${pngPath}   please`, [
      { raw: pngPath },
    ]);
    expect(stripped).toBe("look please");
  });

  test("stripImageTokens preserves iTerm2 escape so it can match original input", () => {
    // 真实 paste 路径:iTerm2 把空格转义成 `\ `
    const escapedRaw = `${cwd}/with\\ space.png`;
    const input = `看图 ${escapedRaw} 怎么样`;
    const stripped = stripImageTokens(input, [{ raw: escapedRaw }]);
    expect(stripped).toBe("看图 怎么样");
  });

  test("stripImageTokens returns input untouched when no hints", () => {
    expect(stripImageTokens("hello world", [])).toBe("hello world");
  });
});

describe("isLikelySlashCommand", () => {
  test("recognizes known slash commands", () => {
    expect(isLikelySlashCommand("/help")).toBe(true);
    expect(isLikelySlashCommand("/new")).toBe(true);
    expect(isLikelySlashCommand("/agent list")).toBe(true);
    expect(isLikelySlashCommand("/runtime local")).toBe(true);
    expect(isLikelySlashCommand("/customize")).toBe(true);
  });

  test("treats absolute paths starting with / as chat (not slash command)", () => {
    expect(isLikelySlashCommand("/Users/nolotus/Desktop/foo.png")).toBe(false);
    expect(isLikelySlashCommand("/tmp/x.png 看图")).toBe(false);
    expect(isLikelySlashCommand("/etc/hosts")).toBe(false);
    expect(isLikelySlashCommand("/var/folders/abc/test.png")).toBe(false);
  });

  test("treats /-prefixed tokens with slash inside as paths", () => {
    expect(isLikelySlashCommand("/foo/bar")).toBe(false);
    expect(isLikelySlashCommand("/a/b/c 看图")).toBe(false);
  });

  test("rejects /<digit> and other malformed slash starts", () => {
    expect(isLikelySlashCommand("/123abc")).toBe(false);
    expect(isLikelySlashCommand("/  hello")).toBe(false);
  });

  test("non-slash input is never a slash command", () => {
    expect(isLikelySlashCommand("hello")).toBe(false);
    expect(isLikelySlashCommand("看图")).toBe(false);
    expect(isLikelySlashCommand("")).toBe(false);
  });
});

describe("completeSlashCommand", () => {
  test("returns matching commands for partial slash input", () => {
    const matches = completeSlashCommand("/he");
    expect(matches).toContain("/help");
  });

  test("returns all commands starting with the prefix", () => {
    const matches = completeSlashCommand("/a");
    expect(matches).toContain("/agent");
    expect(matches).toContain("/agents");
  });

  test("excludes exact match from completions", () => {
    expect(completeSlashCommand("/help")).toEqual([]);
    expect(completeSlashCommand("/new")).toEqual([]);
  });

  test("returns empty for non-slash input", () => {
    expect(completeSlashCommand("hello")).toEqual([]);
    expect(completeSlashCommand("")).toEqual([]);
  });

  test("returns empty when buffer has spaces", () => {
    expect(completeSlashCommand("/agent list")).toEqual([]);
    expect(completeSlashCommand("/runtime local")).toEqual([]);
  });

  test("matches /c for context, compact, customize, ctx", () => {
    const matches = completeSlashCommand("/c");
    expect(matches).toContain("/context");
    expect(matches).toContain("/ctx");
    expect(matches).toContain("/compact");
    expect(matches).toContain("/customize");
  });
});

describe("handleTuiInput - path-vs-slash disambiguation", () => {
  let cwd: string;
  let pngPath: string;

  beforeEach(() => {
    cwd = makeTempDir();
    pngPath = join(cwd, "shot.png");
    writeFileSync(pngPath, new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64")));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("/Users-style absolute path with chat text routes to chat (not unknown command)", () => {
    const state = { ...createInitialTuiState({}), cwd };
    // 用户真实场景:macOS 绝对路径以 / 开头,必须有内容提示 chat 检测到图片
    const result = handleTuiInput(`/Users/you/Desktop/foo.png 看图`, state);
    if (result.action?.type === "chat") {
      expect(result.action.message).toContain("看图");
    } else {
      // 如果图片路径不存在(本测试环境),fallback 到 chat 也不该是 slash 路径
      expect(result.action?.type).not.toBeUndefined();
    }
  });

  test("real iTerm2-pasted path with iTerm2 escape routes to chat with imageUrls", () => {
    // 创建带空格的中文文件名 fixture,模拟用户的真实场景
    const spacedPath = join(cwd, "截屏2026-06-03 下午12.34.09.png");
    writeFileSync(spacedPath, new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64")));

    const state = { ...createInitialTuiState({}), cwd };
    const escapedInput = `${spacedPath.slice(0, spacedPath.lastIndexOf("/") + 1)}截屏2026-06-03\\ 下午12.34.09.png 这个图是啥`;

    const result = handleTuiInput(escapedInput, state);
    expect(result.action?.type).toBe("chat");
    if (result.action?.type === "chat") {
      expect(result.action.imagePaths).toEqual([spacedPath]);
      expect(result.action.message).toBe("这个图是啥");
    }
    expect(result.output).toContain("found image");
  });
});
