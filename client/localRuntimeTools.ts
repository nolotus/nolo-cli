import type {
  AgentRuntimeAgentConfig,
} from "../agentRuntimeLocal";
import type { EnvLike } from "./localRuntimeHelpers";
import {
  summarizeOpenAiToolNames,
} from "./localRuntimeDiagnostics";
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
import { resolveAgentRequiredPackIds } from "../ai/tools/agentSkillConfig";
import { prepareTools } from "../ai/tools/prepareTools";
import {
  filterToolNamesForRunKind,
  isSubtaskRun,
} from "../agent-runtime/agentRunIsolation";
import { canonicalizeToolNames } from "../ai/tools/toolNameAliases";
import {
  buildNoloWorkspaceOpenAiTools,
} from "../agent-runtime/noloWorkspaceTools";
import { readXhsProfileFunctionSchema } from "../ai/tools/readXhsProfileTool";
import { readXPostFunctionSchema } from "../ai/tools/readXPostTool";
import { rememberMemoryFunctionSchema } from "../ai/tools/rememberMemoryToolSchema";
import {
  parseJsonObject,
  buildDelegatedTaskContent,
} from "./cliProviderHelpers";
import { resolveRequestedRuntimeToolNames } from "../agentRuntimeLocal";

export function buildOpenAiTools(args: {
  agentKey?: string;
  toolNames?: string[];
  env: EnvLike;
}) {
  const toolset = buildLocalWorkspaceToolsetForEnv(args);
  const toolNameSet = new Set(args.toolNames ?? []);
  const uiAskChoiceTools = toolNameSet.has("ask_user")
    ? prepareTools(["ask_user"])
    : [];
  const readPastedTextTools = toolNameSet.has("readPastedText")
    ? [
        {
          type: "function",
          function: {
            name: "readPastedText",
            description:
              "Read a chunk of a large TUI paste by pasteId. Use startLine and endLine to page through the full content. " +
              "A truncated read appends the exact next startLine; a range already delivered earlier in this session " +
              "answers with a short notice instead of resending (pass force:true to refetch after context compaction).",
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
                    "Last 1-based line to return; each call is bounded to a 200-line chunk (a slightly larger explicit range is honored in one call).",
                },
                force: {
                  type: "boolean",
                  description:
                    "Refetch even when the requested range was already delivered earlier in this session.",
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
): string[] {
  // FORCED_TOOLS 当前为空（ask_user 已改为显式声明，不再默认注入）。
  // 历史：hasUserChoice 参数曾用于区分「TUI 交互注入 ask_user / headless
  // 不注入」，ask_user 移出本层后参数链已删除（见 feat/ask-user-cleanup）。
  const declaredOnly = env && shouldUseDeclaredOnlyLocalWorkspaceTools(env);
  const injected = declaredOnly
    ? [...FORCED_TOOLS]
    : [...FORCED_TOOLS, ...CLI_DEFAULT_TOOLS];
  return [...new Set([...toolNames, ...injected])];
}

export function resolveCliEffectiveEnabledPacks(args: {
  enabledPacks?: string[] | null;
  /** 新三态字段；存在时以它为准，缺失则回落 enabledPacks。 */
  skills?: Record<string, unknown> | null;
  declaredOnly?: boolean;
}): string[] {
  return resolveEffectiveEnabledPacks({
    enabledPacks: resolveAgentRequiredPackIds(args),
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
): string[] {
  const declaredOnly = shouldUseDeclaredOnlyLocalWorkspaceTools(env);
  const expanded = addDefaultLightWebToolsForConfiguredAgents(
    addDefaultCliCoreTools(
      canonicalizeToolNames(
        expandEnabledPacks(
          resolveCliEffectiveEnabledPacks({
            enabledPacks: (agentConfig as any)?.enabledPacks,
            skills: (agentConfig as any)?.skills,
            declaredOnly,
          }),
          resolveRequestedRuntimeToolNames({ agentConfig }),
        ),
      ),
      env,
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
  const afterDisabled = applyDisabledTools(
    filtered,
    (agentConfig as any)?.disabledTools,
  );
  // Agent-run isolation: dispatched subtasks (NOLO_AGENT_RUN_CHILD=1) lose
  // orchestration tools (startAgentRun/controlAgentRun/listAgents/... ) and
  // git write tools (gitAdd/gitCommit/gitCreateBranch/commitWorkspace). The
  // subtask keeps all "干活" tools + read-only git. Interactive runs unchanged.
  // Applied at the tool-NAME layer so the prepareTools cache key (built from
  // this final list) stays coherent across run kinds.
  return filterToolNamesForRunKind(afterDisabled, isSubtaskRun(env));
}

export function resolveProviderOpenAiToolBundle(
  agentConfig: AgentRuntimeAgentConfig,
  env: EnvLike,
  buildTools: typeof buildOpenAiTools = buildOpenAiTools,
  additionalToolNames: string[] = [],
) {
  const requestedToolNames = [
    ...new Set([
      ...resolveCliRequestedToolNames(agentConfig, env, null),
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
