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
import {
  renderContextPanel,
  renderKnownAgents,
  renderTuiHelp,
  renderWelcome,
} from "./sessionRender";
import { getCliLocale, setCliLocale, t, type CliLocale } from "./i18n";
import { displayWidth, stripAnsi } from "./readlineWorkspace";
import { detectImagePaths } from "./pasteImage";
import {
  getActiveThemeName,
  getActiveDensity,
  setActiveThemeName,
  setActiveDensity,
  themeColorSequence,
  type TuiDensity,
} from "./theme";
import { getProcessRegistry } from "../agent-runtime/processRegistry";

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
      cursorPos: 0,
      submit: "abc",
    });
    expect(applyTuiInputKey("abc", "\u0003").abort).toBe(true);
  });

  test("opens copy view with Ctrl+O without changing the draft", () => {
    expect(applyTuiInputKey("draft", "\u000f")).toEqual({
      buffer: "draft",
      cursorPos: 5,
      copyView: true,
    });
  });

  test("handles paste payload token without submitting and normalizes CRLF/CR to LF", () => {
    const pasteToken = "\x00PASTE\x00line1\r\nline2\rline3";
    const res = applyTuiInputKey("prefix_", pasteToken);
    expect(res.buffer).toBe("prefix_line1\nline2\nline3");
    expect(res.submit).toBeUndefined();
  });

  test("submits full multiline buffer on subsequent real Enter press after paste", () => {
    const pasteToken = "\x00PASTE\x00line1\r\nline2\r\nline3";
    const pasteRes = applyTuiInputKey("", pasteToken);
    expect(pasteRes.buffer).toBe("line1\nline2\nline3");
    expect(pasteRes.submit).toBeUndefined();

    const enterRes = applyTuiInputKey(pasteRes.buffer, "\r", { name: "enter" });
    expect(enterRes).toEqual({
      buffer: "",
      cursorPos: 0,
      submit: "line1\nline2\nline3",
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
    // Ctrl+Backspace xterm encoding falls through to single-char backspace
    expect(applyTuiInputKey("foo bar", "\x1b[27;5;8~").buffer).toBe("foo ba");
  });

  test("Delete on empty buffer is a no-op", () => {
    expect(applyTuiInputKey("", "\x1b[3~").buffer).toBe("");
    expect(applyTuiInputKey("", "\x1b[3;5~").buffer).toBe("");
  });

  test("Ctrl+W deletes one word left (whitespace and CJK boundaries)", () => {
    // Cursor at end: "foo bar baz" -> "foo bar "
    expect(applyTuiInputKey("foo bar baz", "\x17", { ctrl: true, name: "w" })).toEqual({
      buffer: "foo bar ",
      cursorPos: 8,
    });
    // Cursor in middle of a word: deletes the whole word fragment left of cursor
    // "foo bar baz" cursor at 10 (before final 'z') -> "foo bar z"
    const midRes = applyTuiInputKey("foo bar baz", "\x17", { ctrl: true, name: "w" }, 10);
    expect(midRes.buffer).toBe("foo bar z");
    expect(midRes.cursorPos).toBe(8);
    // Leading whitespace is skipped together with the word
    expect(applyTuiInputKey("foo   bar", "\x17", { ctrl: true, name: "w" })).toEqual({
      buffer: "foo   ",
      cursorPos: 6,
    });
    // At position 0 no-op
    expect(applyTuiInputKey("abc", "\x17", { ctrl: true, name: "w" }, 0)).toEqual({
      buffer: "abc",
      cursorPos: 0,
    });
    // CJK: each char is its own word — "你好世界" cursor at end -> deletes "界"
    expect(applyTuiInputKey("你好世界", "\x17", { ctrl: true, name: "w" })).toEqual({
      buffer: "你好世",
      cursorPos: 3,
    });
    // Mixed ascii + CJK: "foo你好" cursor at end -> deletes "好"
    expect(applyTuiInputKey("foo你好", "\x17", { ctrl: true, name: "w" })).toEqual({
      buffer: "foo你",
      cursorPos: 4,
    });
    // Mixed CJK + ascii: "你好foo" cursor at end -> deletes "foo", stops at CJK boundary
    expect(applyTuiInputKey("你好foo", "\x17", { ctrl: true, name: "w" })).toEqual({
      buffer: "你好",
      cursorPos: 2,
    });
  });

  test("Ctrl+Backspace and Alt+Backspace both trigger word delete", () => {
    // Ctrl+Backspace — symbolic key form
    expect(applyTuiInputKey("foo bar", "", { ctrl: true, name: "backspace" })).toEqual({
      buffer: "foo ",
      cursorPos: 4,
    });
    // Alt+Backspace — symbolic + escape form
    expect(applyTuiInputKey("foo bar", "\x1b\x7f", { meta: true, name: "backspace" })).toEqual({
      buffer: "foo ",
      cursorPos: 4,
    });
  });

  test("Ctrl+U deletes from cursor to start of current line", () => {
    // Single line: "hello world" cursor at 5 -> " world"
    expect(applyTuiInputKey("hello world", "\x15", { ctrl: true, name: "u" }, 5)).toEqual({
      buffer: " world",
      cursorPos: 0,
    });
    // Multiline: only current line segment before cursor is removed
    // "line1\nline2\nline3" cursor at 15 (inside "line3", after "lin")
    const multi = applyTuiInputKey("line1\nline2\nline3", "\x15", { ctrl: true, name: "u" }, 15);
    expect(multi.buffer).toBe("line1\nline2\ne3");
    expect(multi.cursorPos).toBe(12);
    // At beginning of a line: no-op for that line
    expect(applyTuiInputKey("line1\nline2", "\x15", { ctrl: true, name: "u" }, 6)).toEqual({
      buffer: "line1\nline2",
      cursorPos: 6,
    });
    // At cursor 0 with buffer starting with \n: no-op (guard against
    // lastIndexOf(-1) finding the leading newline and corrupting the buffer)
    expect(applyTuiInputKey("\nhello", "\x15", { ctrl: true, name: "u" }, 0)).toEqual({
      buffer: "\nhello",
      cursorPos: 0,
    });
  });

  test("Ctrl+K deletes from cursor to end of current line", () => {
    // Single line: "hello world" cursor at 5 -> "hello"
    expect(applyTuiInputKey("hello world", "\x0b", { ctrl: true, name: "k" }, 5)).toEqual({
      buffer: "hello",
      cursorPos: 5,
    });
    // Multiline: only current line segment at/after cursor is removed,
    // newline boundary preserved
    const multi = applyTuiInputKey("line1\nline2\nline3", "\x0b", { ctrl: true, name: "k" }, 7);
    expect(multi.buffer).toBe("line1\nl\nline3");
    expect(multi.cursorPos).toBe(7);
    // At end of buffer: no-op
    expect(applyTuiInputKey("abc", "\x0b", { ctrl: true, name: "k" }, 3)).toEqual({
      buffer: "abc",
      cursorPos: 3,
    });
  });

  test("handles left/right arrow navigation, home/end, and in-middle edits", () => {
    // Navigating left moves cursor left
    const leftRes = applyTuiInputKey("abcd", "\x1b[D", { name: "left" }, 4);
    expect(leftRes.buffer).toBe("abcd");
    expect(leftRes.cursorPos).toBe(3);

    // Typing in the middle inserts character at cursorPos
    const insertRes = applyTuiInputKey("abcd", "X", {}, 2);
    expect(insertRes.buffer).toBe("abXcd");
    expect(insertRes.cursorPos).toBe(3);

    // Backspace in the middle deletes character left of cursorPos
    const bsRes = applyTuiInputKey("abXcd", "\x7f", { name: "backspace" }, 3);
    expect(bsRes.buffer).toBe("abcd");
    expect(bsRes.cursorPos).toBe(2);

    // Forward delete in the middle deletes character at cursorPos
    const delRes = applyTuiInputKey("abcd", "\x1b[3~", { name: "delete" }, 1);
    expect(delRes.buffer).toBe("acd");
    expect(delRes.cursorPos).toBe(1);

    // Home / Ctrl+A moves cursor to 0
    const homeRes = applyTuiInputKey("abcd", "\x1b[H", { name: "home" }, 3);
    expect(homeRes.cursorPos).toBe(0);

    // End / Ctrl+E moves cursor to buffer.length
    const endRes = applyTuiInputKey("abcd", "\x1b[F", { name: "end" }, 1);
    expect(endRes.cursorPos).toBe(4);
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
    expect(isLikelySlashCommand("/switch list")).toBe(true);
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
    const matches = completeSlashCommand("/s");
    expect(matches).toContain("/switch");
    expect(matches).toContain("/stop");
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
    expect(completeSlashCommand("/switch list")).toEqual([]);
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

describe("handleTuiInput - /switch, /agent, /tasks, /jobs aliases", () => {
  test("handles /switch and /agent without arguments to open agent picker", () => {
    const state = createInitialTuiState({});
    const switchRes = handleTuiInput("/switch", state);
    expect(switchRes.action).toEqual({ type: "pick-agent" });

    const agentRes = handleTuiInput("/agent", state);
    expect(agentRes.action).toEqual({ type: "pick-agent" });
  });

  test("handles /switch list and /agent list", () => {
    const state = createInitialTuiState({});
    const switchListRes = handleTuiInput("/switch list", state);
    expect(switchListRes.action).toEqual({ type: "list-agents" });

    const agentListRes = handleTuiInput("/agent list", state);
    expect(agentListRes.action).toEqual({ type: "list-agents" });
  });

  test("handles /tasks, /jobs, /procs interchangeably for process registry", () => {
    const state = createInitialTuiState({});
    expect(handleTuiInput("/tasks", state).output).toBe("No processes.");
    expect(handleTuiInput("/jobs", state).output).toBe("No processes.");
    expect(handleTuiInput("/procs", state).output).toBe("No processes.");
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

  test("prefixing input with ! returns shell-command action", () => {
    const state = createInitialTuiState({});
    const result = handleTuiInput("!git status", state);
    expect(result.action).toEqual({
      type: "shell-command",
      command: "git status",
    });
  });

  // /theme 与 /density 会改写 theme.ts 的模块级全局状态，该状态跨测试文件存活，
  // 会污染后跑的 tui/theme.test.ts。这里捕获原值并在 afterEach 还原——用 afterEach
  // 而非在用例末尾还原，是为了让用例中途失败时也能还原。
  const themeStateBeforeEach = { theme: "", density: "spacious" as TuiDensity };
  beforeEach(() => {
    themeStateBeforeEach.theme = getActiveThemeName();
    themeStateBeforeEach.density = getActiveDensity();
  });
  afterEach(() => {
    setActiveThemeName(themeStateBeforeEach.theme);
    setActiveDensity(themeStateBeforeEach.density);
  });

  test("handles /theme command to list or switch themes", () => {
    const state = createInitialTuiState({});
    const listResult = handleTuiInput("/theme", state);
    // Default theme is catppuccin with auto-detected brightness; the exact
    // brightness suffix depends on the test runner's terminal, so only pin
    // the theme name and the available list.
    expect(listResult.output).toContain("Current theme: catppuccin");
    expect(listResult.output).toContain("Available themes: trail, catppuccin, wave, iris, rose, mono");

    const switchResult = handleTuiInput("/theme wave", state);
    expect(switchResult.output).toContain("Switched to theme: wave");
    expect(getActiveThemeName()).toBe("wave");

    const invalidResult = handleTuiInput("/theme unknown-theme", state);
    expect(invalidResult.output).toContain("Unknown theme: unknown-theme");
  });

  test("handles /density command to view or switch density", () => {
    const state = createInitialTuiState({});
    const viewResult = handleTuiInput("/density", state);
    expect(viewResult.output).toContain("Current density: spacious");

    const switchResult = handleTuiInput("/density cozy", state);
    expect(switchResult.output).toContain("Switched to layout density: cozy");
    expect(getActiveDensity()).toBe("cozy");

    const invalidResult = handleTuiInput("/density unknown-density", state);
    expect(invalidResult.output).toContain("Unknown density: unknown-density");
  });
});

describe("handleTuiInput - /procs and /stop", () => {
  beforeEach(() => {
    getProcessRegistry().clear();
  });

  test("/procs shows empty list when no processes", () => {
    const state = createInitialTuiState({});
    const result = handleTuiInput("/procs", state);
    expect(result.output).toBe("No processes.");
    expect(result.action).toBeUndefined();
  });

  test("/procs lists running processes", () => {
    const registry = getProcessRegistry();
    registry.add({ pid: 1001, pgid: 1001, command: "sleep 30", label: "test:sleep" });
    registry.add({ pid: 1002, pgid: 1002, command: "echo hi", label: "test:echo" });
    const state = createInitialTuiState({});
    const result = handleTuiInput("/procs", state);
    expect(result.output).toContain("Running processes (2)");
    expect(result.output).toContain("pid 1001");
    expect(result.output).toContain("pid 1002");
    expect(result.output).toContain("test:sleep");
    expect(result.output).toContain("test:echo");
    expect(result.output).toContain("running");
    expect(result.action).toBeUndefined();
  });

  test("/procs shows stopped processes separately", () => {
    const registry = getProcessRegistry();
    registry.add({ pid: 1001, pgid: 1001, command: "sleep 30", label: "test:sleep" });
    registry.kill(1001);
    const state = createInitialTuiState({});
    const result = handleTuiInput("/procs", state);
    expect(result.output).toContain("Stopped/exited (1)");
    expect(result.output).toContain("stopped");
    expect(result.action).toBeUndefined();
  });

  test("/stop without argument shows usage", () => {
    const state = createInitialTuiState({});
    const result = handleTuiInput("/stop", state);
    expect(result.output).toContain("Usage: /stop <pid|label|all>");
    expect(result.action).toBeUndefined();
  });

  test("/stop all stops all running processes", () => {
    const registry = getProcessRegistry();
    registry.add({ pid: 1001, pgid: 1001, command: "sleep 30", label: "test:sleep" });
    registry.add({ pid: 1002, pgid: 1002, command: "echo hi", label: "test:echo" });
    const state = createInitialTuiState({});
    const result = handleTuiInput("/stop all", state);
    expect(result.output).toContain("Stopped 2 processes");
    expect(registry.list().every(p => p.status !== "running")).toBe(true);
    expect(result.action).toBeUndefined();
  });

  test("/stop <pid> stops a specific process", () => {
    const registry = getProcessRegistry();
    registry.add({ pid: 1001, pgid: 1001, command: "sleep 30", label: "test:sleep" });
    registry.add({ pid: 1002, pgid: 1002, command: "echo hi", label: "test:echo" });
    const state = createInitialTuiState({});
    const result = handleTuiInput("/stop 1001", state);
    expect(result.output).toContain("Stopped pid 1001");
    expect(result.output).toContain("test:sleep");
    expect(registry.get(1001)?.status).toBe("stopped");
    expect(registry.get(1002)?.status).toBe("running");
    expect(result.action).toBeUndefined();
  });

  test("/stop <pid> for non-running pid shows error", () => {
    const registry = getProcessRegistry();
    registry.add({ pid: 1001, pgid: 1001, command: "sleep 30", label: "test:sleep" });
    registry.kill(1001);
    const state = createInitialTuiState({});
    const result = handleTuiInput("/stop 1001", state);
    expect(result.output).toContain("No running process with pid 1001");
    expect(result.action).toBeUndefined();
  });

  test("/stop <label> stops processes by label", () => {
    const registry = getProcessRegistry();
    registry.add({ pid: 1001, pgid: 1001, command: "sleep 30", label: "test:sleep" });
    registry.add({ pid: 1002, pgid: 1002, command: "sleep 60", label: "test:sleep" });
    const state = createInitialTuiState({});
    const result = handleTuiInput("/stop test:sleep", state);
    expect(result.output).toContain("Stopped pid 1001");
    expect(result.output).toContain("pid 1002");
    expect(registry.get(1001)?.status).toBe("stopped");
    expect(registry.get(1002)?.status).toBe("stopped");
    expect(result.action).toBeUndefined();
  });

  test("/stop <label> for non-matching label shows error", () => {
    const registry = getProcessRegistry();
    registry.add({ pid: 1001, pgid: 1001, command: "sleep 30", label: "test:sleep" });
    const state = createInitialTuiState({});
    const result = handleTuiInput("/stop nonexistent", state);
    expect(result.output).toContain("No running process labeled 'nonexistent'");
    expect(result.action).toBeUndefined();
  });
  test("/stop <label> with spaces in label stops processes", () => {
    // argText = rest.join(" ").trim() preserves the full spaced label; the
    // registry matches by exact label equality, so "my dev server" must
    // resolve correctly and not be split into tokens.
    const registry = getProcessRegistry();
    registry.add({ pid: 2001, pgid: 2001, command: "bun run dev", label: "my dev server" });
    const state = createInitialTuiState({});
    const result = handleTuiInput("/stop my dev server", state);
    expect(result.output).toContain("Stopped pid 2001");
    expect(result.output).toContain("my dev server");
    expect(registry.get(2001)?.status).toBe("stopped");
    expect(result.action).toBeUndefined();
  });
});

describe("handleTuiInput - /skill", () => {
  test("/skill with no args shows empty state and usage", () => {
    const state = createInitialTuiState({});
    const result = handleTuiInput("/skill", state);
    expect(result.output).toContain("No skills attached");
    expect(result.output).toContain("/skill attach");
    expect(result.nextState.attachedSkills).toEqual([]);
  });

  test("/skill attach adds a skill ref", () => {
    const state = createInitialTuiState({});
    const result = handleTuiInput("/skill attach nolo-plan", state);
    expect(result.output).toBe("● Attached skill: nolo-plan");
    expect(result.nextState.attachedSkills).toEqual(["nolo-plan"]);
  });

  test("/skill attach is idempotent (no duplicates)", () => {
    const state = { ...createInitialTuiState({}), attachedSkills: ["nolo-plan"] };
    const result = handleTuiInput("/skill attach nolo-plan", state);
    expect(result.nextState.attachedSkills).toEqual(["nolo-plan"]);
  });

  test("/skill attach with dbKey", () => {
    const state = createInitialTuiState({});
    const result = handleTuiInput("/skill attach page-0e95801d90-01SKPLAN", state);
    expect(result.output).toBe("● Attached skill: page-0e95801d90-01SKPLAN");
    expect(result.nextState.attachedSkills).toEqual(["page-0e95801d90-01SKPLAN"]);
  });

  test("/skill attach without arg shows usage", () => {
    const state = createInitialTuiState({});
    const result = handleTuiInput("/skill attach", state);
    expect(result.output).toBe("Usage: /skill attach <skill-ref>");
  });

  test("/skill with attached skills lists them", () => {
    const state = { ...createInitialTuiState({}), attachedSkills: ["nolo-plan", "search-first"] };
    const result = handleTuiInput("/skill", state);
    expect(result.output).toContain("nolo-plan");
    expect(result.output).toContain("search-first");
    expect(result.output).toContain("/skill attach");
  });

  test("/skill detach removes a skill ref", () => {
    const state = { ...createInitialTuiState({}), attachedSkills: ["nolo-plan", "search-first"] };
    const result = handleTuiInput("/skill detach nolo-plan", state);
    expect(result.output).toBe("Detached skill: nolo-plan");
    expect(result.nextState.attachedSkills).toEqual(["search-first"]);
  });

  test("/skill detach non-attached skill shows notice", () => {
    const state = createInitialTuiState({});
    const result = handleTuiInput("/skill detach deployment", state);
    expect(result.output).toContain("Skill not attached");
  });

  test("/skill detach without arg shows usage", () => {
    const state = createInitialTuiState({});
    const result = handleTuiInput("/skill detach", state);
    expect(result.output).toBe("Usage: /skill detach <skill-ref>");
  });

  test("/skill clear removes all skills", () => {
    const state = { ...createInitialTuiState({}), attachedSkills: ["nolo-plan", "search-first"] };
    const result = handleTuiInput("/skill clear", state);
    expect(result.output).toBe("Cleared 2 skill(s).");
    expect(result.nextState.attachedSkills).toEqual([]);
  });

  test("/skill clear with no skills shows message", () => {
    const state = createInitialTuiState({});
    const result = handleTuiInput("/skill clear", state);
    expect(result.output).toBe("No skills attached.");
  });

  test("/new clears attached skills", () => {
    const state = { ...createInitialTuiState({}), attachedSkills: ["nolo-plan"] };
    const result = handleTuiInput("/new", state);
    expect(result.nextState.attachedSkills).toEqual([]);
  });

  test("/context shows attached skills", () => {
    const state = { ...createInitialTuiState({}), attachedSkills: ["nolo-plan"] };
    const result = handleTuiInput("/context", state);
    expect(result.output).toContain("nolo-plan");
  });

  test("/skill is recognized as slash command", () => {
    expect(isLikelySlashCommand("/skill")).toBe(true);
    expect(isLikelySlashCommand("/skill attach nolo-plan")).toBe(true);
  });

  test("completeSlashCommand includes /skill", () => {
    const completions = completeSlashCommand("/sk");
    expect(completions).toContain("/skill");
  });
});

describe("themed render surfaces", () => {
  // renderWelcome reads resolveCliColorEnabled() off process.env directly, so
  // both branches have to be driven through NOLO_CLI_COLOR rather than an
  // argument. Without pinning it the "no escapes" assertion would pass merely
  // because the test runner is not a TTY, and would keep passing if the
  // plain-text branch regressed.
  test("renderWelcome draws the vertical scene with wordmark, plain when color is off", () => {
    const previous = process.env.NOLO_CLI_COLOR;
    try {
      process.env.NOLO_CLI_COLOR = "0";
      const plain = renderWelcome(createInitialTuiState({}));
      expect(plain).toContain("▀▀▀▀");       // NOLO wordmark present
      expect(plain).not.toContain("\x1b");    // no ANSI in plain mode
      expect(plain).toContain("╱╲");          // mountain peak
      expect(plain).toContain("▁▁▁▁▁▁╱");    // ground meets mountain slope

      process.env.NOLO_CLI_COLOR = "1";
      const colored = renderWelcome(createInitialTuiState({}));
      expect(colored).toContain("▀▀▀▀");
      expect(colored).toContain("\x1b");
    } finally {
      if (previous === undefined) delete process.env.NOLO_CLI_COLOR;
      else process.env.NOLO_CLI_COLOR = previous;
    }
  });

  test("renderWelcome scenes sky body, tree, and sea beside the mountain", () => {
    // The scene adapts to brightness — dark gets ☾, light gets ☀.
    // Pin each element so a future banner edit is deliberate.
    const previous = process.env.NOLO_CLI_COLOR;
    const prevTheme = process.env.NOLO_TUI_THEME;
    try {
      process.env.NOLO_CLI_COLOR = "0";

      // Dark mode: moon + stars
      process.env.NOLO_TUI_THEME = "dark";
      const dark = renderWelcome(createInitialTuiState({}));
      expect(dark).toContain("🌙");       // big moon in dark sky
      expect(dark).toContain("♠");       // pine tree
      expect(dark).toContain("✦");       // twinkling stars in dark mode
      expect(dark).toContain("_.~^~._.~^~._.~^~._.~^~._");   // steeper waves

      // Check colored scene coverage
      process.env.NOLO_CLI_COLOR = "1";
      const darkColored = renderWelcome(createInitialTuiState({}));
      expect(darkColored).toContain("🌙");
      expect(darkColored).toContain("♠");
      expect(darkColored).toContain("✦");
      expect(darkColored).toContain("_.~^~._.~^~._.~^~._.");

      // Light mode: sun, no moon
      process.env.NOLO_CLI_COLOR = "0";
      process.env.NOLO_TUI_THEME = "light";
      const light = renderWelcome(createInitialTuiState({}));
      expect(light).toContain("☀");      // sun in light sky
      expect(light).not.toContain("🌙"); // no moon
      expect(light).toContain("♠");      // pine tree
      expect(light).toContain("_.~^~._.~^~._.~^~._.~^~._");  // steeper waves
    } finally {
      if (previous === undefined) delete process.env.NOLO_CLI_COLOR;
      else process.env.NOLO_CLI_COLOR = previous;
      if (prevTheme === undefined) delete process.env.NOLO_TUI_THEME;
      else process.env.NOLO_TUI_THEME = prevTheme;
    }
  });

  test("renderWelcome drops the wide scene on narrow terminals", () => {
    // The scene art is ~48 columns wide. When the caller passes a terminal
    // width that can't hold it, the scene must be dropped so its rows don't
    // wrap — wrapping is exactly what corrupted the old animated banner on
    // narrow terminals (sky rows stacked into vertical columns). The version
    // and hint lines always remain so the welcome still reads cleanly.
    const previous = process.env.NOLO_CLI_COLOR;
    try {
      process.env.NOLO_CLI_COLOR = "0";
      const state = createInitialTuiState({});

      const narrow = renderWelcome(state, 0, 0, 20);
      expect(narrow).not.toContain("♠"); // tree gone with the scene
      expect(narrow).not.toContain("╱"); // mountain slope gone too
      expect(narrow).toContain("nolo"); // version line kept
      expect(narrow).toContain("/help"); // hint line kept

      const wide = renderWelcome(state, 0, 0, 200);
      expect(wide).toContain("♠"); // full scene on a wide terminal

      // Omitting columns (pure-function callers / other tests) keeps the scene.
      expect(renderWelcome(state)).toContain("♠");
    } finally {
      if (previous === undefined) delete process.env.NOLO_CLI_COLOR;
      else process.env.NOLO_CLI_COLOR = previous;
    }
  });

  test("renderContextPanel drops the ASCII rule but keeps a plain-mode divider", () => {
    const plain = renderContextPanel(createInitialTuiState({}), false);
    expect(plain).not.toContain("-----");
    // Piped / NO_COLOR output has no bold title to separate the heading from
    // the fields, so it must still get a rule — just not an ASCII one.
    expect(plain.split("\n")[1]).toBe("─".repeat(displayWidth(t("contextTitle"))));
    // Color mode leans on the accent+bold title instead of a rule.
    expect(renderContextPanel(createInitialTuiState({}), true)).not.toContain(
      "─".repeat(17),
    );
  });

  test("renderContextPanel aligns every field value in one column", () => {
    const output = renderContextPanel(createInitialTuiState({}), true);
    // The field rows are the ones between the title and the blank line before
    // "Next:". Each label pads to display width 9, so every value must start
    // at the same column once the color codes are stripped.
    const rows = output
      .split("\n")
      .slice(1)
      .filter((row) => row !== "")
      .slice(0, 10)
      .map(stripAnsi);
    expect(rows).toHaveLength(10);
    const labelWidths = rows.map((row) => {
      const label = row.match(/^\S+\s+/)?.[0] ?? "";
      return displayWidth(label);
    });
    expect(new Set(labelWidths)).toEqual(new Set([9]));
  });

  test("renderKnownAgents themes the title instead of emitting plain text", () => {
    const plain = renderKnownAgents(false);
    expect(plain).not.toContain("\x1b");
    expect(plain).toContain(t("agentsTitle"));
    expect(renderKnownAgents(true)).toContain("\x1b");
  });
});

describe("Task D - i18n & help theme tests", () => {
  let savedLocale: CliLocale;

  beforeEach(() => {
    savedLocale = getCliLocale();
  });

  afterEach(() => {
    setCliLocale(savedLocale);
  });

  test("1. setCliLocale('en') renderContextPanel output has no CJK characters", () => {
    setCliLocale("en");
    const output = renderContextPanel(createInitialTuiState({}), true);
    expect(output).not.toMatch(/[\u4e00-\u9fa5]/);
  });

  test("2. setCliLocale('zh') renderContextPanel contains 工作区上下文 and not Workspace context", () => {
    setCliLocale("zh");
    const output = renderContextPanel(createInitialTuiState({}), true);
    expect(output).toContain("工作区上下文");
    expect(output).not.toContain("Workspace context");
  });

  test("3. aligned field value column offset across locales", () => {
    for (const locale of ["en", "zh"] as const) {
      setCliLocale(locale);
      const output = renderContextPanel(createInitialTuiState({}), true);
      const rows = output
        .split("\n")
        .slice(1)
        .filter((row) => row !== "")
        .slice(0, 10)
        .map(stripAnsi);
      expect(rows).toHaveLength(10);
      const labelWidths = rows.map((row) => {
        const label = row.match(/^\S+\s+/)?.[0] ?? "";
        return displayWidth(label);
      });
      expect(new Set(labelWidths)).toEqual(new Set([9]));
    }
  });

  test("4. renderTuiHelp(false) strictly matches t('helpText')", () => {
    for (const locale of ["en", "zh"] as const) {
      setCliLocale(locale);
      expect(renderTuiHelp(false)).toBe(t("helpText"));
    }
  });

  test("5. renderTuiHelp(true) themes command with accent and description with muted", () => {
    setCliLocale("en");
    const output = renderTuiHelp(true);
    const lines = output.split("\n");
    const helpLine = lines.find((l) => l.includes("/help"));
    expect(helpLine).toBeDefined();
    expect(helpLine).toContain(themeColorSequence("accent"));
    expect(helpLine).toContain(themeColorSequence("muted"));
  });
});
