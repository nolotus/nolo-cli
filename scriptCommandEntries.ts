import { createScriptCommand, type CommandEntry } from "./cliCommandTypes";

function getDocScriptCommands(): CommandEntry[] {
  return [
    createScriptCommand(["doc", "read"], "readDoc.ts", "Read a normal doc"),
    createScriptCommand(["doc", "update"], "updateDoc.ts", "Update a normal doc"),
    createScriptCommand(["doc", "delete"], "deleteDoc.ts", "Delete a normal doc"),
    createScriptCommand(["skill-doc", "read"], "readSkillDoc.ts", "Read a skill doc"),
    createScriptCommand(["skill-doc", "update"], "updateSkillDoc.ts", "Update a skill doc"),
    createScriptCommand(["skill-doc", "delete"], "deleteSkillDoc.ts", "Delete a skill doc"),
  ];
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
    createScriptCommand(["table", "add-column"], "tableData.ts", "Add one table column", ["--action", "add-column"]),
    createScriptCommand(["table", "add-row"], "tableData.ts", "Add one table row", ["--action", "add-row"]),
    createScriptCommand(["table", "add-rows"], "tableData.ts", "Add table rows", ["--action", "add-rows"]),
    createScriptCommand(["table", "update-row"], "tableData.ts", "Update one table row", ["--action", "update-row"]),
    createScriptCommand(["table", "update-rows"], "tableData.ts", "Update table rows", ["--action", "update-rows"]),
    createScriptCommand(["table", "delete-row"], "tableData.ts", "Delete one table row", ["--action", "delete-row"]),
    createScriptCommand(["table", "delete-rows"], "tableData.ts", "Delete table rows", ["--action", "delete-rows"]),
    createScriptCommand(["table", "data"], "tableData.ts", "Low-level table row script bridge"),
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
    createScriptCommand(["agent", "supervise"], "runAutonomousAgent.ts", "Run an agent in autonomous cycles"),
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
