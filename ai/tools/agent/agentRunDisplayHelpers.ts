export function getAgentRunStatusIcon(status: string): string {
  switch (status) {
    case "running":
    case "pending":
      return "⏳";
    case "done":
      return "✓";
    case "failed":
    case "timeout":
      return "✗";
    case "killed":
    case "cancelled":
    case "cancelling":
      return "🛑";
    case "not_found":
    default:
      return "?";
  }
}

export function formatStartRunCard(agentName: string, status: string = "running"): string {
  const icon = getAgentRunStatusIcon(status);
  return `Run started\n  agent   ${agentName}\n  status  ${icon} ${status}`;
}

export function formatStatusRunCard(
  agentName: string,
  status: string = "running",
  opts?: {
    lastToolNames?: string[];
    toolCallCount?: number;
    errorMessage?: string;
    logLines?: string[];
  }
): string {
  const icon = getAgentRunStatusIcon(status);
  const lines = [`Run status`, `  ${icon} ${status}`, `  agent   ${agentName}`];
  if (opts?.lastToolNames && opts.lastToolNames.length > 0) {
    lines.push(`  lastTools ${opts.lastToolNames.join(", ")}`);
  }
  if (opts?.toolCallCount !== undefined) {
    lines.push(`  toolCalls ${opts.toolCallCount}`);
  }
  if (opts?.errorMessage?.trim()) {
    lines.push(`  error   ${opts.errorMessage.trim()}`);
  }
  if (opts?.logLines && opts.logLines.length > 0) {
    lines.push("", "Log tail:", ...opts.logLines.map((l) => `  ${l}`));
  }
  return lines.join("\n");
}

export function formatStopRunCard(status: string = "killed"): string {
  const icon = getAgentRunStatusIcon(status);
  return `Run stopped\n  ${icon} ${status}`;
}

export function formatListRunsCard(runs: Array<{ agentName?: string; name?: string; status?: string }>): string {
  const lines = [`Runs (${runs.length})`];
  for (const run of runs) {
    const status = run.status ?? "—";
    const icon = getAgentRunStatusIcon(status);
    const name = run.agentName || run.name || "agent";
    lines.push(`  ${icon}  ${name}`);
  }
  return lines.join("\n");
}
