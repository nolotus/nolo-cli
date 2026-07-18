import { BUILTIN_NOLO_AGENT_KEY } from "./builtinAgents";

export const nolotusId = "0e95801d90";
export const copilotDemoId = "b2e06f801f";

const ADMIN_IDS = new Set([nolotusId, copilotDemoId]);

export const isSystemAdmin = (userId?: string | null) =>
  userId != null && ADMIN_IDS.has(userId);

export const AI_ADMIN_ROLE = "AI管理员";

const envAiAdminIds = () =>
  new Set(
    (process.env.AI_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );

const recordHasAiAdminRole = (record: unknown): boolean => {
  if (!record || typeof record !== "object") return false;
  const value = record as Record<string, unknown>;
  const scalarFields = [value.role, value.globalRole, value.systemRole];
  if (scalarFields.some((item) => item === AI_ADMIN_ROLE)) return true;
  const listFields = [value.roles, value.globalRoles, value.systemRoles, value.permissions];
  return listFields.some(
    (item) => Array.isArray(item) && item.includes(AI_ADMIN_ROLE)
  );
};

export const isAIAdmin = (
  userId?: string | null,
  ...records: unknown[]
) =>
  isSystemAdmin(userId) ||
  (userId != null && envAiAdminIds().has(userId)) ||
  records.some(recordHasAiAdminRole);

export const noloAgentId = BUILTIN_NOLO_AGENT_KEY;
