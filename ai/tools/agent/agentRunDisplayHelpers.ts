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
