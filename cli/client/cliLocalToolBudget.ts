/**
 * Local tool budget + execShell detach config.
 *
 * Extracted from localRuntimeAdapter.ts. Pure env-driven config + budget
 * guard — no module state, no shared caches.
 */

import type { EnvLike } from "./localRuntimeHelpers";

/**
 * Parse `NOLO_LOCAL_TOOL_BUDGETS=name=count,name2=count2` into a map.
 * Used to cap how many times a tool can fire in one local turn.
 */
export function parseLocalToolBudgets(env: EnvLike): Record<string, number> {
  const raw = env.NOLO_LOCAL_TOOL_BUDGETS?.trim();
  if (!raw) return {};
  const budgets: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const [name, value] = part.split("=").map((item) => item.trim());
    const limit = Number(value);
    if (name && Number.isFinite(limit) && limit >= 0)
      budgets[name] = Math.floor(limit);
  }
  return budgets;
}

const EXEC_SHELL_DETACH_ENV = "NOLO_EXEC_SHELL_DETACH_MS";
const DEFAULT_EXEC_SHELL_DETACH_MS = 120_000;

/**
 * Read execShell auto-detach threshold (ms).
 * env `NOLO_EXEC_SHELL_DETACH_MS` overrides; default 120s.
 */
export function resolveExecShellDetachMs(env: NodeJS.ProcessEnv): number {
  const raw = env[EXEC_SHELL_DETACH_ENV];
  if (raw === undefined) return DEFAULT_EXEC_SHELL_DETACH_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_EXEC_SHELL_DETACH_MS;
  }
  return parsed;
}

/**
 * Increment per-tool usage and throw if it exceeds the configured budget.
 * Prevents runaway broad-discovery tools from burning a whole turn.
 */
export function assertWithinLocalToolBudget(args: {
  toolName: string;
  budgets: Record<string, number>;
  usage: Map<string, number>;
}) {
  const limit = args.budgets[args.toolName];
  if (typeof limit !== "number") return;
  const nextCount = (args.usage.get(args.toolName) ?? 0) + 1;
  args.usage.set(args.toolName, nextCount);
  if (nextCount <= limit) return;
  throw new Error(
    `${args.toolName} exceeded local tool budget ${limit}. Stop broad discovery; edit the narrowest likely file or report a blocker.`,
  );
}