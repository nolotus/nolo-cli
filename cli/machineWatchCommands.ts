import type { MachineHeartbeat } from "../connector-experimental/protocol";
import type { HeartbeatLoopOptions } from "../connector-experimental/heartbeatLoop";

type EnvLike = Record<string, string | undefined>;
type OutputLike = { write(chunk: string): unknown };

function resolveHeartbeatIntervalMs(env: EnvLike) {
  const raw = Number(env.NOLO_CONNECT_HEARTBEAT_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

export type MachineWatchCommandDeps = {
  env?: EnvLike;
  output?: OutputLike;
  machine: MachineHeartbeat;
  sendHeartbeat: () => Promise<void>;
  runHeartbeatLoop: (options: HeartbeatLoopOptions) => Promise<void>;
};

export async function runMachineWatchCommand(
  deps: MachineWatchCommandDeps
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const machine = deps.machine;
  output.write(`Connecting machine heartbeat loop: ${machine.name} (${machine.platform}/${machine.arch})\n`);
  try {
    await deps.runHeartbeatLoop({
      intervalMs: resolveHeartbeatIntervalMs(env),
      sendHeartbeat: deps.sendHeartbeat,
    });
    return 0;
  } catch (error) {
    output.write(
      `[nolo] Machine heartbeat loop failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return 1;
  }
}
