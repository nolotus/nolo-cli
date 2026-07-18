import { selectUserId } from "../../../auth/authSlice";
import { addContentToSpace } from "../../../create/space/spaceSlice";
import { DataType } from "../../../create/types";
import { write } from "../../../database/dbSlice";
import {
  buildAgentAutomationOwnerIndexValue,
  createAgentAutomationKey,
  createAgentAutomationOwnerIndexKey,
} from "../../../database/keys";
import { asOptionalTrimmedString } from "../../../core/optionalString";
import { computeNextScheduledAt } from "../schedule";
import type { AgentAutomationConfig } from "../../../app/types";

interface CreateAgentAutomationArgs {
  agentKey: string;
  title: string;
  schedule: string;
  taskPrompt: string;
  spaceId?: string | null;
}

export const createAgentAutomationAction = async (
  args: CreateAgentAutomationArgs,
  thunkApi: any
) => {
  const { dispatch, getState } = thunkApi;
  const userId = selectUserId(getState());
  if (!userId) {
    throw new Error("User is not logged in.");
  }

  const agentKey = asOptionalTrimmedString(args.agentKey);
  const schedule = asOptionalTrimmedString(args.schedule);
  const instruction = asOptionalTrimmedString(args.taskPrompt);
  if (!agentKey || !schedule || !instruction) {
    throw new Error("agentKey, schedule and instruction are required.");
  }

  const nextWakeAt = computeNextScheduledAt(schedule);
  if (!nextWakeAt) {
    throw new Error("Invalid cron schedule.");
  }

  const dbKey = createAgentAutomationKey(userId);
  const id = dbKey.slice(`${DataType.AGENT_AUTOMATION}-${userId}-`.length);
  const nowIso = new Date().toISOString();
  const title = asOptionalTrimmedString(args.title) ?? "Agent automation";
  const spaceId = args.spaceId || undefined;
  const automation: AgentAutomationConfig = {
    id,
    dbKey,
    type: DataType.AGENT_AUTOMATION,
    title,
    ownerAgentKey: agentKey,
    createdBy: userId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: "active",
    runStatus: "idle",
    instruction,
    trigger: {
      type: "cron",
      expression: schedule,
      nextWakeAt,
    },
    ...(spaceId ? { spaceId } : {}),
  };

  const result = await (dispatch as any)(write({ data: automation, customKey: dbKey })).unwrap();

  // Maintain owner secondary index locally (and best-effort via write path).
  // List-by-agent uses agent-automation-owner-idx-* for O(agent) scans.
  const ownerIndexKey = createAgentAutomationOwnerIndexKey(userId, agentKey, id);
  const ownerIndexValue = buildAgentAutomationOwnerIndexValue({
    userId,
    ownerAgentKey: agentKey,
    automationId: id,
    automationKey: dbKey,
  });
  try {
    await (dispatch as any)(
      write({ data: ownerIndexValue, customKey: ownerIndexKey }),
    ).unwrap();
  } catch (err) {
    // Index is best-effort on the client write path: local clientDb may still
    // hold the primary record. Server-side createAgentAutomation tool always
    // writes the index via serverDb.
    console.warn(
      "[createAgentAutomation] owner index write failed:",
      ownerIndexKey,
      err,
    );
  }

  if (spaceId) {
    await (dispatch as any)(
      (addContentToSpace as any)({
        spaceId,
        contentKey: dbKey,
        type: DataType.AGENT_AUTOMATION,
        title,
      })
    );
  }

  return result;
};
