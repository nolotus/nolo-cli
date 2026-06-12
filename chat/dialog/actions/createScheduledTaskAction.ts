import { selectUserId } from "../../../auth/authSlice";
import { addContentToSpace } from "../../../create/space/spaceSlice";
import { DataType } from "../../../create/types";
import { write } from "../../../database/dbSlice";
import { createTaskKey } from "../../../database/keys";
import { extractCustomId } from "../../../core/prefix";
import { computeNextScheduledAt } from "../schedule";
import type { ScheduledTaskConfig } from "../../../app/types";

interface CreateScheduledTaskArgs {
  agentKey: string;
  title: string;
  schedule: string;
  taskPrompt: string;
  spaceId?: string | null;
}

export const createScheduledTaskAction = async (
  args: CreateScheduledTaskArgs,
  thunkApi: any
) => {
  const { dispatch, getState } = thunkApi;
  const userId = selectUserId(getState());
  if (!userId) {
    throw new Error("User is not logged in.");
  }

  const agentKey = args.agentKey?.trim();
  const schedule = args.schedule?.trim();
  const taskPrompt = args.taskPrompt?.trim();
  if (!agentKey || !schedule || !taskPrompt) {
    throw new Error("agentKey, schedule and taskPrompt are required.");
  }

  const nextRunAt = computeNextScheduledAt(schedule);
  if (!nextRunAt) {
    throw new Error("Invalid cron schedule.");
  }

  const dbKey = createTaskKey(userId);
  const id = extractCustomId(dbKey);
  const nowIso = new Date().toISOString();
  const title = args.title?.trim() || "Scheduled agent task";
  const spaceId = args.spaceId || undefined;
  const task: ScheduledTaskConfig = {
    id,
    dbKey,
    type: DataType.TASK,
    title,
    agentKey,
    cybots: [agentKey],
    createdBy: userId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: "active",
    runStatus: "idle",
    schedule,
    taskPrompt,
    nextRunAt,
    runDialogKeys: [],
    ...(spaceId ? { spaceId } : {}),
  };

  const result = await dispatch(write({ data: task, customKey: dbKey })).unwrap();

  if (spaceId) {
    await dispatch(
      addContentToSpace({
        spaceId,
        contentKey: dbKey,
        type: DataType.TASK,
        title,
      })
    );
  }

  return result;
};
