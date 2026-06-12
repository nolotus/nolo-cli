import type { CommandEntry } from "./cliCommandTypes";
import { createEnvCommand } from "./cliCommandFactories";
import { runDocCreateCommand, runSkillDocCreateCommand } from "./docCreateCommands";

export function getDocInternalCommandEntries(): CommandEntry[] {
  return [
    createEnvCommand(["doc", "create"], "Create a normal doc", runDocCreateCommand),
    createEnvCommand(["skill-doc", "create"], "Create a skill-backed doc", runSkillDocCreateCommand),
    createEnvCommand(["skill", "create-doc"], "Create a skill-backed doc", runSkillDocCreateCommand),
  ];
}
