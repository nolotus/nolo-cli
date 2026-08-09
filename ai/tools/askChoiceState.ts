/**
 * Isomorphic state machine for `ask_user` interactive panels.
 *
 * Shared by TUI (packages/cli/tui/askChoiceDialog.ts) and Web
 * (packages/chat/messages/rn/AskChoicePanel.tsx) so that keyboard /
 * click events produce identical state transitions on both platforms.
 *
 * Zero runtime dependencies — pure TypeScript.
 */

// ── Schema types (what the LLM sends) ──────────────────────────────

export type AskChoiceOption = {
  id: string;
  label: string;
  /** Optional longer description shown below the label. */
  detail?: string;
  /**
   * Natural-language message sent as the next user turn when this
   * option is chosen. Falls back to `label` when omitted.
   */
  userMessage?: string;
};

export type AskChoiceQuestion = {
  id: string;
  question: string;
  choices: AskChoiceOption[];
  /** Allow selecting multiple choices. Default false. */
  multiSelect: boolean;
  /** Show an "Other" free-text input row. Default true. */
  allowOther: boolean;
  /** At least one selection required before submit. Default true. */
  required: boolean;
};

// ── UI state (what the renderer tracks) ────────────────────────────

export type QuestionUiState = {
  /** 0..choices.length-1 = choice rows; choices.length = "Other" row (when allowOther). */
  cursorIndex: number;
  /** Selected choice ids (multi-select). */
  selectedIds: string[];
  /** Single-select picked id (null = none yet). */
  pickedId: string | null;
  /** Free-text typed in the "Other" row. */
  otherText: string;
  /** Whether the Other row's text input is focused. */
  otherFocused: boolean;
};

export type AskChoicePhase = "active" | "submitted" | "cancelled";

export type AskChoiceUiState = {
  questions: AskChoiceQuestion[];
  /** Index of the currently visible question tab. */
  activeIndex: number;
  questionStates: QuestionUiState[];
  phase: AskChoicePhase;
};

// ── Result (what gets sent back to the LLM) ────────────────────────

export type QuestionAnswer = {
  questionId: string;
  /** Selected choice ids (empty if only Other was used). */
  selectedIds: string[];
  /** Free-text from Other (empty string if not used). */
  otherText: string;
  /** Combined userMessage for this question. */
  userMessage: string;
};

export type AskChoiceResult =
  | { kind: "submitted"; answers: QuestionAnswer[] }
  | { kind: "cancelled" };

// ── Actions ────────────────────────────────────────────────────────

export type AskChoiceAction =
  | { type: "MOVE_CURSOR"; delta: number }
  | { type: "TOGGLE_AT_CURSOR" }
  | { type: "SELECT_AT_CURSOR" }
  | { type: "FOCUS_OTHER" }
  | { type: "BLUR_OTHER" }
  | { type: "SET_OTHER_TEXT"; text: string }
  | { type: "SWITCH_TAB"; index: number }
  | { type: "NEXT_TAB" }
  | { type: "PREV_TAB" }
  | { type: "SUBMIT" }
  | { type: "CANCEL" }
  | { type: "HYDRATE_QUESTIONS"; questions: AskChoiceQuestion[] };

// ── Normalize legacy args → questions[] ────────────────────────────

/**
 * Accept both the legacy single-question format and the new
 * multi-question format, returning a normalized `AskChoiceQuestion[]`.
 */
export function normalizeAskChoiceArgs(args: {
  question?: string;
  choices?: unknown[];
  questions?: unknown[];
  blocking?: boolean;
}): { questions: AskChoiceQuestion[]; blocking: boolean } {
  const blocking = args.blocking !== false;

  // New format: explicit questions array
  if (Array.isArray(args.questions) && args.questions.length > 0) {
    return {
      questions: args.questions.map((q: any, i: number) =>
        normalizeQuestion(q, i),
      ),
      blocking,
    };
  }

  // Legacy format: single question + choices
  const question = String(args.question ?? "").trim();
  const choices = Array.isArray(args.choices) ? args.choices : [];
  if (!question || choices.length === 0) {
    return { questions: [], blocking };
  }

  return {
    questions: [
      normalizeQuestion(
        { question, choices, multiSelect: false, allowOther: true, required: true },
        0,
      ),
    ],
    blocking,
  };
}

