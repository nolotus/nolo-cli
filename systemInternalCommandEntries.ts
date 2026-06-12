import { runLoginCommand, runLogoutCommand, runWhoamiCommand } from "./authCommands";
import {
  createArgsCommand,
  createContextCommand,
  createDaemonShortcutCommand,
  createEntrypointEnvCommand,
  createEnvCommand,
} from "./cliCommandFactories";
import type { CommandEntry } from "./cliCommandTypes";
import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";
import {
  runMachineConnectCommand,
  runMachineStatusCommand,
} from "./machineCommands";
import { runDoctorRuntimeCommand } from "./runtimeDoctorCommands";
import {
  buildCliDoctorText,
  buildCliVersionText,
  runSelfUpdate,
} from "./updateCommands";

export function getSystemInternalCommandEntries(renderHelpText: () => string): CommandEntry[] {
  return [
    createEnvCommand(["doctor", "runtime"], "Diagnose local-first agent runtime selection", runDoctorRuntimeCommand),
    createArgsCommand(["login"], "Log in to Nolo", (args) => Promise.resolve(runLoginCommand(args))),
    createArgsCommand(["logout"], "Log out of Nolo", async () => runLogoutCommand()),
    createArgsCommand(["whoami"], "Show the current login state", async () => runWhoamiCommand()),
    createEntrypointEnvCommand(["connect"], "Send machine heartbeats or hold a connector websocket", runMachineConnectCommand),
    createDaemonShortcutCommand(["daemon"], "Run the connector daemon shortcut", runMachineConnectCommand),
    createEnvCommand(["machine", "status"], "List machines registered to the current profile", runMachineStatusCommand),
    createContextCommand(["doctor"], "Show CLI doctor information", async (_args, ctx) => {
      console.log(
        buildCliDoctorText({
          packageName: ctx.packageInfo.name,
          version: ctx.packageInfo.version,
          entrypoint: ctx.entrypointPath,
          serverUrl: ctx.env.NOLO_SERVER || ctx.env.BASE_URL || DEFAULT_NOLO_SERVER_URL,
          profileName: ctx.env.NOLO_PROFILE || "local",
        })
      );
      return 0;
    }),
    createArgsCommand(["update"], "Update the CLI", async () => runSelfUpdate()),
    createContextCommand(["version"], "Show CLI version", async (_args, ctx) => {
      console.log(buildCliVersionText(ctx.packageInfo));
      return 0;
    }),
    createContextCommand(["--version"], "Show CLI version", async (_args, ctx) => {
      console.log(buildCliVersionText(ctx.packageInfo));
      return 0;
    }),
    createContextCommand(["-v"], "Show CLI version", async (_args, ctx) => {
      console.log(buildCliVersionText(ctx.packageInfo));
      return 0;
    }),
    createArgsCommand(["--help"], "Show help", async () => {
      console.log(renderHelpText());
      return 0;
    }),
    createArgsCommand(["-h"], "Show help", async () => {
      console.log(renderHelpText());
      return 0;
    }),
  ];
}
