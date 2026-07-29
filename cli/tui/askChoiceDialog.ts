/**
 * TUI renderer for the isomorphic `ui_ask_choice` state machine.
 *
 * Renders a multi-tab question panel with single/multi-select, an "Other"
 * free-text row, and a Submit action — matching the Web AskChoicePanel.
 *
 * Keyboard map:
 *   ↑/↓        move cursor
 *   Space      toggle (multi-select) / focus Other
 *   Enter      select (single) / toggle (multi) / save Other / submit
 *   Tab        next question tab
 *   Shift+Tab  prev question tab
 *   Esc        cancel
 *   printable  type into Other when focused
 *   Backspace  delete from Other when focused
 */

import {
  type AskChoiceAction,
  type AskChoiceQuestion,
  type AskChoiceUiState,
  type QuestionUiState,
  askChoiceReducer,
  buildAskChoiceResult,
  canSubmit,
  createInitialAskChoiceState,
  normalizeAskChoiceArgs,
} from "../../ai/tools/askChoiceState";
import {
  DIALOG_CHECKED,
  DIALOG_CURSOR,
  DIALOG_UNCHECKED,
  renderDialogRow,
  renderDialogTitle,
} from "./dialogFrame";
import {
  clearAnchoredLines,
  computeVisibleWindow,
  createRawKeyReader,
  drainInputBuffer,
  isArrowDown,
  isArrowUp,
  isCancel,
  isSubmit,
  outputIsTty,
  type KeyReader,
} from "./selectDialog";
import { resolveCliColorEnabled } from "../client/terminalStyles";
import { themeColorSequence, themeText } from "./theme";
import type { UserChoiceRequest, UserChoiceResult } from "../client/localRuntimeAdapterTypes";

// ── Rendering ──────────────────────────────────────────────────────

const CSI_TAB = "\t";
const CSI_SHIFT_TAB = "\x1b[Z";
const CSI_BACKSPACE = "\x7f";
const CSI_BACKSPACE_ALT = "\b";
const CSI_SPACE = " ";

function renderTabBar(
  questions: AskChoiceQuestion[],
  activeIndex: number,
  colorEnabled: boolean,
): string {
  const tabs = questions.map((q, i) => {
    const label = `Q${i + 1}`;
    if (i === activeIndex) {
      return colorEnabled
        ? `${themeColorSequence("accent")}\x1b[1m ${label} \x1b[0m`
        : `[${label}]`;
    }
    return colorEnabled
      ? themeText(` ${label} `, "muted", colorEnabled)
      : ` ${label} `;
  });
  const submitLabel = "Submit";
  return tabs.join("  ") + "  " + (colorEnabled ? themeText(submitLabel, "chrome", colorEnabled) : submitLabel);
}

function renderFooter(colorEnabled: boolean): string {
  const hints = "type answer  ↵save  tab switch  s submit  esc cancel";
  return colorEnabled ? themeText(`  ${hints}`, "chrome", colorEnabled) : `  ${hints}`;
}