function normalizeQuestion(raw: any, index: number): AskChoiceQuestion {
  return {
    id: String(raw?.id ?? `q${index}`),
    question: String(raw?.question ?? "").trim(),
    choices: (Array.isArray(raw?.choices) ? raw.choices : []).map(
      (c: any, ci: number) => ({
        id: String(c?.id ?? `c${ci}`),
        label: String(c?.label ?? "").trim(),
        ...(typeof c?.detail === "string" && c.detail.trim()
          ? { detail: c.detail.trim() }
          : {}),
        ...(typeof c?.userMessage === "string" && c.userMessage.trim()
          ? { userMessage: c.userMessage.trim() }
          : {}),
      }),
    ),
    multiSelect: raw?.multiSelect === true,
    allowOther: raw?.allowOther !== false,
    required: raw?.required !== false,
  };
}

// ── Initial state ──────────────────────────────────────────────────

export function createInitialAskChoiceState(
  questions: AskChoiceQuestion[],
): AskChoiceUiState {
  return {
    questions,
    activeIndex: 0,
    questionStates: questions.map(() => ({
      cursorIndex: 0,
      selectedIds: [],
      pickedId: null,
      otherText: "",
      otherFocused: false,
    })),
    phase: "active",
  };
}

// ── Reducer ────────────────────────────────────────────────────────

export function askChoiceReducer(
  state: AskChoiceUiState,
  action: AskChoiceAction,
): AskChoiceUiState {
  // HYDRATE_QUESTIONS reconciles questionStates when the questions array grows
  // after mount (useReducer lazy init only runs once). Only allowed in active
  // phase: once submitted/cancelled, the result is frozen and appending empty
  // states would (a) let buildAskChoiceResult emit empty answers for the new
  // questions and (b) risk indexing undefined. Late-arriving data after submit
  // is harmless to drop because the user already answered the questions that
  // existed at submit time.
  if (action.type === "HYDRATE_QUESTIONS") {
    if (state.phase !== "active") return state;
    const newQuestions = action.questions;
    if (newQuestions.length <= state.questionStates.length) {
      // Only update the questions ref if it actually grew; otherwise no-op
      // to avoid needless re-renders.
      if (newQuestions.length === state.questions.length) return state;
      return { ...state, questions: newQuestions };
    }
    const appended = newQuestions
      .slice(state.questionStates.length)
      .map(() => ({
        cursorIndex: 0,
        selectedIds: [],
        pickedId: null,
        otherText: "",
        otherFocused: false,
      }));
    return {
      ...state,
      questions: newQuestions,
      questionStates: [...state.questionStates, ...appended],
      activeIndex: Math.min(state.activeIndex, newQuestions.length - 1),
    };
  }

  if (state.phase !== "active") return state;

  switch (action.type) {
    case "CANCEL":
      return { ...state, phase: "cancelled" };

    case "SUBMIT": {
      if (!canSubmit(state)) return state;
      return { ...state, phase: "submitted" };
    }

    case "SWITCH_TAB": {
      const idx = clamp(action.index, 0, state.questions.length - 1);
      return { ...state, activeIndex: idx };
    }

    case "NEXT_TAB": {
      const idx = Math.min(state.activeIndex + 1, state.questions.length - 1);
      return { ...state, activeIndex: idx };
    }

    case "PREV_TAB": {
      const idx = Math.max(state.activeIndex - 1, 0);
      return { ...state, activeIndex: idx };
    }

    case "MOVE_CURSOR": {
      const qs = state.questionStates[state.activeIndex];
      const q = state.questions[state.activeIndex];
      const maxIndex = q.allowOther ? q.choices.length : q.choices.length - 1;
      const next = clamp(qs.cursorIndex + action.delta, 0, maxIndex);
      const newQs = [...state.questionStates];
      newQs[state.activeIndex] = {
        ...qs,
        cursorIndex: next,
        otherFocused: false,
      };
      return { ...state, questionStates: newQs };
    }

    case "TOGGLE_AT_CURSOR": {
      const qs = state.questionStates[state.activeIndex];
      const q = state.questions[state.activeIndex];
      if (!q.multiSelect) return state; // no-op in single-select mode
      const isOtherRow = qs.cursorIndex >= q.choices.length;
      if (isOtherRow) {
        // Toggle focus on Other input
        const newQs = [...state.questionStates];
        newQs[state.activeIndex] = { ...qs, otherFocused: !qs.otherFocused };
        return { ...state, questionStates: newQs };
      }
      const choiceId = q.choices[qs.cursorIndex]?.id;
      if (!choiceId) return state;
      const has = qs.selectedIds.includes(choiceId);
      const newSelected = has
        ? qs.selectedIds.filter((id) => id !== choiceId)
        : [...qs.selectedIds, choiceId];
      const newQs = [...state.questionStates];
      newQs[state.activeIndex] = { ...qs, selectedIds: newSelected };
      return { ...state, questionStates: newQs };
    }

    case "SELECT_AT_CURSOR": {
      const qs = state.questionStates[state.activeIndex];
      const q = state.questions[state.activeIndex];
      const isOtherRow = qs.cursorIndex >= q.choices.length;

      if (isOtherRow) {
        // Focus the Other text input
        const newQs = [...state.questionStates];
        newQs[state.activeIndex] = { ...qs, otherFocused: true };
        return { ...state, questionStates: newQs };
      }

      const choiceId = q.choices[qs.cursorIndex]?.id;
      if (!choiceId) return state;

      if (q.multiSelect) {
        // In multi-select, Enter on a choice toggles it
        const has = qs.selectedIds.includes(choiceId);
        const newSelected = has
          ? qs.selectedIds.filter((id) => id !== choiceId)
          : [...qs.selectedIds, choiceId];
        const newQs = [...state.questionStates];
        newQs[state.activeIndex] = { ...qs, selectedIds: newSelected };
        return { ...state, questionStates: newQs };
      }

      // Single-select: pick and auto-advance or auto-submit
      const newQs = [...state.questionStates];
      newQs[state.activeIndex] = { ...qs, pickedId: choiceId, otherFocused: false };

      // If single question, auto-submit on pick (fast UX)
      if (state.questions.length === 1) {
        return {
          ...state,
          questionStates: newQs,
          phase: "submitted",
        };
      }

      // Multi-question single-select: pick, then auto-submit if last tab
      // and all questions answered; otherwise advance to next tab.
      const nextState = { ...state, questionStates: newQs };
      const isLastTab = state.activeIndex >= state.questions.length - 1;
      if (isLastTab && canSubmit(nextState)) {
        return { ...nextState, phase: "submitted" as const };
      }
      const nextTab = Math.min(
        state.activeIndex + 1,
        state.questions.length - 1,
      );
      return { ...nextState, activeIndex: nextTab };
    }

    case "FOCUS_OTHER": {
      const qs = state.questionStates[state.activeIndex];
      const newQs = [...state.questionStates];
      newQs[state.activeIndex] = { ...qs, otherFocused: true };
      return { ...state, questionStates: newQs };
    }

    case "BLUR_OTHER": {
      const qs = state.questionStates[state.activeIndex];
      const newQs = [...state.questionStates];
      newQs[state.activeIndex] = { ...qs, otherFocused: false };
      return { ...state, questionStates: newQs };
    }

    case "SET_OTHER_TEXT": {
      const qs = state.questionStates[state.activeIndex];
      const newQs = [...state.questionStates];
      newQs[state.activeIndex] = { ...qs, otherText: action.text };
      return { ...state, questionStates: newQs };
    }

    default:
      return state;
  }
}

