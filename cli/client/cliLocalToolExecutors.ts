/**
 * Local tool executor assembly for CLI local runtime.
 *
 * Extracted from localRuntimeAdapter.ts. Aggregates workspace tools, server
 * platform tools, CLI workspace tools, x-post/xhs bridges, and ask_user
 * into a single executor map.
 *
 * Direct imports replace lazy ensureHeavyCliLocalRuntimeModules indirection.
 */
import type { EnvLike } from "./localRuntimeHelpers";
import type { CollapsedPasteStore } from "../../core/collapsedPaste";
import {
  filterRetainedLedgerRecords,
  isLineRangeCovered,
  type LedgerEntry,
  type LedgerRecord,
} from "../../core/readRangeLedger";
import { resolveHistoricalToolContentCap } from "../../ai/agent/toolOutputPolicy";
import type { CliFetchImpl } from "../cliFetch";
import type { PermissionRequest } from "../../agent-runtime/actionGate";
import {
  createLocalWorkspaceToolExecutors,
} from "../../agent-runtime/localWorkspaceTools";
import {
  buildLoadSkillExecutor,
  buildNoloWorkspaceCliToolExecutors,
} from "../../agent-runtime/noloWorkspaceTools.node";
import { readXPostFunc } from "../../ai/tools/readXPostTool";
import { readXhsProfileFunc } from "../../ai/tools/readXhsProfileTool";
import type {
  UserChoiceOption,
  UserChoiceRequest,
  UserChoiceResult,
  CliLocalRuntimeDb,
} from "./localRuntimeAdapterTypes";
import type { HybridRecordStore } from "./hybridRecordStore";
import { buildServerPlatformToolExecutors } from "./cliServerPlatformToolExecutors";
import {
  createCliControlAgentRunExecutor,
  createCliStartAgentRunExecutor,
} from "./cliAgentRunToolExecutors";
import { setTodoListFunc } from "../../ai/tools/agent/setTodoListTool";

export type ReadToolFn = (
  args: Record<string, unknown>,
  opts?: unknown,
) => Promise<{ rawData: unknown; displayData?: string }>;

export type LocalCliExecutor = (
  provider: string,
  prompt: string,
  options: { workspaceRoot: string; env: EnvLike },
) => Promise<{ content: string; stopReason?: string; usage?: unknown }>;

const MAX_PASTED_TEXT_LINES_PER_READ = 200;
// An explicit endLine may exceed the paging cap by this margin, so a slightly
// over-one-page paste (e.g. 210 lines requested as 1-210) is delivered by a
// single call instead of forcing a tail-fetching second read.
const PASTED_TEXT_EXPLICIT_OVERSHOOT_LINES = 20;
const PASTE_LEDGER_MAX_RECORDS = 64;

