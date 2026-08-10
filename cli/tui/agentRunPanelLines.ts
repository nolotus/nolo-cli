/**
 * 单条 run 的面板渲染（composer 上方那两行 `🤖 Sub-Agent: … / └ detail`）。
 *
 * 从 activityIndicator.ts 移过来独立成模块，纯粹是为了断开 import 环：
 * activityIndicator 现在把面板状态托管给 runDock，而 runDock 单 run 时仍复用
 * 这个格式化函数。渲染逻辑一字未改。
 */

import type { AgentRunSnapshot } from "../client/agentRunSnapshot";
import {
  formatRunAge,
  getAgentRunStatusIcon,
  isAgentRunTerminalStatus,
  runShowsLogTail,
  shortRunId,
} from "../../ai/tools/agent/agentRunDisplayHelpers";
import { activeInFlight, formatInFlightFact, runStatusTone } from "./runSnapshotDisplay";
import { themeText } from "./theme";

/**
 * Progress suffix: ` · 12 tools · read, grep`. Empty when the run has not
 * reported any tool activity yet.
 */
function formatPanelProgress(snapshot: AgentRunSnapshot, now: number): string {
  const parts: string[] = [];
  if (typeof snapshot.toolCallCount === "number" && Number.isFinite(snapshot.toolCallCount)) {
    parts.push(`${snapshot.toolCallCount} tools`);
  }
  // 「此刻在做什么」压过「最后做过什么」——前者带自己的计时，看得出卡没卡住；
  // 后者只是历史。只有本地 registry 轮询报得出它。
  const inFlight = activeInFlight(snapshot);
  if (inFlight) {
    parts.push(formatInFlightFact(inFlight, now));
  } else if (snapshot.lastToolNames && snapshot.lastToolNames.length > 0) {
    parts.push(snapshot.lastToolNames.join(", "));
  }
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/**
 * The run's own words beat its stdout. `lastAssistantText` is a sentence the
 * sub-agent wrote; the log tail is whatever byte sequence happened to land last
 * and is regularly a truncated JSON fragment.
 */
function formatPanelDetail(snapshot: AgentRunSnapshot): string {
  const note = snapshot.lastAssistantText?.trim();
  if (note) return note;
  // The log fallback obeys the same rule as the cards (`runShowsLogTail`)
  // rather than a second one of its own: raw stdout is evidence on a failed run
  // and noise on a healthy one. Falling back unconditionally here put the very
  // `DATA_CLONE_ERR: 25,` fragments the cards now withhold straight back onto
  // the dock.
  if (!runShowsLogTail(snapshot.status)) return "";
  const lines = snapshot.logLines;
  if (!lines || lines.length === 0) return "";
  return lines[lines.length - 1]?.trim() ?? "";
}

export function formatAgentRunPanelLines(
  snapshot: AgentRunSnapshot,
  colorEnabled: boolean,
  now: number = Date.now()
): string[] {
  const lines: string[] = [];
  const name = snapshot.agentName || "sub-agent";
  const short = shortRunId(snapshot.runId);
  const runId = short ? ` (${short})` : "";
  const status = snapshot.status || "running";

  // Status vocabulary comes from the run store (`done`/`failed`/`timeout`/
  // `killed`/`cancelled`), not from a guessed list — the previous local list
  // checked for `completed`/`finished`/`success`, none of which the store ever
  // emits, so a finished run kept rendering with the in-progress hourglass.
  const statusSymbol = getAgentRunStatusIcon(status);
  const statusColor = runStatusTone(status);

  const errPart = snapshot.errorMessage ? ` · ${snapshot.errorMessage}` : "";
  const progressPart = formatPanelProgress(snapshot, now);
  // The panel repaints on a timer, so this ticks live — unlike the transcript
  // cards, which freeze the age at the moment they were emitted.
  const age = formatRunAge(snapshot, now);
  const agePart = age ? ` · ${age}` : "";

  if (!colorEnabled) {
    lines.push(
      `🤖 Sub-Agent: ${name}${runId} · ${statusSymbol} ${status}${agePart}${progressPart}${errPart}`
    );
  } else {
    const botIcon = themeText("🤖", "accent", true);
    const labelText = themeText(" Sub-Agent: ", "muted", true);
    const nameText = themeText(`${name}${runId}`, "chrome", true);
    // agePart belongs on the coloured branch too — the real TUI runs with
    // colour on, so omitting it here made the live duration invisible in
    // exactly the mode users see.
    const statusText = themeText(` · ${statusSymbol} ${status}`, statusColor, true);
    const ageText = agePart ? themeText(agePart, "chrome") : "";
    const progressText = progressPart ? themeText(progressPart, "chrome") : "";
    const errorText = errPart ? themeText(errPart, "danger") : "";
    lines.push(`${botIcon}${labelText}${nameText}${statusText}${ageText}${progressText}${errorText}`);
  }

  const detail = formatPanelDetail(snapshot);
  if (detail) {
    if (!colorEnabled) {
      lines.push(`   └ ${detail}`);
    } else {
      lines.push(`${themeText("   └ ", "muted")}${themeText(detail, "chrome")}`);
    }
  }

  return lines;
}