// ── Queries ────────────────────────────────────────────────────────

/** Whether a question has a valid answer (selected or Other text). */
export function isQuestionAnswered(
  q: AskChoiceQuestion,
  qs: QuestionUiState,
): boolean {
  if (!q.required) return true;
  const hasSelection = q.multiSelect
    ? qs.selectedIds.length > 0
    : qs.pickedId !== null;
  const hasOther = q.allowOther && qs.otherText.trim().length > 0;
  return hasSelection || hasOther;
}

/** Whether the entire form can be submitted. */
export function canSubmit(state: AskChoiceUiState): boolean {
  return state.questions.every((q, i) =>
    isQuestionAnswered(q, state.questionStates[i]),
  );
}

/** Build the final result from a submitted state. */
export function buildAskChoiceResult(
  state: AskChoiceUiState,
): AskChoiceResult {
  if (state.phase === "cancelled") return { kind: "cancelled" };
  if (state.phase !== "submitted") return { kind: "cancelled" };

  const answers: QuestionAnswer[] = state.questions.map((q, i) => {
    const qs = state.questionStates[i];
    const selectedIds = q.multiSelect ? qs.selectedIds : qs.pickedId ? [qs.pickedId] : [];
    const otherText = qs.otherText.trim();

    // Build combined userMessage
    const parts: string[] = [];
    for (const id of selectedIds) {
      const choice = q.choices.find((c) => c.id === id);
      if (choice) {
        parts.push(choice.userMessage || choice.label);
      }
    }
    if (otherText) {
      parts.push(otherText);
    }

    return {
      questionId: q.id,
      selectedIds,
      otherText,
      userMessage: parts.join("\n"),
    };
  });

  return { kind: "submitted", answers };
}

/**
 * Convenience: build the legacy-compatible single userMessage string
 * from a submitted result (for backward compat with single-question flows).
 */
export function buildLegacyUserMessage(result: AskChoiceResult): string {
  if (result.kind === "cancelled") return "";
  return result.answers.map((a) => a.userMessage).filter(Boolean).join("\n\n");
}

// ── Helpers ────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
