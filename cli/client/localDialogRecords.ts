import {
  buildAgentRuntimeDialogWritePlan,
  dialogMessageRecordToAgentRuntimeMessage,
  type AgentRuntimeSaveTurnInput,
} from "../agentRuntimeLocal";

type LocalDialogRecord = Record<string, any>;

export const localDialogMessageRecordToRuntimeMessage = dialogMessageRecordToAgentRuntimeMessage;

export function buildLocalDialogWritePlan(args: {
  input: AgentRuntimeSaveTurnInput;
  userId: string;
  now: number;
  createId: () => string;
  existingDialog?: LocalDialogRecord | null;
  cwd?: string;
  titleOverride?: string;
}) {
  return buildAgentRuntimeDialogWritePlan({
    input: args.input,
    userId: args.userId,
    now: args.now,
    createId: args.createId,
    existingDialog: args.existingDialog,
    runtimeHost: "cli",
    runtimeMetadata: {
      ...(args.cwd ? { worktreePath: args.cwd } : {}),
    },
    ...(args.titleOverride ? { titleOverride: args.titleOverride } : {}),
  });
}
