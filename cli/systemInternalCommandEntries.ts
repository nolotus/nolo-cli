import {
  createArgsCommand,
  createContextCommand,
  createDaemonShortcutCommand,
  createEntrypointEnvCommand,
  createEnvCommand,
} from "./cliCommandFactories";
import type { CommandEntry } from "./cliCommandTypes";

export function getSystemInternalCommandEntries(renderHelpText: () => string): CommandEntry[] {
  return [
    createArgsCommand(["auth", "chatgpt"], "Authorize ChatGPT / OpenAI Codex OAuth", async (args) => {
      const { runAuthChatgptCommand } = await import("./oauth/authCommand");
      return runAuthChatgptCommand(args);
    }),
    createArgsCommand(["auth", "xai"], "Authorize xAI Grok OAuth (SuperGrok subscription)", async (args) => {
      const { runAuthXaiCommand } = await import("./oauth/authCommand");
      return runAuthXaiCommand(args);
    }),
    createArgsCommand(["auth", "antigravity"], "Authorize Google Antigravity OAuth", async (args) => {
      const { runAuthAntigravityCommand } = await import("./oauth/authCommand");
      return runAuthAntigravityCommand(args);
    }),
    createArgsCommand(["login"], "Log in to Nolo", async (args) => {
      const { runLoginCommand } = await import("./authCommands");
      return runLoginCommand(args);
    }),
    createContextCommand(["logout"], "Log out of Nolo", async (args, ctx) => {
      const { runLogoutCommand } = await import("./authCommands");
      return runLogoutCommand({ args, env: ctx.env });
    }),
    createContextCommand(["whoami"], "Show the current login state", async (args, ctx) => {
      const { runWhoamiCommand } = await import("./authCommands");
      return runWhoamiCommand({ args, env: ctx.env });
    }),
    createEntrypointEnvCommand(["connect"], "Send machine heartbeats or hold a connector websocket", async (args, deps) => {
      const { runMachineConnectCommand } = await import("./machineCommands");
      return runMachineConnectCommand(args, deps);
    }),
    createDaemonShortcutCommand(["daemon"], "Run the connector daemon shortcut", async (args, deps) => {
      const { runMachineConnectCommand } = await import("./machineCommands");
      return runMachineConnectCommand(args, deps);
    }),
    createEnvCommand(["machine", "status"], "List machines registered to the current profile", async (args, deps) => {
      const { runMachineStatusCommand } = await import("./machineCommands");
      return runMachineStatusCommand(args, deps);
    }),
    createEnvCommand(["doctor", "runtime"], "Diagnose local-first agent runtime selection", async (args, deps) => {
      const { runDoctorRuntimeCommand } = await import("./runtimeDoctorCommands");
      return runDoctorRuntimeCommand(args, deps);
    }),
    createContextCommand(["doctor"], "Show CLI doctor information", async (_args, ctx) => {
      const { buildCliDoctorText, getCliInstallChannel, resolveSelfUpdateServerUrl } = await import("./updateCommands");
      const serverUrl = resolveSelfUpdateServerUrl(ctx.env);
      console.log(
        buildCliDoctorText({
          packageName: ctx.packageInfo.name,
          version: ctx.packageInfo.version,
          entrypoint: ctx.entrypointPath,
          serverUrl,
          profileName: ctx.env.NOLO_PROFILE || "local",
          installKind: "npm-global",
          updateChannel: getCliInstallChannel(serverUrl),
        })
      );
      return 0;
    }),
    createContextCommand(["update"], "Update the CLI", async (_args, ctx) => {
      const { resolveSelfUpdateServerUrl, runSelfUpdate } = await import("./updateCommands");
      return runSelfUpdate({
        entrypointPath: ctx.entrypointPath,
        serverUrl: resolveSelfUpdateServerUrl(ctx.env),
        env: ctx.env,
      });
    }),
    createContextCommand(["version"], "Show CLI version", async (_args, ctx) => {
      const { buildCliVersionText } = await import("./updateCommands");
      console.log(buildCliVersionText(ctx.packageInfo));
      return 0;
    }),
    createContextCommand(["--version"], "Show CLI version", async (_args, ctx) => {
      const { buildCliVersionText } = await import("./updateCommands");
      console.log(buildCliVersionText(ctx.packageInfo));
      return 0;
    }),
    createContextCommand(["-v"], "Show CLI version", async (_args, ctx) => {
      const { buildCliVersionText } = await import("./updateCommands");
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
