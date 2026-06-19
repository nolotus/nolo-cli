import { runLoginCommand, runLogoutCommand, runWhoamiCommand } from "./authCommands";
import {
  createArgsCommand,
  createContextCommand,
  createDaemonShortcutCommand,
  createEntrypointEnvCommand,
  createEnvCommand,
} from "./cliCommandFactories";
import type { CommandEntry } from "./cliCommandTypes";
import {
  runMachineConnectCommand,
  runMachineStatusCommand,
} from "./machineCommands";
import { runDoctorRuntimeCommand } from "./runtimeDoctorCommands";
import { detectStandaloneBundleInstall, getCliInstallChannel } from "./standaloneBundle";
import {
  buildCliDoctorText,
  buildCliVersionText,
  resolveSelfUpdateServerUrl,
  runSelfUpdate,
} from "./updateCommands";

export function getSystemInternalCommandEntries(renderHelpText: () => string): CommandEntry[] {
  return [
    createEnvCommand(["doctor", "runtime"], "Diagnose local-first agent runtime selection", runDoctorRuntimeCommand),
    createArgsCommand(["login"], "Log in to Nolo", (args) => Promise.resolve(runLoginCommand(args))),
    createContextCommand(["logout"], "Log out of Nolo", async (args, ctx) =>
      runLogoutCommand({ args, env: ctx.env })
    ),
    createContextCommand(["whoami"], "Show the current login state", async (args, ctx) =>
      runWhoamiCommand({ args, env: ctx.env })
    ),
    createEntrypointEnvCommand(["connect"], "Send machine heartbeats or hold a connector websocket", runMachineConnectCommand),
    createDaemonShortcutCommand(["daemon"], "Run the connector daemon shortcut", runMachineConnectCommand),
    createEnvCommand(["machine", "status"], "List machines registered to the current profile", runMachineStatusCommand),
    createContextCommand(["doctor"], "Show CLI doctor information", async (_args, ctx) => {
      const serverUrl = resolveSelfUpdateServerUrl(ctx.env);
      console.log(
        buildCliDoctorText({
          packageName: ctx.packageInfo.name,
          version: ctx.packageInfo.version,
          entrypoint: ctx.entrypointPath,
          serverUrl,
          profileName: ctx.env.NOLO_PROFILE || "local",
          installKind: detectStandaloneBundleInstall(ctx.entrypointPath)
            ? "standalone-bundle"
            : "npm-global",
          updateChannel: getCliInstallChannel(serverUrl),
        })
      );
      return 0;
    }),
    createContextCommand(["update"], "Update the CLI", async (_args, ctx) =>
      runSelfUpdate({
        entrypointPath: ctx.entrypointPath,
        serverUrl: resolveSelfUpdateServerUrl(ctx.env),
        env: ctx.env,
      })
    ),
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
