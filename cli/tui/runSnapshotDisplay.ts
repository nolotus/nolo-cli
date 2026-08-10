/**
 * run 快照的渲染原子——单 run 面板（agentRunPanelLines）和多 run 停靠区
 * （runDock）共用的那几条小规则。
 *
 * 抽出来的理由是它们本来各有一份：`llm → thinking` 的改名规则、终态/非终态
 * 的配色三元、字段截断。三条规则都是「同一个概念在两个界面上的同一种表达」，
 * 各存一份的唯一结果就是有人改了其中一个，两块面板从此各说各话。
 *
 * 两边都不能反过来 import 对方（runDock 已经依赖 agentRunPanelLines 渲染单
 * run 形态，反向依赖会成环），所以这些原子需要一个自己的家。
 */

import type { AgentRunSnapshot } from "../client/agentRunSnapshot";
import {
  clipText,
  formatDuration,
  isAgentRunTerminalStatus,
} from "../../ai/tools/agent/agentRunDisplayHelpers";

/** 主题色档：跑着的是「注意」，做完的是「成功」，其余都是「出事了」。 */
export type RunStatusTone = "warning" | "success" | "danger";

export function runStatusTone(status: string): RunStatusTone {
  if (!isAgentRunTerminalStatus(status)) return "warning";
  return status === "done" ? "success" : "danger";
}

/**
 * 此刻正在进行的动作 —— `Edit 3s` / `thinking 12s`。
 *
 * 计时从动作自己的起点算，不是从 run 的起点算：一个跑了 6 分钟的 run 卡在某个
 * 工具上 90 秒，和它每 3 秒换一个工具，是完全不同的两件事，而只有这个数字能
 * 把它们区分开。
 *
 * llm 阶段不报模型名（记录里那个字段就是字面量 "llm"），报它在干嘛。
 */
export function formatInFlightFact(
  inFlight: NonNullable<AgentRunSnapshot["inFlight"]>,
  now: number,
  maxNameLength = 20
): string {
  const label = inFlight.kind === "llm" ? "thinking" : clipText(inFlight.name, maxNameLength);
  return `${label} ${formatDuration(Math.max(0, now - inFlight.startedAt))}`;
}

/**
 * run 此刻在做的事，没有则返回 null。
 *
 * 终态 run 没有「此刻」可言——它的动作字段可能还留着死前最后一次采样，直接
 * 渲染出来会让一条已经结束的 run 看着还在跑。
 */
export function activeInFlight(
  snapshot: AgentRunSnapshot
): NonNullable<AgentRunSnapshot["inFlight"]> | null {
  if (isAgentRunTerminalStatus(snapshot.status)) return null;
  return snapshot.inFlight ?? null;
}
