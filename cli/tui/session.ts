/**
 * TUI session — barrel re-export.
 *
 * The original monolithic session.ts was split into focused modules:
 *   - sessionTypes.ts    — shared type definitions
 *   - sessionRender.ts   — rendering (status line, welcome, help, context)
 *   - sessionInput.ts    — key handling, tab completion, input classification
 *   - sessionDispatch.ts — state initialization and slash-command dispatch
 *
 * This barrel keeps the public import path (`./session`) stable so existing
 * consumers (readlineWorkspace, tests) don't need to change.
 */

// Types
export type {
  TuiState,
  TuiAction,
  TuiInputResult,
  TuiKeyInfo,
  TuiInputKeyResult,
} from "./sessionTypes";

// Rendering
export {
  renderStatusLine,
  renderWelcome,
  renderPrompt,
  renderTuiHelp,
  renderContextPanel,
  renderKnownAgents,
  formatElapsedSeconds,
} from "./sessionRender";

// Input handling
export {
  PASTE_TOKEN_PREFIX,
  applyTuiInputKey,
  SLASH_COMMANDS,
  completeSlashPrefix,
  completeSlashCommand,
  isLikelySlashCommand,
  stripImageTokens,
} from "./sessionInput";

// Dispatch & state
export {
  DEFAULT_TUI_AGENT_KEY,
  DEFAULT_TUI_SERVER_URL,
  createInitialTuiState,
  handleTuiInput,
} from "./sessionDispatch";
