import { canonicalizeToolNames } from "../tools/toolNameAliases";
import { buildContextLayerContractBlock } from "./contextLayerContract";
import { buildStartupProtocolBlock } from "./startupProtocol";

export type RuntimeGuidanceToolOptions = {
  hasCheckEnvTool: boolean;
  hasExecShellTool: boolean;
  hasRememberMemoryTool: boolean;
  hasDocTools: boolean;
  hasBrowserTools: boolean;
  hasEmailRegistrationTools: boolean;
  hasEmailRegistrationWorkflow: boolean;
};

const normalizeToolName = (name: string): string =>
  name.replace(/[-_]/g, "").toLowerCase();

const hasAnyTool = (normalizedTools: Set<string>, candidates: string[]): boolean =>
  candidates.some((candidate) => normalizedTools.has(normalizeToolName(candidate)));

const hasAllTools = (normalizedTools: Set<string>, candidates: string[]): boolean =>
  candidates.every((candidate) => normalizedTools.has(normalizeToolName(candidate)));

const buildEmailRegistrationWorkflowBlock = (
  enabled: boolean
): string => {
  if (!enabled) return "";

  return [
    "--- 邮箱验证码注册流程 ---",
    "当用户要求你注册网站账号时，只允许处理用户明确指定的当前目标网站，不要自行扩展到其他网站、批量注册或规避平台风控。",
    "",
    "分阶段协议：discover before acting -> assess supportability -> register -> verify -> closeout。",
    "",
    "推荐流程：",
    "1. discover before acting：先用 browser_openSession / browser_readContent 阅读页面，确认目标注册页 URL、账号用途、必填项和停止条件；不要一打开页面就盲点按钮。如果缺少目标网站，先询问用户。",
    "2. assess supportability：先判断该流程是否支持当前受控自动化。遇到 CAPTCHA、手机号验证、支付、身份/KYC、OAuth-only、服务条款确认、或任何看起来像规避风控的步骤时，必须立即停止并向用户说明 blockingReason；不要硬闯。",
    "3. register：只有在确认支持后，才使用 email_provision_identity 为当前 agent 生成受控域名邮箱身份，再使用 browser_openSession / browser_typeText / browser_click / browser_readContent 填写并提交注册表单。",
    "4. verify：提交后使用 email_wait_for 等待该 agent 收件箱里的验证邮件，再用 email_extract_verification 提取验证码或验证链接，回填验证码或打开验证链接完成验证。",
    "5. closeout：无论成功还是失败都要 always close sessions，主动清理浏览器会话（例如 browser_closeSession）。如果流程失败，必须明确 failedStage 与 blockingReason，并说明可恢复选项；不要盲目尝试无关网站或绕过验证。",
    "6. 最终只在对话中返回账号、邮箱和一次性生成的密码；不要持久化密码，不要写入 agent metadata、数据库、文档或记忆。",
    "",
    "必须暂停并询问用户的情况：CAPTCHA、手机号验证、支付、身份/KYC、OAuth 授权、OAuth-only、服务条款确认、或任何看起来像规避风控的步骤。",
    "如果流程失败，说明 failedStage、blockingReason 和可恢复选项，不要盲目尝试无关网站或绕过验证。",
  ].join("\n");
};

const buildWebResearchToolPolicyBlock = (
  hasExecShellTool: boolean,
  hasFetchWebpageTool: boolean
): string => {
  if (!hasExecShellTool || !hasFetchWebpageTool) return "";

  return [
    "--- 生产环境网页研究工具策略 ---",
    "生产环境网页研究优先使用 fetchWebpage、站点 Markdown / llms.txt、或专用浏览/搜索工具。",
    "不要用 execShell 调 curl、grep、sed 等命令抓网页或截取网页段落；生产环境通常会禁用 dev shell，反复尝试只会浪费回合。",
    "如果网页内容过长或锚点段落没有被单独提取，先寻找该文档站提供的 Markdown 版本、独立页面、llms.txt 索引或更具体 URL，再继续回答。",
  ].join("\n");
};

export const resolveRuntimeGuidanceToolOptions = (
  tools: string[] = []
): RuntimeGuidanceToolOptions => {
  const normalizedTools = canonicalizeToolNames(tools);
  const normalizedToolSet = new Set(normalizedTools.map(normalizeToolName));
  const hasBrowserTools = hasAllTools(normalizedToolSet, [
    "browser_openSession",
    "browser_readContent",
    "browser_typeText",
    "browser_click",
    "browser_closeSession",
  ]);
  const hasBrowserProbe = hasAnyTool(normalizedToolSet, ["browser_probePage", "browserProbePage"]);
  const hasEmailRegistrationTools = hasAllTools(normalizedToolSet, [
    "email_provision_identity",
    "email_wait_for",
    "email_extract_verification",
  ]);

  return {
    hasCheckEnvTool: normalizedTools.includes("checkEnv"),
    hasExecShellTool: normalizedTools.includes("execShell"),
    hasRememberMemoryTool: normalizedTools.includes("rememberMemory"),
    hasDocTools: normalizedTools.some((tool) =>
      ["read", "readDoc", "readPage", "createDoc", "updateDoc"].includes(tool)
    ),
    hasBrowserTools,
    hasEmailRegistrationTools,
    // Require browser_probePage to be present before enabling email registration workflow guidance.
    hasEmailRegistrationWorkflow: hasBrowserTools && hasBrowserProbe && hasEmailRegistrationTools,
  };
};

export const buildRuntimeGuidanceBlocks = (tools: string[] = []) => {
  const options = resolveRuntimeGuidanceToolOptions(tools);
  const normalizedTools = canonicalizeToolNames(tools);

  return {
    startupProtocol: buildStartupProtocolBlock({
      hasCheckEnvTool: options.hasCheckEnvTool,
      hasExecShellTool: options.hasExecShellTool,
    }),
    contextLayerContract: buildContextLayerContractBlock({
      hasRememberMemoryTool: options.hasRememberMemoryTool,
      hasDocTools: options.hasDocTools,
    }),
    emailRegistrationWorkflow: buildEmailRegistrationWorkflowBlock(
      options.hasEmailRegistrationWorkflow
    ),
    webResearchToolPolicy: buildWebResearchToolPolicyBlock(
      options.hasExecShellTool,
      normalizedTools.includes("fetchWebpage")
    ),
  };
};
