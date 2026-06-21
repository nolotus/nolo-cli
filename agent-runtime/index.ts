export const AGENT_RUNTIME_PACKAGE_ID = "agent-runtime";

export type {
  ActionGate,
  ActionGateKind,
  ActionGateResult,
  CommandActionGatePayload,
  PermissionDecision,
  PermissionRequest,
} from "./actionGate";
export {
  readActionGate,
  readCommandActionGatePayload,
} from "./actionGate";
export { createRuntimeHostDescriptor } from "./hostAdapter";
export { runLocalAgentTurn } from "./localLoop";
export {
  pickAgentRuntimeInferenceOptions,
} from "./agentConfigOptions";
export {
  buildOpenAiCompatibleChatCompletionRequest,
  executeOpenAiCompatibleChatCompletion,
  parseOpenAiCompatibleChatCompletionResponse,
  readOpenAiCompatibleSseCompletion,
} from "./openAiCompatibleProvider";
export { resolveOpenAiCompatibleProviderConfig } from "./openAiCompatibleProviderConfig";
export {
  buildProviderAuthHeaders,
  buildProviderExecutionPlan,
  resolveAgentProviderMode,
  resolveAgentRuntimeLocation,
  resolveProviderTransportDecision,
} from "./providerResolution";
export {
  buildPlatformChatCompletionRequest,
  canUsePlatformChatProvider,
  hasDirectOpenAiCompatibleProvider,
  parsePlatformChatCompletionData,
  parsePlatformChatCompletionResponse,
  resolvePlatformChatProviderConfig,
  shouldUsePlatformChatProvider,
} from "./platformChatProvider";
export { resolveAgentRuntimeDecision } from "./runtimeDecision";
export { buildAgentRuntimeDecisionInput } from "./runtimeFacts";
export {
  buildAgentRuntimeAgentLookupKeys,
  shouldFetchAgentRuntimeRecordRemotely,
} from "./agentRecordKeys";
export {
  DEFAULT_AGENT_THREAD_MAX_CONCURRENT,
  decideAgentThreadAdmission,
  normalizeAgentThreadMaxConcurrent,
  resolveAgentThreadMaxConcurrent,
} from "./agentThreadAdmission";
export {
  AGENT_THREAD_ACTIVE_STATUSES,
  AGENT_THREAD_INDEX_PREFIX,
  AGENT_THREAD_KINDS,
  AGENT_THREAD_PRESENTATION_INTENTS,
  AGENT_THREAD_RECORD_PREFIX,
  AGENT_THREAD_STATUSES,
  AGENT_THREAD_TERMINAL_STATUSES,
  buildAgentThreadByAgentStatusIndexKey,
  buildAgentThreadByAgentStatusRange,
  buildAgentThreadKey,
  buildAgentThreadUserRange,
  buildChildAgentThreadRelations,
  getAgentThreadListSection,
  getAgentThreadRootId,
  isAgentThreadActiveStatus,
  isAgentThreadTerminalStatus,
  isFutureAgentThread,
} from "./agentThread";
export { resolveAgentRuntimeConfigFromRecord } from "./agentRecordConfig";
export { dialogMessageRecordToAgentRuntimeMessage } from "./dialogMessageRecord";
export { buildAgentRuntimeDialogWritePlan } from "./dialogWritePlan";
export {
  createHybridRecordStore,
  shouldCacheHybridRemoteRecord,
} from "./hybridRecordStore";
export {
  executeLocalToolWithPolicy,
  resolveLocalToolPolicy,
} from "./localToolPolicy";
export {
  evaluateShellCommandPolicy,
  isDestructiveShellCommand,
} from "./shellCommandPolicy";
export {
  mergeAgentRuntimeToolPolicies,
  normalizeAgentRuntimeToolPolicy,
  resolveCurrentRunRuntimeToolPolicy,
  resolveRequestedRuntimeToolNames,
  resolveEffectiveRuntimeToolPolicy,
  resolveLocalRuntimeEnvFromPolicy,
  resolveLocalWorkspaceExecutorOptionsFromPolicy,
} from "./runtimeToolPolicy";
export {
  DEFAULT_PRIVATE_NOLO_WORKSPACE_TOOLS,
  inferOwnerIdFromRuntimeAgentKey,
  isPublicRuntimeAgentRef,
  redactAgentRecordForWorkspaceTool,
  resolveRuntimeToolSurfaceForAgent,
  resolveRuntimeToolSurface,
} from "./runtimeToolSurface";
export {
  buildLocalWorkspaceOpenAiTools,
  buildLocalWorkspacePolicyToolNames,
  buildLocalWorkspaceToolset,
  createLocalWorkspaceToolExecutors,
} from "./localWorkspaceTools";
export {
  buildNoloWorkspaceCommandArgs,
  buildNoloWorkspaceCliToolExecutors,
  buildNoloWorkspaceOpenAiTools,
  buildNoloTableQueryRequest,
  clampNoloPositiveInteger,
  filterNoloWorkspaceToolNames,
  getNoloComparableUpdatedAt,
  getNoloDialogIdFromKey,
  getNoloSpaceContentKeys,
  isNoloWorkspaceToolName,
  noloPositiveIntegerString,
  noloStringArg,
  normalizeNoloDocReadArgs,
  normalizeNoloSpaceInput,
  NOLO_WORKSPACE_TOOL_NAMES,
  NOLO_WORKSPACE_TOOL_PROMPT,
  parseNoloWorkspaceToolArguments,
  resolveNoloDialogInput,
  runNoloWorkspaceCliTool,
} from "./noloWorkspaceTools";
export type {
  NoloWorkspaceToolName,
} from "./noloWorkspaceTools";
export type {
  AgentRuntimeAgentConfig,
  AgentRuntimeHostAdapter,
  AgentRuntimeProvider,
  AgentRuntimeSaveTurnInput,
  AgentRuntimeToolCallInput,
  AgentRuntimeToolResult,
} from "./hostAdapter";
export type {
  LocalAgentTurnInput,
  LocalAgentTurnResult,
} from "./localLoop";
export type {
  HybridRecordKvDb,
  HybridRecordStore,
} from "./hybridRecordStore";
export type {
  LocalToolPolicyDecision,
} from "./localToolPolicy";
export type {
  OpenAiCompatibleProviderConfig,
} from "./openAiCompatibleProvider";
export type {
  PlatformChatProviderConfig,
} from "./platformChatProvider";
export type {
  RuntimeToolSurfaceHost,
  RuntimeToolSurfaceForAgentInput,
  RuntimeToolSurfaceInput,
  RuntimeToolSurfaceResult,
  RuntimeToolSurfaceVisibility,
} from "./runtimeToolSurface";
export type {
  AgentThreadAdmissionAgentConfig,
  AgentThreadAdmissionConfig,
  AgentThreadAdmissionDecision,
} from "./agentThreadAdmission";
export type {
  AgentThread,
  AgentThreadActiveStatus,
  AgentThreadEvidence,
  AgentThreadKind,
  AgentThreadListSection,
  AgentThreadPresentationIntent,
  AgentThreadRuntimeCheckpoint,
  AgentThreadSchedule,
  AgentThreadStatus,
  AgentThreadSubjectRef,
  AgentThreadTerminalStatus,
} from "./agentThread";
export type {
  AgentRuntimeChatMessage,
  AgentRuntimeDecision,
  AgentRuntimeDecisionInput,
  AgentRuntimeHost,
  AgentRuntimeMessageContent,
  AgentRuntimeMode,
  AgentRuntimeRequestedMode,
  AgentRuntimeResult,
  AgentRuntimeToolPolicy,
  AgentRuntimeToolCall,
  AgentRuntimeWorkspaceMode,
} from "./types";
export * from "./externalTools";