export function createReadPastedTextExecutor(store: CollapsedPasteStore) {
  // Read ledger: ranges fully delivered this session. A repeated read whose
  // request is covered by still-in-context deliveries answers with a short
  // notice instead of resending (force:true overrides). Only deliveries small
  // enough to survive historical projection are treated as still in context —
  // see resolveHistoricalToolContentCap.
  const ledger = new Map<number, LedgerEntry>();
  return async (call: any) => {
    let parsed: Record<string, unknown> = {};
    try {
      const value = JSON.parse(call.arguments || "{}");
      if (value && typeof value === "object") parsed = value;
    } catch {
      return {
        content: "readPastedText requires a JSON object with pasteId.",
        metadata: { error: true, code: "invalid_arguments" },
      };
    }
    const pasteId = Number(parsed.pasteId);
    if (!Number.isInteger(pasteId) || pasteId < 1) {
      return {
        content: "readPastedText requires a positive integer pasteId.",
        metadata: { error: true, code: "invalid_paste_id" },
      };
    }
    const text = store.items.get(pasteId);
    if (text === undefined) {
      return {
        content: `pasted text #${pasteId} is no longer available in this TUI turn.`,
        metadata: { error: true, code: "paste_not_found", pasteId },
      };
    }
    const force = parsed.force === true;

    const lines = text.split("\n");
    const fingerprint = `${lines.length}:${text.length}`;
    const requestedStart = Number(parsed.startLine);
    const requestedEnd = Number(parsed.endLine);
    const startLine = Number.isInteger(requestedStart) && requestedStart > 0
      ? Math.min(requestedStart, lines.length)
      : 1;
    const explicitEnd = Number.isInteger(requestedEnd) && requestedEnd >= startLine
      ? requestedEnd
      : undefined;
    const defaultEnd = startLine + MAX_PASTED_TEXT_LINES_PER_READ - 1;
    const endLine = Math.min(
      lines.length,
      explicitEnd ?? defaultEnd,
      defaultEnd + (explicitEnd !== undefined ? PASTED_TEXT_EXPLICIT_OVERSHOOT_LINES : 0),
    );

    let entry = ledger.get(pasteId);
    if (entry && entry.fingerprint !== fingerprint) {
      entry = undefined;
      ledger.delete(pasteId);
    }
    if (!force && entry) {
      const retainedCap = resolveHistoricalToolContentCap("readPastedText", 0);
      const retained = filterRetainedLedgerRecords(entry.records, retainedCap);
      if (retained.length > 0 && isLineRangeCovered({ startLine, endLine }, retained)) {
        return {
          content:
            `[readPastedText] paste #${pasteId} lines ${startLine}-${endLine} were already ` +
            "delivered earlier in this session and remain in context; not resending. " +
            "Pass force:true to refetch.",
          metadata: {
            pasteId,
            startLine,
            endLine,
            totalLines: lines.length,
            deduped: true,
            source: "tui-paste-store",
          },
        };
      }
    }

    const delivered = lines.slice(startLine - 1, endLine).join("\n");
    // Footer only when we cut the request short (paging cap or explicit
    // overshoot margin): it carries the exact next startLine so follow-up
    // pages never overlap or guess.
    // No continuation footer at EOF — "continue with startLine=N+1" past the
    // last line would be misleading.
    const clamped = explicitEnd !== undefined && endLine < explicitEnd && endLine < lines.length;
    const paged = explicitEnd === undefined && endLine < lines.length;
    const needsFooter = clamped || paged;
    const content = needsFooter
      ? `${delivered}\n[readPastedText: returned lines ${startLine}-${endLine} of ${lines.length}. Continue with startLine=${endLine + 1}.]`
      : delivered;

    const metadata = {
      pasteId,
      startLine,
      endLine,
      totalLines: lines.length,
      totalChars: text.length,
      truncated: endLine < lines.length,
      // Continuation pointer whenever more content exists, even when an
      // explicit request was honored in full — the schema contract says a
      // truncated read advertises the exact next startLine.
      ...(endLine < lines.length ? { nextStartLine: endLine + 1 } : {}),
      source: "tui-paste-store",
    };
    // Provider-facing historical messages carry a bounded metadata suffix
    // (projectToolContentForProvider), so record content + suffix length —
    // the same conservative units as readFile's ledger.
    const persistedChars =
      content.length +
      "\n\n[tool metadata]\n".length +
      JSON.stringify(metadata).length;
    const records = entry?.records ?? [];
    records.push({ startLine, endLine, chars: persistedChars });
    ledger.set(pasteId, {
      fingerprint,
      records: records.slice(-PASTE_LEDGER_MAX_RECORDS),
    });

    return { content, metadata };
  };
}

export function buildCliWorkspaceToolExecutors(args: {
  env: EnvLike;
  cliEntrypoint?: string;
}) {
  return buildNoloWorkspaceCliToolExecutors({
    cliEntrypoint: args.cliEntrypoint ?? process.argv[1] ?? "",
    env: args.env,
    metadataKind: "cliWorkspaceTool",
  });
}

