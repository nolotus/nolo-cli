import type { CommandEntry } from "./cliCommandTypes";
import {
  createContextCommand,
  createEnvCommand,
  createEnvScriptDirCommand,
} from "./cliCommandFactories";
import {
  runAgentEmailBindCommand,
  runAgentEmailCreateAndProvisionCommand,
  runAgentEmailProvisionCommand,
  runAgentEmailTransferCommand,
} from "./agentEmailCommands";

export function getAgentInternalCommandEntries(): CommandEntry[] {
  const createAgentRunCommand = (path: string[], description: string): CommandEntry =>
    createContextCommand(path, description, async (args, ctx) => {
      const { runAgentRunCommand } = await import("./agentRunCommand");
      return runAgentRunCommand(args, {
        env: ctx.env,
        scriptDir: ctx.scriptDir,
        cliEntrypointPath: ctx.entrypointPath,
        commandPath: path,
      });
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
    createEnvCommand(["agent", "ps"], "List active and recent local agent runs (--json for machine-readable output)", async (_args, deps) => {
      const { runAgentPsCommand } = await import("./agentRunControl");
      return runAgentPsCommand(_args, { ...deps, output: process.stdout });
    }),
    createEnvCommand(["agent", "status"], "Show status of a local agent run (--json, --watch, --interval-ms N)", async (args, deps) => {
      const { runAgentStatusCommand } = await import("./agentRunControl");
      return runAgentStatusCommand(args, { ...deps, output: process.stdout });
    }),
    createEnvCommand(["agent", "logs"], "Show logs of a local agent run", async (args, deps) => {
      const { runAgentLogsCommand } = await import("./agentRunControl");
      return runAgentLogsCommand(args, { ...deps, output: process.stdout });
    }),
    createEnvCommand(["agent", "stop"], "Stop a local agent run", async (args, deps) => {
      const { runAgentStopCommand } = await import("./agentRunControl");
      return runAgentStopCommand(args, { ...deps, output: process.stdout });
    }),
    createEnvCommand(["agent", "kill"], "Kill a local agent run", async (args, deps) => {
      const { runAgentKillCommand } = await import("./agentRunControl");
      return runAgentKillCommand(args, { ...deps, output: process.stdout });
    }),
    createEnvCommand(["agent", "setup-offline-marxists"], "Create or update the Marxists.org offline book agent", async (args, deps) => {
      const { runSetupOfflineMarxistsAgentCommand } = await import("./offlineMarxistsAgentCommand");
      return runSetupOfflineMarxistsAgentCommand(args, deps);
    }),
    createEnvCommand(["agent", "update"], "Update agent fields", async (args, deps) => {
      const { runAgentUpdateCommand } = await import("./agentRecordCommands");
      return runAgentUpdateCommand(args, deps);
    }),
    createEnvCommand(["agent", "email", "provision"], "Provision a controlled inbox for an agent", async (args, deps) => {
      return runAgentEmailProvisionCommand(args, deps);
    }),
    createEnvCommand(["agent", "email", "bind"], "Bind an existing email address to an agent", async (args, deps) => {
      return runAgentEmailBindCommand(args, deps);
    }),
    createEnvCommand(["agent", "email", "transfer"], "Transfer an email identity from one agent to another (cross-account)", async (args, deps) => {
      return runAgentEmailTransferCommand(args, deps);
    }),
    createEnvCommand(
      ["agent", "email", "create-and-provision"],
      "Create an agent and provision its controlled inbox",
      async (args, deps) => {
        return runAgentEmailCreateAndProvisionCommand(args, deps);
      }
    ),
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