export function renderAskChoiceFrame(state: AskChoiceUiState): string {
  const colorEnabled = resolveCliColorEnabled();
  const q = state.questions[state.activeIndex];
  const qs = state.questionStates[state.activeIndex];
  const lines: string[] = [];

  // Title
  lines.push(renderDialogTitle("question"));
  lines.push("");

  // Tab bar (only when multiple questions)
  if (state.questions.length > 1) {
    lines.push(renderTabBar(state.questions, state.activeIndex, colorEnabled));
    lines.push("");
  }

  // Question text
  lines.push(
    colorEnabled
      ? `${themeColorSequence("accent")}? ${q.question}\x1b[0m`
      : `? ${q.question}`,
  );

  if (q.multiSelect) {
    lines.push(
      colorEnabled
        ? themeText("  Space to toggle, Enter to confirm selection.", "muted", colorEnabled)
        : "  Space to toggle, Enter to confirm selection.",
    );
  } else {
    lines.push(
      colorEnabled
        ? themeText("  Type your answer, then press Enter to save.", "muted", colorEnabled)
        : "  Type your answer, then press Enter to save.",
    );
  }
  lines.push("");

  // Choice rows
  const totalRows = q.choices.length + (q.allowOther ? 1 : 0);
  const window = computeVisibleWindow({
    selectedIndex: qs.cursorIndex,
    total: totalRows,
  });

  if (window.start > 0) {
    lines.push(
      colorEnabled
        ? themeText(`  ↑ ${window.start} more`, "chrome", colorEnabled)
        : `  ↑ ${window.start} more`,
    );
  }

  for (let i = window.start; i < window.end; i++) {
    if (i < q.choices.length) {
      const choice = q.choices[i];
      const focused = qs.cursorIndex === i;
      const checkbox = q.multiSelect
        ? qs.selectedIds.includes(choice.id)
          ? DIALOG_CHECKED
          : DIALOG_UNCHECKED
        : qs.pickedId === choice.id
          ? DIALOG_CHECKED
          : undefined;
      lines.push(
        renderDialogRow({
          label: `[${i + 1}] ${choice.label}`,
          ...(choice.detail ? { detail: choice.detail } : {}),
          focused,
          ...(checkbox ? { checkbox } : {}),
        }),
      );
    } else {
      // Other row
      const focused = qs.cursorIndex === i;
      const marker = focused ? DIALOG_CURSOR : " ";
      const otherContent = qs.otherFocused
        ? `${qs.otherText}█`
        : qs.otherText || "";
      const row = `${marker} [${i + 1}] Other: ${otherContent}`;
      if (focused && colorEnabled) {
        lines.push(
          `\x1b[1m${themeColorSequence("accent")}${row}\x1b[0m`,
        );
      } else {
        lines.push(row);
      }
    }
  }

  if (window.end < totalRows) {
    lines.push(
      colorEnabled
        ? themeText(`  ↓ ${totalRows - window.end} more`, "chrome", colorEnabled)
        : `  ↓ ${totalRows - window.end} more`,
    );
  }

  lines.push("");
  lines.push(renderFooter(colorEnabled));

  return lines.join("\n");
}

// ── Runner ─────────────────────────────────────────────────────────

