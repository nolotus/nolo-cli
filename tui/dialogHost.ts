/**
 * Single entry point for every modal the TUI puts on screen: the agent picker,
 * the history/context picker, and the destructive-action confirm prompt.
 *
 * Each of those used to open its dialog by hand, and the hand-rolled versions
 * drifted apart — the two pickers docked their frame above the composer while
 * the confirm prompt did not, so a confirm opened mid-turn was painted into the
 * scroll region and wiped by the next streaming repaint. The user saw nothing
 * and the turn appeared to hang while the dialog silently held the keyboard.
 *
 * Routing all three through `run()` keeps the anchor math, the composer pause,
 * and the repaint suppression in one place, so a new dialog cannot reintroduce
 * that class of bug by forgetting one of the three.
 */

/** The slice of the composer controller a dialog needs to take over the screen. */
export type DialogHostComposer = {
  pause(): void;
  resumeFromDialog(): void;
  getInputLines(): number;
  isPaused(): boolean;
};

/**
 * Where a dialog frame should be drawn. Pass straight through to
 * `runSelectDialog` / `runMultiSelectDialog` / `runConfirmDialog`.
 */
export type DialogAnchor = {
  bottomAnchored: true;
  /**
   * Lazily resolved 1-indexed absolute row the last line of the frame sits
   * on. A function (not a snapshot) so the dialog re-anchors above the
   * composer on every paint — a terminal resize changes `output.rows` while
   * the dialog is open, and a captured number would leave the frame frozen
   * at the pre-resize rows.
   */
  bottomRow: () => number;
};

export type DialogHost = {
  run<T>(body: (anchor: DialogAnchor) => Promise<T>): Promise<T>;
};

const DEFAULT_TTY_ROWS = 24;

function resolveTtyRows(output: unknown): number {
  if (
    typeof output === "object" &&
    output !== null &&
    "rows" in output &&
    typeof (output as { rows?: unknown }).rows === "number"
  ) {
    return (output as { rows: number }).rows;
  }
  return DEFAULT_TTY_ROWS;
}

/**
 * Compute the row the dialog's last line should occupy so the frame stacks
 * upward from just above the docked composer.
 */
export function resolveDialogBottomRow(args: {
  output: unknown;
  inputLines: number;
}): number {
  return Math.max(1, resolveTtyRows(args.output) - args.inputLines);
}

export function createDialogHost(args: {
  composer: DialogHostComposer;
  output: NodeJS.WritableStream;
}): DialogHost {
  return {
    async run(body) {
      const anchor: DialogAnchor = {
        bottomAnchored: true,
        bottomRow: () =>
          resolveDialogBottomRow({
            output: args.output,
            inputLines: args.composer.getInputLines(),
          }),
      };
      // pause() flips isPaused(), which is what suppresses the transcript
      // repaint while the dialog owns the screen. Without it a dialog opened
      // during a streaming turn is erased by the next token.
      args.composer.pause();
      try {
        return await body(anchor);
      } finally {
        args.composer.resumeFromDialog();
      }
    },
  };
}
