import type {
  AgentRuntimeAgentConfig,
  AgentRuntimeHostAdapter,
} from "../agentRuntimeLocal";
import type {
  AgentRuntimeToolCallInput,
  AgentRuntimeToolResult,
} from "../agent-runtime";
import type {
  LocalAgentTurnInput,
  LocalAgentTurnResult,
} from "../agent-runtime/localLoop";
import type { EnvLike } from "./localRuntimeHelpers";
import {
  summarizeOpenAiToolNames,
  createFallbackId,
  type CliLocalRuntimeAdapterDeps,
} from "./localRuntimeDiagnostics";
import { getOrCreateSharedStore } from "./localRuntimeDialog";
import { resolveLocalUserId } from "./cliAgentConfigHelpers";
import {
  shouldUseDeclaredOnlyLocalWorkspaceTools,
  resolveGlobFilesDescriptionVariant,
  resolveListFilesDescriptionVariant,
  resolveListFilesParameterVariant,
  resolveReadFileDescriptionVariant,
  resolveReadFileParameterVariant,
  resolveGlobFilesParameterVariant,
  resolveSearchFilesDescriptionVariant,
  resolveSearchFilesParameterVariant,
} from "./cliWorkspaceToolVariants";
import {
  buildLocalWorkspaceOpenAiTools,
  buildLocalWorkspaceToolset,
} from "../agentRuntimeLocal";
import {
  LOCAL_SERVER_TABLE_TOOL_NAME_SET,
  LOCAL_SERVER_WEB_TOOL_NAME_SET,
} from "./cliToolClassification";
import {
  FORCED_TOOLS,
  applyDisabledTools,
  expandEnabledPacks,
  resolveEffectiveEnabledPacks,
  addDefaultSystemCapabilityTools,
  applySystemBuiltinSkillFilter,
  appendEnabledPackPromptPatches,
  addDefaultLightWebToolsForConfiguredAgents,
} from "../ai/tools/toolPacks";
import { prepareTools } from "../ai/tools/prepareTools";
import { canonicalizeToolNames } from "../ai/tools/toolNameAliases";
import {
  buildNoloWorkspaceOpenAiTools,
  parseNoloWorkspaceToolArguments,
} from "../agent-runtime/noloWorkspaceTools";
import { readXhsProfileFunctionSchema } from "../ai/tools/readXhsProfileTool";
import { readXPostFunctionSchema } from "../ai/tools/readXPostTool";
import { rememberMemoryFunctionSchema } from "../ai/tools/rememberMemoryToolSchema";
import {
  parseJsonObject,
  buildDelegatedTaskContent,
} from "./cliProviderHelpers";
import {
  persistCliPendingChildDialog,
  persistCliFailedChildDialog,
} from "./cliChildDialogPersist";
import { toErrorMessage } from "../core/errorMessage";
import { asTrimmedString } from "../core/trimmedString";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedNonEmptyStringArray } from "../core/stringArray";
import { resolveRequestedRuntimeToolNames } from "../agentRuntimeLocal";

