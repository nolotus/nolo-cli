// packages/ai/agent/queryRunOverlay.ts
//
// Web adapter: query the runs belonging to one dialog and reduce them into a
// RunOverlayState the presentation builder can render.
//
// The run list comes from the server's GET /api/agent/threads?parentThreadId=
// endpoint — the same one ChildRunObserverPanel uses. We reuse the existing
// pure helpers (buildChildThreadsQueryUrl / parseChildThreadsResponse /
// filterDirectChildRuns) rather than parsing the response a second time, so
// the parentThreadId matching semantics stay in one place.
//
// Why not controlAgentRun(list)? That endpoint returns RunSummary, which
// carries runId/status/agentKey but NOT parentThreadId, name, or summary —
// not enough to filter by parent dialog nor to build a meaningful RunInfo.
// /api/agent/threads returns the full thread projection (title, summary,
// parentThreadId), which is exactly what reduceRunOverlay needs.
//
// `parentThreadId` on a thread is the parent dialog's *id* (extractCustomId
// of the dialogKey), matching what startAgentRun stores (see
// startAgentRunTool: parentDialogId = extractCustomId(activeDialogKey)). So
// this function accepts a dialogKey and extracts the id before querying.

import { extractCustomId } from "../../core/prefix";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { selectCurrentServer } from "../../app/settings/settingSlice";
import { selectIdentityToken } from "identity/selectors";
import type { RootState } from "../../app/store";
import {
  buildChildThreadsQueryUrl,
  filterDirectChildRuns,
  parseChildThreadsResponse,
} from "../../chat/dialog/childRunObserverState";
import type { ClientAgentThread } from "../agent/web/agentDisplayUtils";
import {
  initialRunOverlayState,
  reduceRunOverlay,
  type RunInfo,
  type RunOverlayState,
  type RunStatus,
} from "../../core/chat/runOverlayMachine";

/** Map a ClientAgentThread status to the overlay machine's RunStatus. */
function toRunStatus(status: string | undefined): RunStatus {
  // pending is a server-side "not yet started" phase; the overlay treats it
  // as running (the user already派发了, it just hasn't begun executing).
  if (status === "pending") return "running";
  // AgentThreadStatus also has "orphaned" (process died, record stale). The
  // ClientAgentThread type narrows to the common subset, but the server can
  // still send it; surface it faithfully.
  if (status === "orphaned") return "orphaned";
  switch (status) {
    case "running":
    case "reviewing":
    case "testing":
    case "done":
    case "failed":
    case "cancelled":
      return status;
    default:
      return "running";
  }
}

/** Build a RunInfo from a single client thread projection. */
function threadToRunInfo(thread: ClientAgentThread): RunInfo {
  const name =
    asOptionalTrimmedString(thread.title) ??
    asOptionalTrimmedString(thread.primaryAgentKey) ??
    asOptionalTrimmedString(thread.threadId) ??
    "run";
  const summary = asOptionalTrimmedString(thread.summary) ?? undefined;
  const errorMessage = thread.runtimeEvidence?.errorMessage
    ? asOptionalTrimmedString(thread.runtimeEvidence.errorMessage) ?? undefined
    : undefined;
  return {
    runId: thread.threadId,
    name,
    status: toRunStatus(thread.status),
    summary,
    parentDialogId: asOptionalTrimmedString(thread.parentThreadId) ?? undefined,
    errorMessage,
    updatedAt:
      typeof thread.updatedAt === "number" ? thread.updatedAt : Date.now(),
  };
}

export type QueryRunOverlayDeps = {
  /** Injected fetch so tests can stub the server call. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Query all runs whose parentThreadId matches the given dialog, reduced into a
 * RunOverlayState. Returns null when the dialogKey has no resolvable id or the
 * server returns no direct children (so the caller can skip presenting).
 *
 * Fire-and-forget friendly: any fetch/parse error is caught and returned as
 * null — the turn-end path must never throw on overlay failure.
 */
export async function queryRunOverlay(
  state: RootState,
  dialogKey: string,
  deps: QueryRunOverlayDeps = {},
): Promise<RunOverlayState | null> {
  const dialogId = extractCustomId(dialogKey);
  if (!dialogId) return null;

  const server = selectCurrentServer(state);
  const token = selectIdentityToken(state);
  // No token ⇒ not an authenticated web session. Skip the query rather than
  // fire an unauthenticated request (tests and pre-login states land here;
  // aligns with ChildRunObserverPanel's `if (!token) return` guard).
  if (!token) return null;
  const url = buildChildThreadsQueryUrl({
    serverOrigin: String(server ?? ""),
    parentThreadId: dialogId,
  });

  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Network/auth failure is not fatal to the turn — degrade to "no overlay".
    return null;
  }

  if (!response.ok) return null;

  const payload = await response.json().catch(() => null);
  if (!payload) return null;

  const parsed = parseChildThreadsResponse(payload, dialogId);
  if (parsed.ok !== true) return null;

  const children = filterDirectChildRuns(parsed.threads, dialogId);
  if (children.length === 0) return null;

  let overlay = initialRunOverlayState;
  for (const thread of children) {
    overlay = reduceRunOverlay(overlay, {
      type: "run-state-chg",
      runId: thread.threadId,
      info: {
        name: threadToRunInfo(thread).name,
        status: threadToRunInfo(thread).status,
        summary: threadToRunInfo(thread).summary,
        parentDialogId: threadToRunInfo(thread).parentDialogId,
        errorMessage: threadToRunInfo(thread).errorMessage,
      },
    });
  }
  return overlay;
}