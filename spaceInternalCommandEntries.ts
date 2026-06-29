import { createEnvCommand } from "./cliCommandFactories";
import type { CommandEntry } from "./cliCommandTypes";

export function getSpaceInternalCommandEntries(): CommandEntry[] {
  return [
    createEnvCommand(["space", "create"], "Create a space", async (args, deps) => {
      const { runSpaceCreateCommand } = await import("./spaceCommands");
      return runSpaceCreateCommand(args, deps);
    }),
    createEnvCommand(["space", "invite"], "Invite an existing user to a space", async (args, deps) => {
      const { runSpaceInviteCommand } = await import("./spaceCommands");
      return runSpaceInviteCommand(args, deps);
    }),
    createEnvCommand(["space", "accept-invite"], "Accept a space invite", async (args, deps) => {
      const { runSpaceAcceptInviteCommand } = await import("./spaceCommands");
      return runSpaceAcceptInviteCommand(args, deps);
    }),
    createEnvCommand(["space", "upload"], "Upload a file to a space", async (args, deps) => {
      const { runSpaceUploadCommand } = await import("./spaceCommands");
      return runSpaceUploadCommand(args, deps);
    }),
  ];
}