export function buildOpenAiTools(args: {
  agentKey?: string;
  toolNames?: string[];
  env: EnvLike;
}) {
  const toolset = buildLocalWorkspaceToolsetForEnv(args);
  const toolNameSet = new Set(args.toolNames ?? []);
  const callAgentTools = toolNameSet.has("callAgent")
    ? prepareTools(["callAgent"])
    : [];
  const uiAskChoiceTools = toolNameSet.has("ui_ask_choice")
    ? prepareTools(["ui_ask_choice"])
    : [];
  const readPastedTextTools = toolNameSet.has("readPastedText")
    ? [
        {
          type: "function",
          function: {
            name: "readPastedText",
            description:
              "Read a chunk of a large TUI paste by pasteId. Use startLine and endLine to page through the full content.",
            parameters: {
              type: "object",
              properties: {
                pasteId: {
                  type: "integer",
                  minimum: 1,
                  description: "The paste id from the user message reference.",
                },
                startLine: {
                  type: "integer",
                  minimum: 1,
                  description: "First 1-based line to return; defaults to 1.",
                },
                endLine: {
                  type: "integer",
                  minimum: 1,
                  description:
                    "Last 1-based line to return; each call is bounded to a 200-line chunk.",
                },
              },
              required: ["pasteId"],
              additionalProperties: false,
            },
          },
        },
      ]
    : [];
  return [
    ...callAgentTools,
    ...uiAskChoiceTools,
    ...readPastedTextTools,
    ...buildLocalWorkspaceOpenAiTools({
      toolNames: toolset.toolNames,
      exposeShellTools: toolset.exposeShellTools,
      listFilesDescriptionVariant: resolveListFilesDescriptionVariant(args.env),
      listFilesParameterVariant: resolveListFilesParameterVariant(args.env),
      readFileDescriptionVariant: resolveReadFileDescriptionVariant(args.env),
      readFileParameterVariant: resolveReadFileParameterVariant(args.env),
      globFilesDescriptionVariant: resolveGlobFilesDescriptionVariant(args.env),
      globFilesParameterVariant: resolveGlobFilesParameterVariant(args.env),
      searchFilesDescriptionVariant: resolveSearchFilesDescriptionVariant(
        args.env,
      ),
      searchFilesParameterVariant: resolveSearchFilesParameterVariant(args.env),
    }),
    ...buildServerPlatformOpenAiTools({ toolNames: args.toolNames }),
    ...buildNoloWorkspaceOpenAiTools({ toolNames: args.toolNames }),
    ...prepareTools(
      ["startAgentRun", "controlAgentRun"].filter((name) => toolNameSet.has(name)),
    ),
  ];
}

const CLI_DEFAULT_TOOLS = ["exa_search", "fetchWebpage"] as const;

function addDefaultCliCoreTools(
  toolNames: string[],
  env?: EnvLike,
  options?: { hasUserChoice?: boolean },
): string[] {
  const declaredOnly = env && shouldUseDeclaredOnlyLocalWorkspaceTools(env);
  const forcedTools =
    options?.hasUserChoice === true
      ? FORCED_TOOLS
      : FORCED_TOOLS.filter((name) => name !== "ui_ask_choice");
  const injected = declaredOnly
    ? [...forcedTools]
    : [...forcedTools, ...CLI_DEFAULT_TOOLS];
  const combined = [...toolNames, ...injected];
  const filtered =
    options?.hasUserChoice === true
      ? combined
      : combined.filter((name) => name !== "ui_ask_choice");
  return [...new Set(filtered)];
}

export function resolveCliEffectiveEnabledPacks(args: {
  enabledPacks?: string[] | null;
  declaredOnly?: boolean;
}): string[] {
  return resolveEffectiveEnabledPacks({
    enabledPacks: args.enabledPacks,
    declaredOnly: args.declaredOnly,
    emptyFallbackPacks: ["code"],
  });
}

