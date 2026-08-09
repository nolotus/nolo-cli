import { getAgentInternalCommandEntries } from "./agentInternalCommandEntries";
import { getDialogInternalCommandEntries } from "./dialogInternalCommandEntries";
import { getDocInternalCommandEntries } from "./docInternalCommandEntries";
import type { CommandEntry } from "./cliCommandTypes";
import { getMemoryInternalCommandEntries } from "./memoryInternalCommandEntries";
import { getSpaceInternalCommandEntries } from "./spaceInternalCommandEntries";
import { getSystemInternalCommandEntries } from "./systemInternalCommandEntries";
import { getTableInternalCommandEntries } from "./tableInternalCommandEntries";
import { getWorkflowInternalCommandEntries } from "./workflowInternalCommandEntries";

export function getInternalCommandEntries(renderHelpText: () => string): CommandEntry[] {
  return [
    ...getAgentInternalCommandEntries(),
    ...getDialogInternalCommandEntries(),
    ...getDocInternalCommandEntries(),
    ...getMemoryInternalCommandEntries(),
    ...getSpaceInternalCommandEntries(),
    ...getTableInternalCommandEntries(),
    ...getWorkflowInternalCommandEntries(),
    ...getSystemInternalCommandEntries(renderHelpText),
  ];
}