export async function runAskChoiceDialog(args: {
  request: UserChoiceRequest;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WritableStream;
  readKey?: KeyReader;
  bottomAnchored?: boolean;
  bottomRow?: number | (() => number);
}): Promise<UserChoiceResult> {
  const { request } = args;

  // Normalize to questions[]
  const normalized = normalizeAskChoiceArgs({
    question: request.question,
    choices: request.choices,
    questions: request.questions,
    blocking: request.blocking,
  });

  if (normalized.questions.length === 0) {
    return { kind: "cancelled" };
  }

  // Fast path: single question, single select, no multi → use simple select dialog
  // for backward compat (no tab bar, no Other complexity)
  const q0 = normalized.questions[0];
  if (
    normalized.questions.length === 1 &&
    !q0.multiSelect &&
    !q0.allowOther
  ) {
    // Delegate to simple select — but we still need to import runSelectDialog
    // For now, fall through to the full dialog which handles this fine.
  }

  let state = createInitialAskChoiceState(normalized.questions);

  const output = args.output ?? process.stdout;
  const input = args.input ?? process.stdin;
  const readKey = args.readKey ?? createRawKeyReader(input);

  const wasRaw = Boolean(input.isTTY && input.isRaw);
  let renderedLineCount = 0;
  const bottomAnchored = Boolean(args.bottomAnchored && args.bottomRow);
  const resolveBottomRow = () =>
    Math.max(
      1,
      typeof args.bottomRow === "function"
        ? args.bottomRow()
        : args.bottomRow ?? 0,
    );
  let lastBottomRow = 0;

  const paint = () => {
    const frame = renderAskChoiceFrame(state);
    const lines = frame.split("\n");
    const lineCount = lines.length;
    const canPosition = outputIsTty(output) && typeof output.write === "function";

    if (bottomAnchored && canPosition) {
      const anchorRow = resolveBottomRow();
      clearAnchoredLines(
        output,
        lastBottomRow > 0 ? lastBottomRow : anchorRow,
        renderedLineCount,
      );
      for (let i = 0; i < lines.length; i++) {
        const row = anchorRow - (lines.length - 1 - i);
        if (row < 1) break;
        output.write(`\x1b[${row};1H\x1b[2K${lines[i]}`);
      }
      lastBottomRow = anchorRow;
      renderedLineCount = lineCount;
      return;
    }

    if (canPosition) {
      // Clear previous
      for (let i = 0; i < renderedLineCount; i++) {
        output.write("\x1b[1A\x1b[2K");
      }
      output.write(`${frame}\n`);
      renderedLineCount = lineCount;
      return;
    }

    if (typeof output.write === "function") {
      output.write(`${frame}\n`);
    }
    renderedLineCount = lineCount;
  };

  const resizeTarget = output as NodeJS.WritableStream & {
    on?: (event: string, listener: () => void) => void;
    off?: (event: string, listener: () => void) => void;
  };
  const onOutputResize = () => paint();

  if (input.isTTY && !wasRaw) {
    input.setRawMode?.(true);
  }
  if (bottomAnchored && outputIsTty(output)) {
    resizeTarget.on?.("resize", onOutputResize);
  }
  paint();

  try {
    while (state.phase === "active") {
      const sequence = await readKey();
      if (sequence == null) {
        state = askChoiceReducer(state, { type: "CANCEL" });
        break;
      }

      let action: AskChoiceAction | null = null;

      if (isCancel(sequence)) {
        action = { type: "CANCEL" };
      } else if (sequence === CSI_TAB) {
        action = { type: "NEXT_TAB" };
      } else if (sequence === CSI_SHIFT_TAB) {
        action = { type: "PREV_TAB" };
      } else if (isArrowUp(sequence)) {
        action = { type: "MOVE_CURSOR", delta: -1 };
      } else if (isArrowDown(sequence)) {
        action = { type: "MOVE_CURSOR", delta: 1 };
      } else if (sequence === CSI_SPACE) {
        action = { type: "TOGGLE_AT_CURSOR" };
      } else if (
        sequence === "s" &&
        !state.questionStates[state.activeIndex].otherFocused &&
        canSubmit(state)
      ) {
        // 's' key = submit (when Other not focused and form is valid)
        action = { type: "SUBMIT" };
      } else if (isSubmit(sequence)) {
        const qs = state.questionStates[state.activeIndex];
        const q = state.questions[state.activeIndex];
        const isOtherRow = qs.cursorIndex >= q.choices.length;

        if (qs.otherFocused) {
          // Enter in Other input → blur (save text)
          action = { type: "BLUR_OTHER" };
        } else if (isOtherRow && !qs.otherFocused) {
          // Enter on Other row → focus it
          action = { type: "FOCUS_OTHER" };
        } else {
          // Enter on a choice row
          action = { type: "SELECT_AT_CURSOR" };
        }
      } else if (
        sequence === CSI_BACKSPACE ||
        sequence === CSI_BACKSPACE_ALT
      ) {
        const qs = state.questionStates[state.activeIndex];
        if (qs.otherFocused && qs.otherText.length > 0) {
          action = {
            type: "SET_OTHER_TEXT",
            text: qs.otherText.slice(0, -1),
          };
        }
      } else if (sequence.length === 1 && sequence.charCodeAt(0) >= 32) {
        // Printable character → type into Other if focused
        const qs = state.questionStates[state.activeIndex];
        if (qs.otherFocused) {
          action = {
            type: "SET_OTHER_TEXT",
            text: qs.otherText + sequence,
          };
        }
      }

      if (action) {
        const prev = state;
        state = askChoiceReducer(state, action);

        // After SELECT_AT_CURSOR in single-question single-select,
        // the reducer auto-submits. Check phase.
        if (state.phase !== "active") break;

        // If we just blurred Other and this is single-question,
        // check if we can submit
        if (
          action.type === "BLUR_OTHER" &&
          state.questions.length === 1 &&
          canSubmit(state)
        ) {
          state = askChoiceReducer(state, { type: "SUBMIT" });
          break;
        }

        paint();
      }
    }
  } finally {
    resizeTarget.off?.("resize", onOutputResize);
    readKey.dispose?.();
    if (input.isTTY) {
      drainInputBuffer(input);
      if (!wasRaw) input.setRawMode?.(false);
      if (bottomAnchored) {
        clearAnchoredLines(
          output,
          lastBottomRow > 0 ? lastBottomRow : resolveBottomRow(),
          renderedLineCount,
        );
      } else {
        for (let i = 0; i < renderedLineCount; i++) {
          output.write("\x1b[1A\x1b[2K");
        }
      }
      renderedLineCount = 0;
    }
  }

  // Build result
  const result = buildAskChoiceResult(state);
  if (result.kind === "cancelled") {
    return { kind: "cancelled" };
  }

  // Single-question backward compat
  if (result.answers.length === 1) {
    const a = result.answers[0];
    return {
      kind: "selected",
      userMessage: a.userMessage,
      label: a.selectedIds
        .map((id) => {
          const q = normalized.questions[0];
          return q.choices.find((c) => c.id === id)?.label ?? "";
        })
        .join(", ") || a.otherText || "",
    };
  }

  // Multi-question
  return {
    kind: "multi-submitted",
    answers: result.answers,
    userMessage: result.answers.map((a) => a.userMessage).filter(Boolean).join("\n\n"),
  };
}
