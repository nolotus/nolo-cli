export interface TerminalBellDecision {
  wasAborted: boolean;
  streamInterrupted?: boolean;
  exitCode: number;
  interactive: boolean;
}

export function shouldEmitTerminalBell(decision: TerminalBellDecision): boolean {
  return (
    !decision.wasAborted &&
    !decision.streamInterrupted &&
    decision.exitCode === 0 &&
    decision.interactive
  );
}

/** Emit a best-effort terminal notification without changing the TUI layout. */
export function emitTerminalBell(output: NodeJS.WritableStream): void {
  try {
    output.write("\x07");
  } catch {
    // A notification must never make a completed turn fail.
  }
}
