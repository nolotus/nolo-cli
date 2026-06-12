import { runAgentListCommand } from "./agentListCommands";
import {
  runAgentBindCurrentCommand,
  runAgentRuntimeDoctorCommand,
  runAgentSmokeCurrentCommand,
} from "./agentMachineCommands";
import { runAgentPullCommand } from "./agentPullCommand";
import {
  runAgentReadCommand,
  runAgentUpdateCommand,
  runAgentCreateCommand,
} from "./agentRecordCommands";
import { runAgentRunCommand } from "./agentRunCommand";
import { runQoderUsageCommand } from "./qoderUsageProbe";
import {
  createEnvCommand,
  createEnvScriptDirCommand,
} from "./cliCommandFactories";
import type { CommandEntry } from "./cliCommandTypes";
import { runSetupOfflineMarxistsAgentCommand } from "./offlineMarxistsAgentCommand";

export function getAgentInternalCommandEntries(): CommandEntry[] {
  const createAgentRunCommand = (path: string[], description: string): CommandEntry =>
    createEnvScriptDirCommand(path, description, (args, deps) =>
      runAgentRunCommand(args, { ...deps, commandPath: path })
    );

  return [
    createAgentRunCommand(["run"], "Run a no-login local agent in this workspace"),
    createAgentRunCommand(["chat"], "Chat with an agent"),
    createEnvCommand(["agent", "list"], "List owned agents", runAgentListCommand),
    createEnvCommand(["agent", "create"], "Create a new agent", runAgentCreateCommand),
    createEnvCommand(["agent", "pull"], "Cache an agent for local runs", runAgentPullCommand),
    createEnvCommand(["agent", "read"], "Read a single agent", runAgentReadCommand),
    createAgentRunCommand(["agent", "run"], "Run an agent"),
    createEnvCommand(["agent", "usage"], "Read local provider usage for an agent", runQoderUsageCommand),
    createEnvCommand(["agent", "setup-offline-marxists"], "Create or update the Marxists.org offline book agent", runSetupOfflineMarxistsAgentCommand),
    createEnvCommand(["agent", "update"], "Update agent fields", runAgentUpdateCommand),
    createEnvCommand(["agent", "bind-current"], "Bind an agent to this machine", runAgentBindCurrentCommand),
    createEnvCommand(["agent", "smoke-current"], "Smoke test a bound agent through this machine", runAgentSmokeCurrentCommand),
    createEnvCommand(["agent", "runtime-doctor"], "Diagnose current machine runtime compatibility", runAgentRuntimeDoctorCommand),
    createAgentRunCommand(["agent", "chat"], "Chat with an agent"),
  ];
}
