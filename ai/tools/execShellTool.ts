import { DEFAULT_LOCAL_API_ORIGIN } from "../../core/localOrigins";
import { callToolApi } from "./toolApiClient";
import { ToolResultError } from "./toolResultError";

type ExecShellKind = "auto" | "bash" | "powershell";

type ExecShellRequestArgs = {
  command?: string;
  cwd?: string;
  interactive?: boolean;
  pty?: boolean;
  shell?: ExecShellKind;
  sessionId?: string;
  input?: string;
  close?: boolean;
};

export const execShellFunctionSchema = {
  name: "execShell",
  description:
    "跨平台 shell 执行工具。会在 Windows 上优先使用 PowerShell，在 Linux/macOS 上使用 bash。环境不明确时，先调用 checkEnv({check:'context'}) 判断当前平台与可用 shell。支持交互式 session：先用 interactive=true 启动，再通过 sessionId + input 继续写入 stdin，或用 sessionId 单独轮询输出。仅用于本地开发环境。对 rm 等危险命令默认拦截，需显式传 unsafe: true 才会执行。不要用它执行 rg/grep 代码搜索；代码搜索请改用 codeSearch。",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "要执行的 shell 命令，例如: 'git status --short', 'Get-Location', 'bun test --watch=false'。",
      },
      cwd: {
        type: "string",
        description:
          "可选：命令执行的工作目录（相对于 diff-server 所在机器），默认使用后端的 process.cwd()。",
      },
      shell: {
        type: "string",
        enum: ["auto", "bash", "powershell"],
        description:
          "可选：显式指定 shell。默认 auto：Windows 优先 PowerShell，其他系统使用 bash。",
      },
      unsafe: {
        type: "boolean",
        description:
          "可选：是否允许执行被判定为危险的命令（例如 rm -rf）。默认 false；当为 false 且命令被识别为危险时，会直接拦截而不真正执行。",
      },
      interactive: {
        type: "boolean",
        description:
          "可选：是否以交互式 session 启动命令。为 true 时接口会立即返回 sessionId，后续可继续写 stdin 或轮询输出。",
      },
      pty: {
        type: "boolean",
        description:
          "可选：是否为交互式 session 分配伪终端（PTY）。当前仅 bash 路径支持；Windows PowerShell 会自动降级为非 PTY 交互。",
      },
      sessionId: {
        type: "string",
        description:
          "可选：已存在的交互式 sessionId。传入后可继续写入 input、查询最新输出或关闭该 session。",
      },
      input: {
        type: "string",
        description:
          "可选：要写入 session stdin 的文本。通常需要自己补换行，例如 'y\\n' 或 'exit\\n'。",
      },
      close: {
        type: "boolean",
        description:
          "可选：是否关闭指定 session。通常与 sessionId 搭配使用。",
      },
    },
  },
};

function isDangerousCommand(rawCommand: string): boolean {
  const command = rawCommand.trim();
  const normalized = command.replace(/\s+/g, " ");

  if (
    /^rm\b/i.test(normalized) ||
    /\bsudo\s+rm\b/i.test(normalized) ||
    /\brm\s+-[rf]+\b/i.test(normalized) ||
    /\brm\s+-[^\s]*r[^\s]*f[^\s]*/i.test(normalized)
  ) {
    return true;
  }

  if (/\brm\s+-[^\s]*f[^\s]*/i.test(normalized)) {
    return true;
  }

  return false;
}

