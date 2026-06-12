import type { MachineHeartbeat } from "./connector-experimental/protocol";

type OutputLike = { write(chunk: string): unknown };

export type MachineHeartbeatConnectDeps = {
  output?: OutputLike;
  machine: MachineHeartbeat;
  sendHeartbeat: () => Promise<void>;
};

export async function runMachineHeartbeatConnectCommand(
  deps: MachineHeartbeatConnectDeps
) {
  const output = deps.output ?? process.stdout;
  const machine = deps.machine;

  try {
    await deps.sendHeartbeat();
  } catch (error) {
    output.write(
      `[nolo] Machine connect failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return 1;
  }

  output.write(`Connected machine: ${machine.name} (${machine.platform}/${machine.arch})\n`);
  return 0;
}
