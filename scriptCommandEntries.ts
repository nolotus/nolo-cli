import { createScriptCommand, type CommandEntry } from "./cliCommandTypes";

function getDocScriptCommands(): CommandEntry[] {
  return [];
}

function getSpaceScriptCommands(): CommandEntry[] {
  return [
    createScriptCommand(["space", "list"], "listSpaces.ts", "List joined spaces"),
    createScriptCommand(["space", "read"], "readSpace.ts", "Read a space"),
    createScriptCommand(["space", "delete"], "deleteSpaces.ts", "Delete spaces by safe filters"),
    createScriptCommand(["space", "category"], "upsertSpaceCategory.ts", "Create or update a space category"),
    createScriptCommand(["space", "content-category"], "setSpaceContentCategory.ts", "Move content into a space category"),
  ];
}

function getTableScriptCommands(): CommandEntry[] {
  return [
    createScriptCommand(["table", "meta"], "upsertTableMeta.ts", "Create or update table metadata"),
  ];
}

function getAgentScriptCommands(): CommandEntry[] {
  return [
    createScriptCommand(["agent", "unpublish"], "unpublishAgent.ts", "Remove an agent's public record"),
    createScriptCommand(["agent", "dialogs"], "queryAgentDialogs.ts", "Inspect recent dialogs for an agent"),
    createScriptCommand(["agent", "doctor"], "doctorAgentWorkspace.ts", "Audit agent workspace health"),
    createScriptCommand(["agent", "create-custom"], "createCustomCodingAgent.ts", "Create a custom coding agent"),
    createScriptCommand(["agent", "create-space"], "createSpaceAgents.ts", "Create or attach shared-space agents"),
    createScriptCommand(["agent", "setup-demo"], "setupDemoAgent.ts", "Bootstrap demo publisher agents"),
  ];
}

function getRuntimeScriptCommands(): CommandEntry[] {
  return [
    createScriptCommand(["llama"], "llamaServerSupervisor.ts", "Manage the llama.cpp runtime"),
    createScriptCommand(["model-runtime"], "localModelRuntimeSupervisor.ts", "Manage local model runtime processes"),
    createScriptCommand(["dev"], "devControl.ts", "Manage the local dev environment"),
  ];
}

export function getScriptCommandEntries(): CommandEntry[] {
  return [
    ...getDocScriptCommands(),
    ...getSpaceScriptCommands(),
    ...getTableScriptCommands(),
    ...getAgentScriptCommands(),
    ...getRuntimeScriptCommands(),
  ];
}