async function requestExec(
  args: ExecShellRequestArgs,
  thunkApi?: any,
  endpoint = "/api/exec-shell",
  context?: { parentMessageId?: string; signal?: AbortSignal; toolRunId?: string; agentKey?: string; userInput?: string },
): Promise<any> {
  const payload = Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined)
  );

  if (thunkApi?.getState) {
    return callToolApi(thunkApi, endpoint, payload, {
      withAuth: true,
      agentKey: context?.agentKey,
    });
  }

  const baseUrl =
    (typeof process !== "undefined" &&
      (process as any).env?.DIFF_SERVER_ORIGIN) ||
    (typeof window !== "undefined" ? window.location.origin : DEFAULT_LOCAL_API_ORIGIN);
  const url = `${baseUrl}${endpoint}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof window !== "undefined" && (window as any).__NOLO_DESKTOP__) {
    headers["X-Nolo-Desktop-Tool"] = "1";
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text, ok: res.ok, status: res.status };
  }
}

function formatExecResult(prefixLabel: string, args: any, json: any, trimmedCommand: string, sessionId?: string) {
  const prefix = json?.ok === false || json?.error ? `[${prefixLabel} 失败]` : `[${prefixLabel} 成功]`;
  const stdout = json.stdout ?? "";
  const stderr = json.stderr ?? "";
  const exitCode = json.exitCode ?? json.code ?? null;
  const responseSessionId = json.sessionId ?? sessionId ?? null;
  const responseInteractive = json.interactive === true;
  const responseRunning = json.running;

  const displayParts: string[] = [];
  displayParts.push(`${prefix} command: ${json.command ?? trimmedCommand ?? "(session follow-up)"}`);
  if (json.shell ?? args.shell) {
    displayParts.push(`shell: ${json.shell ?? args.shell}`);
  }
  if (args.cwd) {
    displayParts.push(`cwd: ${args.cwd}`);
  }
  if (responseSessionId) {
    displayParts.push(`sessionId: ${responseSessionId}`);
  }
  if (responseInteractive) {
    displayParts.push(`running: ${responseRunning === false ? "false" : "true"}`);
  }
  if (exitCode !== null && exitCode !== undefined) {
    displayParts.push(`exitCode: ${exitCode}`);
  }
  if (stdout) {
    displayParts.push("\n[stdout]\n" + stdout.trim());
  }
  if (stderr) {
    displayParts.push("\n[stderr]\n" + stderr.trim());
  }

  return {
    rawData: {
      command: trimmedCommand || null,
      cwd: args.cwd ?? null,
      shell: args.shell ?? "auto",
      ...json,
    },
    displayData: displayParts.join("\n"),
  };
}

function throwExecToolError(toolName: "execShell", message: string, rawData?: any): never {
  const displayData = `${toolName} 调用失败：${message}`;
  throw new ToolResultError(displayData, {
    code: "EXEC_TOOL_FAILED",
    rawData: rawData ?? { error: displayData },
    displayData,
    retryable: true,
  });
}

function buildBlockedResponse(toolName: "execShell", trimmedCommand: string, cwd?: string, shell?: ExecShellKind) {
  const lines: string[] = [];
  lines.push(`[${toolName} 拦截] 检测到潜在危险命令，默认不执行。`);
  lines.push(`command: ${trimmedCommand}`);
  if (cwd) {
    lines.push(`cwd: ${cwd}`);
  }
  lines.push(
    "如果你确实确认需要执行，请在界面中手动确认或在工具参数中显式传入 unsafe: true（仍建议先检查命令是否有误）。"
  );

  return {
    rawData: {
      applied: false,
      blocked: true,
      reason: "dangerous_command",
      requireUnsafe: true,
      command: trimmedCommand,
      cwd: cwd ?? null,
      shell: shell ?? "auto",
    },
    displayData: lines.join("\n"),
  };
}

export const startExecShellSession = (
  thunkApi: any,
  args: { command: string; cwd?: string; pty?: boolean; shell?: ExecShellKind }
) =>
  requestExec(
    {
      command: args.command,
      cwd: args.cwd,
      interactive: true,
      pty: args.pty,
      shell: args.shell,
    },
    thunkApi,
  );

export async function execShellFunc(args: any, thunkApi?: any, context?: { parentMessageId?: string; signal?: AbortSignal; toolRunId?: string; agentKey?: string; userInput?: string }): Promise<{
  rawData: any;
  displayData: string;
}> {
  const { command, cwd, shell, unsafe, interactive, pty, sessionId, input, close } = args || {};
  const isSessionFollowup = typeof sessionId === "string" && sessionId.trim().length > 0;

  if (!isSessionFollowup && (!command || typeof command !== "string")) {
    const msg = "execShell 需要提供 command，或提供有效的 sessionId 来继续已有交互式 session。";
    return { rawData: { error: msg }, displayData: msg };
  }

  const trimmedCommand = typeof command === "string" ? command.trim() : "";
  if (!isSessionFollowup && !unsafe && isDangerousCommand(trimmedCommand)) {
    return buildBlockedResponse("execShell", trimmedCommand, cwd, shell);
  }

  try {
    const json = await requestExec({
      ...(trimmedCommand ? { command: trimmedCommand } : {}),
      ...(cwd ? { cwd } : {}),
      ...(shell ? { shell } : {}),
      ...(interactive ? { interactive: true } : {}),
      ...(pty ? { pty: true } : {}),
      ...(isSessionFollowup ? { sessionId } : {}),
      ...(typeof input === "string" ? { input } : {}),
      ...(close ? { close: true } : {}),
    }, thunkApi, "/api/exec-shell", context);
    if (json?.ok === false || json?.error) {
      const message = typeof json?.error === "string" ? json.error : JSON.stringify(json?.error ?? json);
      throwExecToolError("execShell", message, { command: trimmedCommand || null, ...json });
    }
    return formatExecResult("execShell", { cwd, shell }, json, trimmedCommand, sessionId);
  } catch (error: any) {
    if (error instanceof ToolResultError) throw error;
    throwExecToolError("execShell", error?.message || String(error));
  }
}
