import type { ByokProvider } from "./providerConfig";

export type LocalRuntimeCommand = "run" | "chat" | "desktop";
export type ShellPolicy = "disabled" | "prompted" | "allowed";

export type LocalRuntimeBoundary = {
  command: LocalRuntimeCommand;
  workspace: string;
  provider: ByokProvider;
  requiresNoloAuth: false;
  credentialBoundary: "local-provider";
  shell: {
    policy: ShellPolicy;
    scope: "workspace";
  };
  persistence: {
    localDialog: true;
    remoteSync: false;
  };
};

type CreateLocalRuntimeBoundaryInput = {
  command: LocalRuntimeCommand;
  workspace: string;
  provider: ByokProvider;
  shell: ShellPolicy;
};

export function createLocalRuntimeBoundary(
  input: CreateLocalRuntimeBoundaryInput
): LocalRuntimeBoundary {
  return {
    command: input.command,
    workspace: input.workspace,
    provider: input.provider,
    requiresNoloAuth: false,
    credentialBoundary: "local-provider",
    shell: {
      policy: input.shell,
      scope: "workspace",
    },
    persistence: {
      localDialog: true,
      remoteSync: false,
    },
  };
}

export function summarizeRuntimeBoundary(boundary: LocalRuntimeBoundary) {
  return [
    `${boundary.command} uses ${boundary.provider} locally in ${boundary.workspace} without Nolo auth.`,
    `Shell policy: ${boundary.shell.policy}; shell scope: ${boundary.shell.scope}.`,
    "Local dialogs may be kept locally; remote sync is off for this boundary.",
  ].join(" ");
}
