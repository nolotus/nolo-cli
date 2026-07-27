import { NOLO_PROJECT_MANAGER_AGENT_KEY } from "../agentAliases";
import { normalizeAgentHandle } from "../../core/agentHandle";
import type { RunAgentTurnOptions } from "./agentRunTypes";

// Table mutations require the server runtime.
// Read-only queryTableRows is intentionally excluded: local CLI executes it via
// noloWorkspaceTools, so auto mode should not skip local just because it appears
// in the private workspace tool set.
const SERVER_PLATFORM_TOOL_NAMES = new Set([
  "addTableRow",
  "addTableRows",
  "deleteTableRow",
  "deleteTableRows",
  "updateTableRow",
  "updateTableRows",
]);

const KNOWN_SERVER_PLATFORM_AGENT_KEYS = new Set([NOLO_PROJECT_MANAGER_AGENT_KEY]);

const KNOWN_SERVER_PLATFORM_AGENT_ALIASES = new Set([
  "code-review",
  "frontend",
  "frontend-agent",
  "frontend-implementer",
  "full-stack",
  "fullstack",
  "nolo code review",
  "nolo fullstack",
  "nolo project manager",
  "nolo reviewer",
  "nolo-code-review",
  "nolo-fullstack",
  "nolo-pm",
  "nolo-project-manager",
  "nolo-reviewer",
  "pm",
  "project-manager",
  "review",
  "reviewer",
]);

export function findServerPlatformTools(toolNames?: string[]) {
  if (!Array.isArray(toolNames)) return [];
  return toolNames.filter((toolName) =>
    SERVER_PLATFORM_TOOL_NAMES.has(toolName),
  );
}

export function resolveServerPlatformToolNames(agentConfig: any) {
  return findServerPlatformTools([
    ...(Array.isArray(agentConfig?.toolNames) ? agentConfig.toolNames : []),
    ...(Array.isArray(agentConfig?.runtimeToolPolicy?.agentTools)
      ? agentConfig.runtimeToolPolicy.agentTools
      : []),
  ]);
}

export function isKnownServerPlatformAgent(options: RunAgentTurnOptions) {
  if (KNOWN_SERVER_PLATFORM_AGENT_KEYS.has(options.agentKey)) return true;
  const normalizedKey = normalizeAgentHandle(options.agentKey);
  return Boolean(
    normalizedKey && KNOWN_SERVER_PLATFORM_AGENT_ALIASES.has(normalizedKey),
  );
}