export function withRuntimeEnabledPacksAndPrompt(
  config: AgentRuntimeAgentConfig,
): AgentRuntimeAgentConfig {
  const rawRecord = (config as unknown as { rawRecord?: Record<string, unknown> })
    .rawRecord ?? {};
  const enabledPacks =
    (config as unknown as { enabledPacks?: string[] }).enabledPacks ??
    (rawRecord.enabledPacks as string[] | undefined);
  const prompt = appendEnabledPackPromptPatches(
    (config as { prompt?: string }).prompt,
    enabledPacks,
  );
  if (
    prompt === (config as { prompt?: string }).prompt &&
    !enabledPacks?.length
  ) {
    return config;
  }
  return {
    ...config,
    ...(enabledPacks?.length ? { enabledPacks } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

export function resolveCliRequestedToolNames(
  agentConfig: AgentRuntimeAgentConfig,
  env: EnvLike,
  systemBuiltinSkills?: Record<string, boolean> | null,
  options?: { hasUserChoice?: boolean },
): string[] {
  const declaredOnly = shouldUseDeclaredOnlyLocalWorkspaceTools(env);
  const expanded = addDefaultLightWebToolsForConfiguredAgents(
    addDefaultCliCoreTools(
      canonicalizeToolNames(
        expandEnabledPacks(
          resolveCliEffectiveEnabledPacks({
            enabledPacks: (agentConfig as any)?.enabledPacks,
            declaredOnly,
          }),
          resolveRequestedRuntimeToolNames({ agentConfig }),
        ),
      ),
      env,
      options,
    ),
    agentConfig,
  );
  const filtered = applySystemBuiltinSkillFilter(
    // Default-on system capabilities (agent-orchestration) are mounted for
    // every non-declared-only agent before the global filter runs, so the
    // user's global "off" still wins. declared-only (ablation) runs keep
    // their strict surface.
    declaredOnly ? expanded : addDefaultSystemCapabilityTools(expanded),
    systemBuiltinSkills,
  );
  return applyDisabledTools(
    filtered,
    (agentConfig as any)?.disabledTools,
  );
}

export function resolveProviderOpenAiToolBundle(
  agentConfig: AgentRuntimeAgentConfig,
  env: EnvLike,
  buildTools: typeof buildOpenAiTools = buildOpenAiTools,
  additionalToolNames: string[] = [],
  options?: { hasUserChoice?: boolean },
) {
  const requestedToolNames = [
    ...new Set([
      ...resolveCliRequestedToolNames(agentConfig, env, null, options),
      ...additionalToolNames,
    ]),
  ];
  const tools = buildTools({
    agentKey: agentConfig.key,
    toolNames: requestedToolNames,
    env,
  });
  return { requestedToolNames, tools };
}

export function buildLocalWorkspaceToolsetForEnv(args: {
  toolNames?: string[];
  env: EnvLike;
}) {
  const toolset = buildLocalWorkspaceToolset({
    declaredToolNames: args.toolNames,
    exposeShellTools: true,
    useDeclaredToolNamesOnly: shouldUseDeclaredOnlyLocalWorkspaceTools(
      args.env,
    ),
  });
  return toolset;
}

export function buildLocalPolicyToolNames(args: {
  agentKey?: string;
  toolNames?: string[];
  env: EnvLike;
  buildProviderOpenAiTools?: typeof buildOpenAiTools;
}) {
  const schemaBuilder = args.buildProviderOpenAiTools ?? buildOpenAiTools;
  const tools = schemaBuilder({
    agentKey: args.agentKey,
    toolNames: args.toolNames,
    env: args.env,
  });
  const policyNames = summarizeOpenAiToolNames(
    tools as Array<Record<string, unknown>>,
  );
  return [...new Set(policyNames)];
}

export function buildServerPlatformOpenAiTools(args: { toolNames?: string[] }) {
  const toolNameSet = new Set(args.toolNames ?? []);
  const tableTools = prepareTools(
    Array.from(toolNameSet).filter((name) =>
      LOCAL_SERVER_TABLE_TOOL_NAME_SET.has(name),
    ),
  );
  const webTools = prepareTools(
    Array.from(toolNameSet).filter((name) =>
      LOCAL_SERVER_WEB_TOOL_NAME_SET.has(name),
    ),
  );
  return [
    ...(toolNameSet.has("rememberMemory")
      ? [
          {
            type: "function",
            function: rememberMemoryFunctionSchema,
          },
        ]
      : []),
    ...(toolNameSet.has("read_xhs_profile")
      ? [
          {
            type: "function",
            function: readXhsProfileFunctionSchema,
          },
        ]
      : []),
    ...(toolNameSet.has("read_x_post")
      ? [
          {
            type: "function",
            function: readXPostFunctionSchema,
          },
        ]
      : []),
    ...tableTools,
    ...webTools,
  ];
}

export type CliCallAgentToolExecutorContext = {
  createChildAdapter: (context: {
    dialogId: string;
    spaceId?: string;
    runtimeContext: Record<string, any>;
  }) => AgentRuntimeHostAdapter;
  runChildTurn: (input: LocalAgentTurnInput) => Promise<LocalAgentTurnResult>;
  dialogId?: string;
  spaceId?: string;
  runtimeContext?: Record<string, any> | null;
};

export function createCliCallAgentToolExecutor(
  deps: CliLocalRuntimeAdapterDeps,
  ctx: CliCallAgentToolExecutorContext,
): (call: AgentRuntimeToolCallInput) => Promise<AgentRuntimeToolResult> {
  const userId = resolveLocalUserId(deps.env);
  const workspaceRoot = deps.cwd ?? process.cwd();
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? createFallbackId;

  return async (call) => {
    const parsed = parseNoloWorkspaceToolArguments(call.arguments);
    const agentKey = asTrimmedString(parsed.agentKey);
    const task = asTrimmedString(parsed.task);

    if (!agentKey) {
      return {
        content: JSON.stringify({ error: "callAgent: agentKey is required" }),
        metadata: { callAgent: true },
      };
    }
    if (!task) {
      return {
        content: JSON.stringify({ error: "callAgent: task is required" }),
        metadata: { callAgent: true },
      };
    }

    const allowedChildAgentKeys = asTrimmedNonEmptyStringArray(
      ctx.runtimeContext?.allowedChildAgentKeys,
    );
    if (
      allowedChildAgentKeys.length > 0 &&
      !allowedChildAgentKeys.includes(agentKey)
    ) {
      return {
        content: JSON.stringify({
          error:
            "callAgent: agentKey is not allowed by parent runtimeContext.allowedChildAgentKeys",
          agentKey,
          allowedChildAgentKeys,
        }),
        metadata: { callAgent: true },
      };
    }

    const background = parsed.background === true;
    const parentDialogId = asOptionalTrimmedString(ctx.dialogId);
    const parentThreadId =
      parentDialogId ??
      asOptionalTrimmedString(ctx.runtimeContext?.parentThreadId);
    const rootThreadId =
      asOptionalTrimmedString(ctx.runtimeContext?.rootThreadId) ??
      asOptionalTrimmedString(ctx.runtimeContext?.parentThreadId) ??
      parentThreadId;
    const presentationIntent = background
      ? "background_handoff"
      : "inline_result";
    const threadKind = background ? "background" : "inline";

    const childRuntimeContext = {
      ...(ctx.runtimeContext ?? {}),
      surface: "cli",
      entrypoint: "agent-tool:callAgent",
      threadKind,
      presentationIntent,
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(rootThreadId ? { rootThreadId } : {}),
      workspaceRoot,
      workspaceKind: "current",
      workspaceAccess: "inherited",
    };

    const childDialogId = createId();
    const store = await getOrCreateSharedStore(deps);
    await persistCliPendingChildDialog({
      store,
      userId,
      dialogId: childDialogId,
      agentKey,
      title: task,
      spaceId: ctx.spaceId,
      parentDialogId,
      rootDialogId: rootThreadId,
      workspaceRoot,
      background,
      now: now(),
    });

    const childAdapter = ctx.createChildAdapter({
      dialogId: childDialogId,
      spaceId: ctx.spaceId,
      runtimeContext: childRuntimeContext,
    });
    const childInputBase: LocalAgentTurnInput = {
      adapter: childAdapter,
      agentRef: agentKey,
      input: buildDelegatedTaskContent(task, parsed.input),
      runtimeContext: childRuntimeContext,
      spaceId: ctx.spaceId,
      continueDialogId: childDialogId,
      parentDialogId,
    };

    if (background) {
      void ctx.runChildTurn(childInputBase).catch(async (error) => {
        const errorMessage = toErrorMessage(error);
        try {
          await persistCliFailedChildDialog({
            store,
            userId,
            dialogId: childDialogId,
            errorMessage,
            now: now(),
          });
        } catch (persistError) {
          deps.output?.write(
            `[nolo] failed to persist background child failure: ${toErrorMessage(
              persistError,
            )}\n`,
          );
        }
      });

      return {
        content: JSON.stringify({
          success: true,
          status: "pending",
          agentKey,
          childDialogId,
          ...(parentDialogId ? { parentDialogId } : {}),
        }),
        metadata: { callAgent: true, background: true, localRuntime: true },
      };
    }

    try {
      const childResult = await ctx.runChildTurn(childInputBase);
      return {
        content: JSON.stringify({
          success: true,
          agentKey,
          dialogId: childDialogId,
          model: childResult.model ?? null,
          provider: childResult.provider ?? null,
          content: childResult.content ?? "",
          usage: childResult.usage ?? null,
        }),
        metadata: { callAgent: true, background: false, localRuntime: true },
      };
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      try {
        await persistCliFailedChildDialog({
          store,
          userId,
          dialogId: childDialogId,
          errorMessage,
          now: now(),
        });
      } catch (persistError) {
        deps.output?.write(
          `[nolo] failed to persist foreground child failure: ${toErrorMessage(
            persistError,
          )}\n`,
        );
      }
      return {
        content: JSON.stringify({
          success: false,
          agentKey,
          dialogId: childDialogId,
          error: errorMessage,
        }),
        metadata: {
          callAgent: true,
          background: false,
          localRuntime: true,
          error: true,
        },
      };
    }
  };
}
