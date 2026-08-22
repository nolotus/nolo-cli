/**
 * Estimate the tokens a default CLI coding turn would send before any
 * provider usage report arrives (system layers + tool schemas).
 *
 * This is intentionally measured from the same builders the local runtime
 * uses — not a hardcoded floor — so the TUI context chip stays honest.
 */
import {
  BUILTIN_NOLO_AGENT_KEY,
  BUILTIN_NOLO_AGENT_MODEL,
  BUILTIN_NOLO_AGENT_NAME,
} from "../../core/builtinAgents";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveToolGuidedSections } from "../../ai/agent/toolGuidedSections";
import { estimateTokenCount } from "../../ai/context/tokenUtils";
import { prepareTools } from "../../ai/tools/prepareTools";
import { expandEnabledPacks } from "../../ai/tools/toolPacks";
import { buildCurrentTimeBlock } from "../../agent-runtime/currentTimeContext";
import { buildIdentityBlock } from "../../agent-runtime/identityBlock";
import { buildUserResponseLanguageContext } from "../../agent-runtime/userResponseLanguage";
import {
  buildLocalWorkspaceOpenAiTools,
  buildLocalWorkspaceToolset,
} from "../../agent-runtime/localWorkspaceTools";
import { buildRuntimeGuidanceBlocks } from "../../agent-runtime/runtimeGuidance";
import { buildSkillDiscoveryContextBlock } from "../../agent-runtime/skillDiscovery";
import { canonicalizeToolNames } from "../../agent-runtime/toolNameAliases";

/** Default CLI packs when an agent does not declare enabledPacks. */
const DEFAULT_CLI_PACKS = ["code", "agent-orchestration", "skills"] as const;

/** Default CLI light-web tools (ask_user 已移出默认面，不再计入估算)。 */
const DEFAULT_CLI_PLATFORM_TOOLS = [
  "exa_search",
  "fetchWebpage",
] as const;

/**
 * 估算用的兜底 prompt——**近似基线，不是默认档的真实 prompt**。
 *
 * 默认档现在是 nolo，它的 prompt 是一段更长的路由人格，存在 agent 记录里；
 * 而本函数是同步纯计算、不读记录。所以调用方没传 agentPrompt 时估算会偏低。
 * 拿得到真实 prompt 的调用方应该显式传 `agentPrompt`。
 */
const DEFAULT_PROMPT_ESTIMATE_BASELINE =
  "你是共享空间里的高性价比通用 AI 助手。优先快速、直接、稳定地完成任务；需要推理时保持步骤清晰。";

function readAgentsMd(cwd: string): string {
  for (const name of ["AGENTS.md", "agents.md"]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  }
  return "";
}

function estimateToolSchemas(toolNames: string[]): number {
  const toolset = buildLocalWorkspaceToolset({
    declaredToolNames: toolNames,
    exposeShellTools: true,
  });
  const workspaceTools = buildLocalWorkspaceOpenAiTools({
    toolNames: toolset.toolNames,
    exposeShellTools: true,
  });
  const platformNames = DEFAULT_CLI_PLATFORM_TOOLS.filter((name) =>
    toolNames.includes(name),
  );
  const platformTools =
    platformNames.length > 0 ? prepareTools([...platformNames]) : [];
  return estimateTokenCount(JSON.stringify([...workspaceTools, ...platformTools]));
}

/**
 * Estimate built-in context for the default CLI surface (flash tier).
 * Includes identity / guidance / time / AGENTS.md / skill index / tool schemas.
 */
export function estimateDefaultCliContextTokens(opts: {
  cwd?: string;
  agentName?: string;
  agentKey?: string;
  model?: string;
  agentPrompt?: string;
  userLanguage?: string;
} = {}): number {
  const cwd = opts.cwd?.trim() || process.cwd();
  // 兜底 = 默认档 nolo，全部从 builtinAgentCatalog 派生。这三行曾手抄
  // "deepseek-v4-flash" / "DeepSeek V4 Flash" / "agent-pub-deepseek-v4-flash"，
  // 前两个随换代过期，第三个还是早已废弃的历史别名（真 key 是确定性 seed id）。
  const model = opts.model?.trim() || BUILTIN_NOLO_AGENT_MODEL;
  const agentName = opts.agentName?.trim() || BUILTIN_NOLO_AGENT_NAME;
  const agentKey = opts.agentKey?.trim() || BUILTIN_NOLO_AGENT_KEY;
  const prompt = opts.agentPrompt?.trim() || DEFAULT_PROMPT_ESTIMATE_BASELINE;

  const packTools = canonicalizeToolNames(
    expandEnabledPacks([...DEFAULT_CLI_PACKS], []),
  );
  const toolNames = canonicalizeToolNames([
    ...packTools,
    ...DEFAULT_CLI_PLATFORM_TOOLS,
  ]);

  const guidance = buildRuntimeGuidanceBlocks(toolNames);
  // Same table the runtimes inject, so the estimate tracks the orchestration /
  // review-gate sections too.
  const toolSections = resolveToolGuidedSections(toolNames);
  const systemParts = [
    prompt,
    opts.userLanguage?.trim()
      ? buildUserResponseLanguageContext({ language: opts.userLanguage })
      : "",
    buildIdentityBlock({
      agentName,
      agentId: agentKey,
      model,
    }),
    guidance.startupProtocol,
    guidance.contextLayerContract,
    guidance.emailRegistrationWorkflow,
    guidance.webResearchToolPolicy,
    ...Object.values(toolSections),
    buildCurrentTimeBlock(new Date()),
    readAgentsMd(cwd),
    buildSkillDiscoveryContextBlock(cwd) ?? "",
  ];

  const systemTokens = estimateTokenCount(
    systemParts.filter((part) => part?.trim()).join("\n\n"),
  );
  const toolTokens = estimateToolSchemas(toolNames);
  return Math.max(0, systemTokens + toolTokens);
}

/** Estimate tokens for already-assembled chat messages (rough). */
export function estimateChatMessagesTokens(
  messages: Array<{ content?: unknown }>,
): number {
  if (!messages.length) return 0;
  const text = messages
    .map((message) => {
      const content = message.content;
      if (typeof content === "string") return content;
      if (content == null) return "";
      try {
        return JSON.stringify(content);
      } catch {
        return String(content);
      }
    })
    .join("\n");
  return estimateTokenCount(text);
}
