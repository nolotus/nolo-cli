import { selectUserId } from "../../../auth/authSlice";
import { addContentToSpace } from "../../../create/space/spaceSlice";
import { DataType } from "../../../create/types";
import { write } from "../../../database/dbSlice";
import { createAgentAutomationKey } from "../../../database/keys";
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

  const agentKey = args.agentKey?.trim();
  const schedule = args.schedule?.trim();
  const instruction = args.taskPrompt?.trim();
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
  const title = args.title?.trim() || "Agent automation";
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
