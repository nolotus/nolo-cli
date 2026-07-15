import { toErrorMessage } from "../core/errorMessage";
import { normalizeServerOrigin } from "../core/serverOrigin";
import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";
import type { CliFetchImpl } from "./cliFetch";

type EnvLike = Record<string, string | undefined>;
type OutputLike = { write(chunk: string): unknown };

export type MachineSummary = {
  machineId: string;
  name: string;
  platform: string;
  arch: string;
  connectorVersion: string | null;
  capabilities: string[];
  connectorStatus?: "connected" | "disconnected";
  status: "online" | "offline";
  lastSeenAt: number;
};

export type MachineStatusCommandDeps = {
  env?: EnvLike;
  output?: OutputLike;
  fetchImpl?: CliFetchImpl;
};

function resolveServerUrl(env: EnvLike) {
  return normalizeServerOrigin(
    env.NOLO_SERVER || env.BASE_URL || DEFAULT_NOLO_SERVER_URL,
  );
}

function resolveAuthToken(env: EnvLike) {
  return env.AUTH_TOKEN || env.AUTH || "";
}

function writeAuthMissing(output: OutputLike) {
  output.write(
    "[nolo] Machine commands require an auth token. Run `nolo login` or set AUTH_TOKEN.\n"
  );
}

export function formatMachineStatus(machines: MachineSummary[]) {
  if (machines.length === 0) {
    return "No connected machines.\nRun `nolo connect` on this computer to register it once.\n";
  }

  return [
    "Connected machines:",
    ...machines.map((machine) => {
      const caps = machine.capabilities.length ? machine.capabilities.join(", ") : "no capabilities";
      const connector = machine.connectorStatus ? `  ws:${machine.connectorStatus}` : "";
      return `- ${machine.name}  ${machine.status}${connector}  ${machine.platform}/${machine.arch}  ${caps}`;
    }),
    "",
  ].join("\n");
}

export async function runMachineStatusCommand(
  _args: string[],
  deps: MachineStatusCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const authToken = resolveAuthToken(env);
  if (!authToken) {
    writeAuthMissing(output);
    return 1;
  }

  const serverUrl = resolveServerUrl(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${serverUrl}/api/machines`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });
  } catch (error) {
    output.write(
      `[nolo] Machine status failed: ${toErrorMessage(error)}\n`
    );
    return 1;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    output.write(`[nolo] Machine status failed: HTTP ${res.status}\n${text}\n`);
    return 1;
  }

  const data = await res.json().catch(() => ({ machines: [] }));
  const machines = Array.isArray(data?.machines) ? data.machines : [];
  output.write(formatMachineStatus(machines));
  return 0;
}
