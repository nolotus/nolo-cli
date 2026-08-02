// packages/cli/client/cliAgentRunToolExecutors.ts
//
// CLI 本地实现 startAgentRun / controlAgentRun（agent-orchestration 能力包）。
// 复用 agentRunControl.ts 的 ~/.nolo/runs/ 注册表机制（spawnLocalBackgroundRun /
// findRunRecord / listRunRecords / checkStaleRun / finalizeRunRecord），把能力包
// 的两个编排工具接到 CLI 本地 --bg 路径上。
//
// 返回格式与 web 端 executor 一致：{ content: JSON(rawData), metadata.displayData }，
// 由 localToolExecutors 分发（host adapter executeTool）。

import { existsSync, readFileSync } from "node:fs";
import { getAgentRunStatusIcon } from "../ai/tools/agent/agentRunDisplayHelpers";
import {
  type AgentRunControlDeps,
  type FsLike,
  checkStaleRun,
  finalizeRunRecord,
  findRunRecord,
  listRunRecords,
  spawnLocalBackgroundRun,
} from "../agentRunControl";

type EnvLike = Record<string, string | undefined>;
type OutputLike = { write(chunk: string): unknown };

export type CliAgentRunToolExecutorDeps = {
  env?: EnvLike;
  /** CLI entrypoint path（spawn 子进程重启动用）。 */
  cliEntrypoint?: string;
  /** run 的工作目录；缺省用 process.cwd()。 */
  cwd?: string;
} & AgentRunControlDeps;

const noopOutput: OutputLike = { write: () => {} };

const parseCallArgs = (call: any): Record<string, any> => {
  try {
    return JSON.parse(call?.arguments || "{}");
  } catch {
    return {};
  }
};

const resolveFs = (deps: CliAgentRunToolExecutorDeps): FsLike =>
  (deps.fs ?? { existsSync, readFileSync }) as FsLike;

const tailFile = (
  logPath: string,
  tailLines: number,
  fs: FsLike,
): string | undefined => {
  if (!fs.existsSync(logPath)) return undefined;
  try {
    const content = fs.readFileSync(logPath, "utf8");
    const lines = String(content).split(/\r?\n/);
    // 去掉文件末尾换行产生的空元素，避免污染最后一行。
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(Math.max(0, lines.length - tailLines)).join("\n");
  } catch {
    return undefined;
  }
};

/** startAgentRun：本地 --bg 启动一个后台 run，返回 runId。 */
export function createCliStartAgentRunExecutor(deps: CliAgentRunToolExecutorDeps = {}) {
  return async (call: any): Promise<{ content: string; metadata?: Record<string, unknown> }> => {
    const args = parseCallArgs(call);
    const agentKey = typeof args.agentKey === "string" ? args.agentKey.trim() : "";
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!agentKey) throw new Error("startAgentRun: 缺少 agentKey 参数。");
    if (!task) throw new Error("startAgentRun: 缺少有效的 task 文本描述。");

    const message =
      typeof args.input === "undefined"
        ? task
        : `${task}\n\n--- 附加输入 ---\n${JSON.stringify(args.input)}`;

    // --msg-file 占位会被 spawnLocalBackgroundRun 的 rewriteMsgFileArg 改写为
    // runs 目录里的内容快照（~/.nolo/runs/<runId>.msg.md）；--bg 会被子进程剥离。
    const rawArgs = ["--agent", agentKey, "--msg-file", "PLACEHOLDER", "--bg"];

    const agentName =
      typeof args.agentName === "string" && args.agentName.trim()
        ? args.agentName.trim()
        : typeof args.name === "string" && args.name.trim()
        ? args.name.trim()
        : undefined;

    const { runId, pid } = await spawnLocalBackgroundRun(
      {
        rawArgs,
        commandPath: ["agent", "run"],
        cliEntrypointPath: deps.cliEntrypoint,
        agentKey,
        ...(agentName ? { agentName } : {}),
        cwd: deps.cwd ?? process.cwd(),
        message,
        output: noopOutput,
      },
      deps,
    );

    const displayName = agentName ?? "agent";
    const pidStr = pid != null ? String(pid) : "—";
    return {
      content: JSON.stringify({ runId, status: "running" }),
      metadata: {
        displayData: `Run started\n  agent   ${displayName}\n  runId   ${runId}\n  pid     ${pidStr}`,
      },
    };
  };
}

