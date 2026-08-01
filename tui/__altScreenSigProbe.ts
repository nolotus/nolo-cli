/**
 * Subprocess helper for the alternate-screen signal-exit tests.
 * NOT shipped — only spawned by readlineWorkspace.test.ts via Bun.spawn.
 *
 * Behavior is selected by argv:
 *   "install"            — install handlers, then idle; signal should exit.
 *   "install+listener"   — install handlers after attaching a pre-existing
 *                          SIGINT listener that sets a marker; verifies the
 *                          listener runs exactly once.
 *   "throw"              — throw after install so uncaughtException fires;
 *                          must print the error and exit non-zero.
 *
 * The probe prints a ready line on stdout so the parent knows handlers are
 * installed before sending a signal. It deliberately uses a non-TTY output so
 * `leaveAltScreen` is a no-op (we are testing exit semantics, not ANSI bytes).
 */
import { installAltScreenRestoreHandlers } from "./readlineWorkspace";

const mode = process.argv[2] ?? "install";
const output = process.stdout; // non-TTY in the child; leaveAltScreen no-ops

if (mode === "install+listener") {
  // MUST register the pre-existing listener BEFORE install so the handler
  // snapshots it (otherwise install sees no listeners and auto-exits on
  // signal, bypassing the listener entirely).
  let count = 0;
  process.on("SIGINT", () => {
    count += 1;
    process.stderr.write(`listener-runs=${count}\n`);
    process.exit(count);
  });
  // Debug: confirm the listener is visible to process.listeners BEFORE install.
  process.stderr.write(`pre-install-listeners=${process.listeners("SIGINT").length}\n`);
}

installAltScreenRestoreHandlers(output);

// Tell the parent we are ready (handlers installed, idling).
process.stdout.write("ready\n");

if (mode === "throw") {
  // Defer so the parent has time to wire up reading stdout.
  setTimeout(() => {
    throw new Error("probe-boom");
  }, 20);
} else {
  // Idle; the parent will send a real signal. Keep the loop alive.
  setInterval(() => {}, 1000);
}