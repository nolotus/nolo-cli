/**
 * Local tool executor assembly for CLI local runtime.
 *
 * Extracted from localRuntimeAdapter.ts. Aggregates workspace tools, server
 * platform tools, CLI workspace tools, x-post/xhs bridges, and ui_ask_choice
 * into a single executor map.
 *
 * Direct imports replace lazy ensureHeavyCliLocalRuntimeModules indirection.
 */
import type { EnvLike } from "./localRuntimeHelpers";
import type { CliFetchImpl } from "../cliFetch";
import type { PermissionRequest } from "../../agent-runtime/actionGate";
import {
  createLocalWorkspaceToolExecutors,
} from "../../agent-runtime/localWorkspaceTools";
import { buildNoloWorkspaceCliToolExecutors } from "../../agent-runtime/noloWorkspaceTools";
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

export type ReadToolFn = (
  args: Record<string, unknown>,
  opts?: unknown,
) => Promise<{ rawData: unknown; displayData?: string }>;

export type LocalCliExecutor = (
  provider: string,
  prompt: string,
  options: { workspaceRoot: string; env: EnvLike },
) => Promise<{ content: string; stopReason?: string; usage?: unknown }>;

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
  /** Interactive choice dialog for ui_ask_choice; absent in headless/CI mode. */
  requestUserChoice?: (request: UserChoiceRequest) => Promise<UserChoiceResult>;
  /** CLI entrypoint path (for re-launching workspace tools). */
  cliEntrypoint?: string;
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
    }),
    ...buildCliWorkspaceToolExecutors({
      env: args.env,
      cliEntrypoint: args.cliEntrypoint,
    }),
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
    ui_ask_choice: async (call: any) => {
      const parsedArgs = (() => {
        try {
          return JSON.parse(call.arguments || "{}");
        } catch {
          return {};
        }
      })();
      const question = String(parsedArgs.question ?? "").trim();
      const choices = Array.isArray(parsedArgs.choices) ? parsedArgs.choices : [];
      const blocking = parsedArgs.blocking !== false;
      if (!question || choices.length === 0) {
        return {
          content: JSON.stringify({
            error: "ui_ask_choice",
            detail: "ui_ask_choice 需要 question 和至少一个 choice。",
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
            question,
            choices,
            blocking,
          });
          if (result.kind === "selected") {
            return {
              content: JSON.stringify({
                type: "ui_ask_choice",
                question,
                choices,
                blocking,
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
              type: "ui_ask_choice",
              question,
              choices,
              blocking,
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
          type: "ui_ask_choice",
          question,
          choices,
          blocking,
        }),
        metadata: { uiAskChoice: true },
      };
    },
    ...(args.localToolExecutors ?? {}),
  };
}