export type RegisteredProcess = {
  pid: number;
  pgid: number;
  command: string;
  label: string;
  startedAt: number;
  status: "running" | "stopped" | "exited" | "failed";
  exitCode?: number;
};

export class ProcessRegistry {
  private processes = new Map<number, RegisteredProcess>();

  add(proc: { pid: number; pgid: number; command: string; label: string }): void {
    this.processes.set(proc.pid, {
      pid: proc.pid,
      pgid: proc.pgid,
      command: proc.command,
      label: proc.label,
      startedAt: Date.now(),
      status: "running",
    });
  }

  list(): RegisteredProcess[] {
    return Array.from(this.processes.values()).map((proc) => ({ ...proc }));
  }

  get(pid: number): RegisteredProcess | undefined {
    const item = this.processes.get(pid);
    return item ? { ...item } : undefined;
  }

  kill(pid: number, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): boolean {
    const item = this.processes.get(pid);
    if (!item) return false;

    if (item.status === "running") {
      try {
        process.kill(-item.pgid, signal);
      } catch {
        // ESRCH or unkillable - process might already be dead
      }
      item.status = "stopped";
      return true;
    }
    return false;
  }

  stopAll(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
    for (const item of this.processes.values()) {
      if (item.status === "running") {
        try {
          process.kill(-item.pgid, signal);
        } catch {
          // ESRCH guard
        }
        item.status = "stopped";
      }
    }
  }

  markExited(pid: number, exitCode: number): void {
    const item = this.processes.get(pid);
    if (item && item.status === "running") {
      // Only record natural exit while still running. If the user already
      // killed the process (status "stopped"), a late close event must not
      // overwrite that — "stopped" means "user-initiated", which is distinct
      // from a natural "exited"/"failed" and /procs relies on the difference.
      item.exitCode = exitCode;
      item.status = exitCode === 0 ? "exited" : "failed";
    }
  }

  clear(): void {
    this.processes.clear();
  }
}

let registry: ProcessRegistry | null = null;

export function getProcessRegistry(): ProcessRegistry {
  if (!registry) {
    registry = new ProcessRegistry();
  }
  return registry;
}
