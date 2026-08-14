/**
 * Estimate the tokens a default CLI coding turn would send before any
 * provider usage report arrives (system layers + tool schemas).
 *
 * This is intentionally measured from the same builders the local runtime
 * uses — not a hardcoded floor — so the TUI context chip stays honest.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokenCount } from "../../ai/context/tokenUtils";
import { prepareTools } from "../../ai/tools/prepareTools";
import { expandEnabledPacks } from "../../ai/tools/toolPacks";
import { buildCurrentTimeBlock } from "../../agent-runtime/currentTimeContext";
import { buildIdentityBlock } from "../../agent-runtime/identityBlock";
import {
  buildLocalWorkspaceOpenAiTools,
  buildLocalWorkspaceToolset,
} from "../../agent-runtime/localWorkspaceTools";
import { buildRuntimeGuidanceBlocks } from "../../agent-runtime/runtimeGuidance";
import { buildSkillDiscoveryContextBlock } from "../../agent-runtime/skillDiscovery";
import { canonicalizeToolNames } from "../../agent-runtime/toolNameAliases";

/** Default CLI packs when an agent does not declare enabledPacks. */
const DEFAULT_CLI_PACKS = ["code", "agent-orchestration", "skills"] as const;

/** Forced / default CLI interaction + light-web tools. */
const DEFAULT_CLI_PLATFORM_TOOLS = [
  "ask_user",
  "exa_search",
  "fetchWebpage",
] as const;

const DEFAULT_FLASH_PROMPT =
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
 * Estimate built-in context for the default auto→flash CLI surface.
 * Includes identity / guidance / time / AGENTS.md / skill index / tool schemas.
 */
export function estimateDefaultCliContextTokens(opts: {
  cwd?: string;
  agentName?: string;
  agentKey?: string;
  model?: string;
  agentPrompt?: string;
} = {}): number {
  const cwd = opts.cwd?.trim() || process.cwd();
  const model = opts.model?.trim() || "deepseek-v4-flash";
  const agentName = opts.agentName?.trim() || "DeepSeek V4 Flash";
  const agentKey = opts.agentKey?.trim() || "agent-pub-deepseek-v4-flash";
  const prompt = opts.agentPrompt?.trim() || DEFAULT_FLASH_PROMPT;

  const packTools = canonicalizeToolNames(
    expandEnabledPacks([...DEFAULT_CLI_PACKS], []),
  );
  const toolNames = canonicalizeToolNames([
    ...packTools,
    ...DEFAULT_CLI_PLATFORM_TOOLS,
  ]);

  const guidance = buildRuntimeGuidanceBlocks(toolNames);
  const systemParts = [
    prompt,
    buildIdentityBlock({
      agentName,
      agentId: agentKey,
      model,
    }),
    guidance.startupProtocol,
    guidance.contextLayerContract,
    guidance.emailRegistrationWorkflow,
    guidance.webResearchToolPolicy,
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
