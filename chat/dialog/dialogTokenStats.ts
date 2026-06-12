import type { DialogConfig } from "../../app/types";

import type { TokenStats } from "./dialogSlice";

export const mergeDialogTokenStats = (
  dialogConfig: DialogConfig | null,
  runtimeTokens: TokenStats
): TokenStats => ({
  inputTokens: (dialogConfig?.inputTokens ?? 0) + runtimeTokens.inputTokens,
  outputTokens: (dialogConfig?.outputTokens ?? 0) + runtimeTokens.outputTokens,
  totalCost: (dialogConfig?.totalCost ?? 0) + runtimeTokens.totalCost,
});
