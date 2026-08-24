/**
 * 每条 transport 分支解析 provider 时共享的上下文。
 *
 * 背景：`createCliLocalRuntimeAdapter` 的 `resolveProviderBase` 曾是一个 940 行、
 * 内含 8 条 transport 分支的巨型闭包，分支之间靠闭包变量隐式耦合，新增/删除一条
 * 通道必须在这堆嵌套里定位。现在每条分支是 `providerResolution/` 下的独立模块，
 * 统一接收本上下文——依赖变成显式入参，分支可单独阅读、单独测试、单独删除。
 *
 * 约定：本类型只装**分支之间真正共享**的东西。某条分支独有的输入放它自己的
 * 参数里，不要往这里堆。
 */
import type { AgentRuntimeAgentConfig, AgentRuntimeProvider } from "../../agent-runtime";
import type { CliFetchImpl } from "../../cliFetch";
import { createFileCredentialBroker } from "../../agent-runtime/fileCredentialBroker";
import { createOAuthApiKeyRefResolver } from "../../oauth/apiKeyRefResolver";
import { buildOpenAiTools } from "../localRuntimeTools";
import type { CliLocalRuntimeAdapterDeps } from "../localRuntimeDiagnostics";

/** 把一次上游 HTTP 结果的可用性结论落到本地 agent 记录（429 冷却 / 恢复）。 */
export type RecordLocalAvailability = (status: number, body?: unknown) => Promise<void>;

/** 本地工具执行器表；Cursor 通道要把它接进自己的工具循环。 */
export type LocalToolExecutors = Record<
  string,
  (call: any) => Promise<{ content: string; metadata?: Record<string, unknown> }>
>;

export interface ProviderResolutionContext {
  /** 本次要解析的 agent 配置。 */
  agentConfig: AgentRuntimeAgentConfig;
  /** adapter 工厂的原始 deps（env / output / sleep / store 等）。 */
  deps: CliLocalRuntimeAdapterDeps;
  fetchImpl: CliFetchImpl;
  /** 指向本机 runtime 的回环请求，用于瞬时重试与凭证换取。 */
  loopbackRequest: Parameters<typeof fetch> extends never ? never : any;
  /** 单调时钟入口（测试可注入）。 */
  now: () => number;
  workspaceRoot: string;
  /** 除 agent 声明外额外注入的工具名（如 readPastedText）。 */
  additionalToolNames: string[];
  /** 本轮 agent 实际启用的工具名，由 loadAgentConfig 阶段算好。 */
  activeAgentToolNames: string[];
  localToolExecutors: LocalToolExecutors;
  buildProviderOpenAiTools: typeof buildOpenAiTools;
  recordLocalAvailability: RecordLocalAvailability;
  apiKeyRefResolver: ReturnType<typeof createOAuthApiKeyRefResolver>;
  credentialBroker: ReturnType<typeof createFileCredentialBroker>;
  /** 当前 nolo server origin。 */
  serverUrl: string;
  /** 本地登录态；无则 syncFetcher 为 undefined。 */
  authToken: string | undefined;
  /** 从 server 拉取同步凭证；无 AUTH_TOKEN 时为 undefined。 */
  syncFetcher: ((ref: string) => Promise<string | null>) | undefined;
}

/**
 * 一条 transport 分支：命中则返回 provider，未命中返回 null 交给下一条。
 * 顺序敏感（OAuth 专用通道必须先于通用 OpenAI-compatible 兜底），
 * 顺序由 `resolveLocalProvider` 的数组字面量表达，不要散落到各模块里。
 */
export type ProviderResolver = (
  ctx: ProviderResolutionContext,
) => Promise<AgentRuntimeProvider | null>;