/** controlAgentRun：list / status / stop，映射到本地 ~/.nolo/runs/ 注册表。 */
export function createCliControlAgentRunExecutor(deps: CliAgentRunToolExecutorDeps = {}) {
  return async (call: any): Promise<{ content: string; metadata?: Record<string, unknown> }> => {
    const args = parseCallArgs(call);
    const action = typeof args.action === "string" ? args.action : "";
    const tailLines = typeof args.tailLines === "number" ? args.tailLines : 0;

    if (action === "list") {
      const records = listRunRecords(deps);
      const runs = records.map((record) => ({
        runId: record.runId,
        status: record.status,
        agentKey: record.agentKey,
        ...(record.agentName ? { agentName: record.agentName } : {}),
        pid: record.pid ?? null,
        startedAt: record.startedAt,
      }));
      const lines = [`Runs (${runs.length})`];
      for (const record of records) {
        const reconciled = checkStaleRun(record.runId, deps) ?? record;
        const icon = getAgentRunStatusIcon(reconciled.status);
        const name = reconciled.agentName || "agent";
        lines.push(`  ${icon}  ${name}  ${reconciled.runId}`);
      }
      return {
        content: JSON.stringify({ runs, count: runs.length }),
        metadata: {
          displayData: lines.join("\n"),
        },
      };
    }

    if (action !== "status" && action !== "stop") {
      throw new Error(`controlAgentRun: 未知 action "${action}"。`);
    }
    if (!args.runId) throw new Error(`controlAgentRun(action:"${action}"): 缺少 runId。`);

    const record = findRunRecord(String(args.runId), deps);
    if (!record) {
      return {
        content: JSON.stringify({ runId: args.runId, found: false }),
        metadata: { displayData: `Run status\n  ? not_found\n  runId   ${args.runId}` },
      };
    }

    if (action === "status") {
      const reconciled = checkStaleRun(record.runId, deps) ?? record;
      const logTail =
        tailLines > 0
          ? tailFile(record.logPath, tailLines, resolveFs(deps))
          : undefined;
      const icon = getAgentRunStatusIcon(reconciled.status);
      const name = reconciled.agentName || "agent";
      const statusLines = [
        "Run status",
        `  ${icon} ${reconciled.status}`,
        `  agent   ${name}`,
        `  runId   ${reconciled.runId}`,
        `  pid     ${reconciled.pid ?? "—"}`,
      ];
      if (logTail) {
        statusLines.push("", "Log tail:", logTail);
      }
      return {
        content: JSON.stringify({
          runId: reconciled.runId,
          found: true,
          status: reconciled.status,
          pid: reconciled.pid ?? null,
          agentKey: reconciled.agentKey,
          ...(reconciled.agentName ? { agentName: reconciled.agentName } : {}),
          startedAt: reconciled.startedAt,
          endedAt: reconciled.endedAt ?? null,
          exitCode: reconciled.exitCode ?? null,
          ...(logTail !== undefined ? { logTail } : {}),
        }),
        metadata: {
          displayData: statusLines.join("\n"),
        },
      };
    }

    // action === "stop"
    if (typeof record.pid === "number") {
      try {
        (deps.kill ?? ((pid: number, signal: string) => process.kill(pid, signal as NodeJS.Signals)))(
          record.pid,
          "SIGTERM",
        );
      } catch {
        // pid 已不存在或无权：继续 finalize 为 killed（与 CLI stop 命令行为一致）。
      }
    }
    finalizeRunRecord(record.runId, { status: "killed" }, deps);
    return {
      content: JSON.stringify({ runId: record.runId, found: true, status: "killed" }),
      metadata: { displayData: `Run stopped\n  🛑 killed\n  runId   ${record.runId}` },
    };
  };
}
