export type HeartbeatLoopOptions = {
  intervalMs: number;
  sendHeartbeat: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  maxBeats?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runHeartbeatLoop(options: HeartbeatLoopOptions): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  let beats = 0;

  while (!options.signal?.aborted) {
    await options.sendHeartbeat();
    beats += 1;
    if (options.maxBeats && beats >= options.maxBeats) return;
    if (options.signal?.aborted) return;
    await sleep(options.intervalMs);
  }
}
