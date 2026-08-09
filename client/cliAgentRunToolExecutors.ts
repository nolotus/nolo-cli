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
import {
  formatListRunsCard,
  formatNotFoundRunCard,
  formatStartRunCard,
  formatStatusRunCard,
  formatStopRunCard,
  resolveRunLabel,
} from "../ai/tools/agent/agentRunDisplayHelpers";
import {
  type AgentRunControlDeps,
  type FsLike,
  checkStaleRun,
  finalizeRunRecord,
  findRunRecord,
  listRunRecords,
  spawnLocalBackgroundRun,
} from "../agentRunControl";
import { agentRunCardLabels } from "../tui/i18n";

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
    const rawArgs = [
      "--agent",
      agentKey,
      "--msg-file",
      "PLACEHOLDER",
      "--bg",
      // 非持久化派发（review 等一次性任务）：透传 --ephemeral，run 完成后不留
      // dialog 记录。与 web 端 runAgentBackground 的 ephemeral: true 对齐。
      ...(args.ephemeral === true ? ["--ephemeral"] : []),
    ];

    const agentName =
      typeof args.agentName === "string" && args.agentName.trim()
        ? args.agentName.trim()
        : typeof args.name === "string" && args.name.trim()
        ? args.name.trim()
        : undefined;

    const { runId } = await spawnLocalBackgroundRun(
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

    const displayName = resolveRunLabel({ agentName, agentKey, runId });
    const labels = agentRunCardLabels();
    return {
      content: JSON.stringify({
        runId,
        status: "running",
        ...(agentName ? { agentName } : {}),
      }),
      metadata: {
        displayData: formatStartRunCard(displayName, "running", labels),
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
      const runs = records.map((record) => {
        const reconciled = checkStaleRun(record.runId, deps) ?? record;
        return {
          runId: reconciled.runId,
          status: reconciled.status,
          agentKey: reconciled.agentKey,
          ...(reconciled.agentName ? { agentName: reconciled.agentName } : {}),
          pid: reconciled.pid ?? null,
          startedAt: reconciled.startedAt,
        };
      });
      const labels = agentRunCardLabels();
      return {
        content: JSON.stringify({ runs, count: runs.length }),
        metadata: {
          displayData: formatListRunsCard(runs, labels),
        },
      };
    }

    if (action !== "status" && action !== "stop") {
      throw new Error(`controlAgentRun: 未知 action "${action}"。`);
    }
    if (!args.runId) throw new Error(`controlAgentRun(action:"${action}"): 缺少 runId。`);

    const record = findRunRecord(String(args.runId), deps);
    if (!record) {
      const labels = agentRunCardLabels();
      return {
        content: JSON.stringify({ runId: args.runId, found: false }),
        metadata: { displayData: formatNotFoundRunCard(labels) },
      };
    }

    if (action === "status") {
      const reconciled = checkStaleRun(record.runId, deps) ?? record;
      const logTail =
        tailLines > 0
          ? tailFile(record.logPath, tailLines, resolveFs(deps))
          : undefined;
      const name = resolveRunLabel(reconciled);
      const logLines = logTail ? logTail.split("\n") : undefined;
      const labels = agentRunCardLabels();
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
          // Expose dialogId so the caller can read the agent's actual output
          // via `nolo dialog read <dialogId>`. The dialog is the authoritative
          // result store; the run log is the child process stdout/stderr,
          // whose contents vary by provider (some stream tokens to stdout,
          // some only emit startup + stderr). Because status does not carry
          // logTail by default, a "done" run with an empty logTail is
          // indistinguishable from a hung run without this field. Surfacing
          // dialogId gives the caller a reliable way to fetch the result.
          ...(reconciled.dialogId ? { dialogId: reconciled.dialogId } : {}),
          ...(logTail !== undefined ? { logTail } : {}),
          ...(logLines ? { logLines } : {}),
        }),
        metadata: {
          displayData: formatStatusRunCard(name, reconciled.status, { logLines, labels }),
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
    const labels = agentRunCardLabels();
    return {
      content: JSON.stringify({ runId: record.runId, found: true, status: "killed" }),
      metadata: { displayData: formatStopRunCard("killed", labels) },
    };
  };
}