export function buildLocalToolExecutors(args: {
  workspaceRoot: string;
  env: EnvLike;
  fetchImpl: CliFetchImpl;
  localToolExecutors?: Record<
    string,
    (call: any) => Promise<{ content: string; metadata?: Record<string, unknown> }>
  >;
  readXPost?: ReadToolFn;
  readXhsProfile?: ReadToolFn;
  commandTimeoutMs?: number;
  commandOutputLimit?: number;
  /** Reused for external-file-access prompts (same PermissionRequest shape). */
  confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>;
  /** Interactive choice dialog for ask_user; absent in headless/CI mode. */
  requestUserChoice?: (request: UserChoiceRequest) => Promise<UserChoiceResult>;
  pastedTextStore?: CollapsedPasteStore;
  /** CLI entrypoint path (for re-launching workspace tools). */
  cliEntrypoint?: string;
  /** Current executing agent key; used for memory policy. */
  agentKey?: string | null;
}) {
  return {
    ...createLocalWorkspaceToolExecutors({
      workspaceRoot: args.workspaceRoot,
      commandTimeoutMs: args.commandTimeoutMs,
      commandOutputLimit: args.commandOutputLimit,
      ...(args.confirmDestructiveAction
        ? { confirmExternalFileAccess: args.confirmDestructiveAction }
        : {}),
    }),
    ...buildServerPlatformToolExecutors({
      env: args.env,
      fetchImpl: args.fetchImpl,
      agentKey: args.agentKey,
    }),
    ...buildCliWorkspaceToolExecutors({
      env: args.env,
      cliEntrypoint: args.cliEntrypoint,
    }),
    // loadSkill resolves SKILL.md from the agent's workspace root (local-fs,
    // no `nolo` CLI subcommand), so it is wired here instead of inside
    // buildCliWorkspaceToolExecutors.
    loadSkill: buildLoadSkillExecutor({ cwd: args.workspaceRoot }),
    read_x_post: async (call: any) => {
      const parsedArgs = (() => {
        try {
          return JSON.parse(call.arguments || "{}");
        } catch {
          return {};
        }
      })();
      const result = await (args.readXPost ?? readXPostFunc)(parsedArgs, undefined);
      return {
        content: JSON.stringify(result.rawData),
        metadata: {
          xPostLocalBridge: true,
          displayData: result.displayData,
        },
      };
    },
    read_xhs_profile: async (call: any) => {
      const parsedArgs = (() => {
        try {
          return JSON.parse(call.arguments || "{}");
        } catch {
          return {};
        }
      })();
      const result = await (args.readXhsProfile ?? readXhsProfileFunc)(
        parsedArgs,
        undefined,
      );
      return {
        content: JSON.stringify(result.rawData),
        metadata: {
          xhsLocalBridge: true,
          displayData: result.displayData,
        },
      };
    },
    ask_user: async (call: any) => {
      const parsedArgs = (() => {
        try {
          return JSON.parse(call.arguments || "{}");
        } catch {
          return {};
        }
      })();
      const question = String(parsedArgs.question ?? "").trim();
      const choices = Array.isArray(parsedArgs.choices) ? parsedArgs.choices : [];
      const questions = Array.isArray(parsedArgs.questions) ? parsedArgs.questions : undefined;
      const blocking = parsedArgs.blocking !== false;

      // Validate: need either questions[] or question+choices
      const hasQuestions = questions && questions.length > 0;
      if (!hasQuestions && (!question || choices.length === 0)) {
        return {
          content: JSON.stringify({
            error: "ask_user",
            detail: "ask_user 需要 question+choices 或 questions。",
          }),
          metadata: { uiAskChoice: true, error: true },
        };
      }

      // Interactive TUI: show an arrow-key select dialog docked above the
      // composer and resolve the user's pick into the next userMessage.
      // Headless / non-TTY / no-callback: fall back to the raw JSON payload so
      // the toolOutput renderer can print a numbered text menu.
      if (args.requestUserChoice) {
        try {
          const result = await args.requestUserChoice({
            question: hasQuestions ? questions[0].question : question,
            choices: hasQuestions ? questions[0].choices : choices,
            blocking,
            ...(hasQuestions ? { questions } : {}),
          });
          if (result.kind === "multi-submitted") {
            return {
              content: JSON.stringify({
                type: "ask_user",
                question,
                choices,
                blocking,
                ...(hasQuestions ? { questions } : {}),
                answers: result.answers,
                selected: {
                  label: result.answers.map(a => a.userMessage).join(", "),
                  userMessage: result.userMessage,
                },
              }),
              metadata: { uiAskChoice: true, resolved: true },
            };
          }
          if (result.kind === "selected") {
            return {
              content: JSON.stringify({
                type: "ask_user",
                question,
                choices,
                blocking,
                ...(hasQuestions ? { questions } : {}),
                selected: {
                  label: result.label,
                  userMessage: result.userMessage,
                },
              }),
              metadata: { uiAskChoice: true, resolved: true },
            };
          }
          // Cancelled: tell the model the user declined to choose, so it can
          // either ask differently or proceed with its own best judgement.
          return {
            content: JSON.stringify({
              type: "ask_user",
              question,
              choices,
              blocking,
              ...(hasQuestions ? { questions } : {}),
              selected: { label: "", userMessage: "" },
              cancelled: true,
            }),
            metadata: { uiAskChoice: true, resolved: true, cancelled: true },
          };
        } catch {
          // Dialog failed (e.g. non-TTY despite a callback being wired);
          // fall through to the non-interactive payload below.
        }
      }
      return {
        content: JSON.stringify({
          type: "ask_user",
          question,
          choices,
          blocking,
          ...(hasQuestions ? { questions } : {}),
        }),
        metadata: { uiAskChoice: true },
      };
    },
    // agent-orchestration 能力包：startAgentRun / controlAgentRun 本地 --bg 执行器
    // （复用 ~/.nolo/runs/ 注册表，MED-1 修复）。
    startAgentRun: createCliStartAgentRunExecutor({
      env: args.env,
      cliEntrypoint: args.cliEntrypoint,
      cwd: args.workspaceRoot,
    }),
    controlAgentRun: createCliControlAgentRunExecutor({
      env: args.env,
    }),
    setTodoList: async (call: any) => {
      const parsedArgs = typeof call?.arguments === "string"
        ? (() => { try { return JSON.parse(call.arguments); } catch { return {}; } })()
        : call?.arguments || {};
      const res = await setTodoListFunc(parsedArgs);
      return {
        content: JSON.stringify(res.rawData),
        metadata: { displayData: res.displayData },
      };
    },
    ...(args.pastedTextStore
      ? { readPastedText: createReadPastedTextExecutor(args.pastedTextStore) }
      : {}),
    ...(args.localToolExecutors ?? {}),
  };
}
