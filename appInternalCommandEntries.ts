import type { CommandEntry } from "./cliCommandTypes";
import { createEnvCommand } from "./cliCommandFactories";

export function getAppInternalCommandEntries(): CommandEntry[] {
  return [
    createEnvCommand(["app", "list"], "List your apps", async (args, deps) => {
      const { runAppListCommand } = await import("./appListCommands");
      return runAppListCommand(args, deps);
    }),
    createEnvCommand(["app", "get"], "Get app details", async (args, deps) => {
      const { runAppGetCommand } = await import("./appGetCommands");
      return runAppGetCommand(args, deps);
    }),
    createEnvCommand(["app", "deploy"], "Deploy an app", async (args, deps) => {
      const { runAppDeployCommand } = await import("./appDeployCommands");
      return runAppDeployCommand(args, deps);
    }),
    createEnvCommand(["app", "deploy", "status"], "Check app deploy status", async (args, deps) => {
      const { runAppDeployStatusCommand } = await import("./appDeployStatusCommands");
      return runAppDeployStatusCommand(args, deps);
    }),
    createEnvCommand(["app", "delete"], "Delete an app", async (args, deps) => {
      const { runAppDeleteCommand } = await import("./appDeleteCommands");
      return runAppDeleteCommand(args, deps);
    }),
  ];
}