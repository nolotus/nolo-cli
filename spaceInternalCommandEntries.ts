import { createEnvCommand } from "./cliCommandFactories";
import type { CommandEntry } from "./cliCommandTypes";
import {
  runSpaceAcceptInviteCommand,
  runSpaceCreateCommand,
  runSpaceInviteCommand,
} from "./spaceCommands";

export function getSpaceInternalCommandEntries(): CommandEntry[] {
  return [
    createEnvCommand(["space", "create"], "Create a space", runSpaceCreateCommand),
    createEnvCommand(["space", "invite"], "Invite an existing user to a space", runSpaceInviteCommand),
    createEnvCommand(["space", "accept-invite"], "Accept a space invite", runSpaceAcceptInviteCommand),
  ];
}
