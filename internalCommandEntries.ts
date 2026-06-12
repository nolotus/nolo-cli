import { getAgentInternalCommandEntries } from "./agentInternalCommandEntries";
import { getDialogInternalCommandEntries } from "./dialogInternalCommandEntries";
import { getDocInternalCommandEntries } from "./docInternalCommandEntries";
import type { CommandEntry } from "./cliCommandTypes";
import { getMemoryInternalCommandEntries } from "./memoryInternalCommandEntries";
import { getSystemInternalCommandEntries } from "./systemInternalCommandEntries";
import { getWorkflowInternalCommandEntries } from "./workflowInternalCommandEntries";

export function getInternalCommandEntries(renderHelpText: () => string): CommandEntry[] {
  return [
    ...getAgentInternalCommandEntries(),
    ...getDialogInternalCommandEntries(),
    ...getDocInternalCommandEntries(),
    ...getMemoryInternalCommandEntries(),
    ...getWorkflowInternalCommandEntries(),
    ...getSystemInternalCommandEntries(renderHelpText),
  ];
}
