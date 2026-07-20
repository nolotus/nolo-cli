import { BUILTIN_NOLO_AGENT_KEY } from "./builtinAgents";

export const nolotusId = "0e95801d90";
/**
 * Demo account (platform-demo). Being retired — all data has been migrated to
 * nolotusId or deleted. CI smoke has been migrated to use nolotusId agent.
 * Kept in ADMIN_IDS so the account can still admin-test during transition.
 *
 * RETIREMENT CHECKLIST (when this account is fully decommissioned):
 * 1. Remove copilotDemoId from this file and ADMIN_IDS.
 * 2. Remove the demo TOKEN from scripts/testUtils.ts + update authContext.test.ts
 *    and testAgentToolIntegration.test.ts (they assert parseUserIdFromAuthToken
 *    returns b2e06f801f — remove or replace with a nolotusId-based test token).
 * 3. Remove copilotDemoId mocks from all *.test.ts files (grep for b2e06f801f).
 * 4. Delete the user record on all servers via deleteUser API.
 *    (CI smoke already migrated — steps 3-4 in the old checklist are done.)
 */
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
