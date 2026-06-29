import type { CommandEntry } from "./cliCommandTypes";
import {
  createEnvCommand,
  createEnvScriptDirCommand,
} from "./cliCommandFactories";

export function getAgentInternalCommandEntries(): CommandEntry[] {
  const createAgentRunCommand = (path: string[], description: string): CommandEntry =>
    createEnvScriptDirCommand(path, description, async (args, deps) => {
      const { runAgentRunCommand } = await import("./agentRunCommand");
      return runAgentRunCommand(args, { ...deps, commandPath: path });
    });

  return [
    createAgentRunCommand(["run"], "Run a no-login local agent in this workspace"),
    createAgentRunCommand(["chat"], "Chat with an agent"),
    createEnvCommand(["agent", "list"], "List owned agents", async (args, deps) => {
      const { runAgentListCommand } = await import("./agentListCommands");
      return runAgentListCommand(args, deps);
    }),
    createEnvCommand(["agent", "create"], "Create a new agent", async (args, deps) => {
      const { runAgentCreateCommand } = await import("./agentRecordCommands");
      return runAgentCreateCommand(args, deps);
    }),
    createEnvCommand(["agent", "pull"], "Cache an agent for local runs", async (args, deps) => {
      const { runAgentPullCommand } = await import("./agentPullCommand");
      return runAgentPullCommand(args, deps);
    }),
    createEnvCommand(["agent", "read"], "Read a single agent", async (args, deps) => {
      const { runAgentReadCommand } = await import("./agentRecordCommands");
      return runAgentReadCommand(args, deps);
    }),
    createAgentRunCommand(["agent", "run"], "Run an agent"),
    createEnvCommand(["agent", "setup-offline-marxists"], "Create or update the Marxists.org offline book agent", async (args, deps) => {
      const { runSetupOfflineMarxistsAgentCommand } = await import("./offlineMarxistsAgentCommand");
      return runSetupOfflineMarxistsAgentCommand(args, deps);
    }),
    createEnvCommand(["agent", "update"], "Update agent fields", async (args, deps) => {
      const { runAgentUpdateCommand } = await import("./agentRecordCommands");
      return runAgentUpdateCommand(args, deps);
    }),
    createEnvCommand(["agent", "delete"], "Hard-delete an agent's private and public records", async (args, deps) => {
      const { runAgentDeleteCommand } = await import("./agentDeleteCommand");
      return runAgentDeleteCommand(args, deps);
    }),
    createEnvCommand(["agent", "bind-current"], "Bind an agent to this machine", async (args, deps) => {
      const { runAgentBindCurrentCommand } = await import("./agentMachineCommands");
      return runAgentBindCurrentCommand(args, deps);
    }),
    createEnvCommand(["agent", "smoke-current"], "Smoke test a bound agent through this machine", async (args, deps) => {
      const { runAgentSmokeCurrentCommand } = await import("./agentMachineCommands");
      return runAgentSmokeCurrentCommand(args, deps);
    }),
    createEnvCommand(["agent", "runtime-doctor"], "Diagnose current machine runtime compatibility", async (args, deps) => {
      const { runAgentRuntimeDoctorCommand } = await import("./agentMachineCommands");
      return runAgentRuntimeDoctorCommand(args, deps);
    }),
    createAgentRunCommand(["agent", "chat"], "Chat with an agent"),
  ];
}
