import type { CommandEntry } from "./cliCommandTypes";
import { createEnvCommand } from "./cliCommandFactories";

export function getDocInternalCommandEntries(): CommandEntry[] {
  return [
    createEnvCommand(["doc", "create"], "Create a normal doc", async (args, deps) => {
      const { runDocCreateCommand } = await import("./docCreateCommands");
      return runDocCreateCommand(args, deps);
    }),
    createEnvCommand(["doc", "read"], "Read a normal doc", async (args, deps) => {
      const { runDocReadCommand } = await import("./docReadCommands");
      return runDocReadCommand(args, deps);
    }),
    createEnvCommand(["doc", "update"], "Update a normal doc", async (args, deps) => {
      const { runDocUpdateCommand } = await import("./docUpdateCommands");
      return runDocUpdateCommand(args, deps);
    }),
    createEnvCommand(["doc", "delete"], "Delete a normal doc", async (args, deps) => {
      const { runDocDeleteCommand } = await import("./docDeleteCommands");
      return runDocDeleteCommand(args, deps);
    }),
    createEnvCommand(["skill-doc", "create"], "Create a skill-backed doc", async (args, deps) => {
      const { runSkillDocCreateCommand } = await import("./docCreateCommands");
      return runSkillDocCreateCommand(args, deps);
    }),
    createEnvCommand(["skill", "create-doc"], "Create a skill-backed doc", async (args, deps) => {
      const { runSkillDocCreateCommand } = await import("./docCreateCommands");
      return runSkillDocCreateCommand(args, deps);
    }),
    createEnvCommand(["skill-doc", "read"], "Read a skill doc", async (args, deps) => {
      const { runSkillDocReadCommand } = await import("./docReadCommands");
      return runSkillDocReadCommand(args, deps);
    }),
    createEnvCommand(["skill-doc", "update"], "Update a skill doc", async (args, deps) => {
      const { runSkillDocUpdateCommand } = await import("./docUpdateCommands");
      return runSkillDocUpdateCommand(args, deps);
    }),
    createEnvCommand(["skill-doc", "delete"], "Delete a skill doc", async (args, deps) => {
      const { runSkillDocDeleteCommand } = await import("./docDeleteCommands");
      return runSkillDocDeleteCommand(args, deps);
    }),
  ];
}
