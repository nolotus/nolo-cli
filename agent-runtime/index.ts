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
export {
  createThinkParserState,
  extractThinkContent,
  flushThinkParser,
  processThinkChunk,
} from "./thinkTagParser";
export type { ThinkParseState } from "./thinkTagParser";
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
  createBrokerApiKeyRefResolver,
  resolveAgentProviderMode,
  resolveAgentRuntimeLocation,
  resolveCredentialFromBroker,
  resolveProviderTransportDecision,
} from "./providerResolution";
export type { CredentialBroker, CredentialRef } from "./credentialBroker";
export { assertCredentialRef } from "./credentialBroker";
export {
  createFileCredentialBroker,
  getApiKeyCredentialPath,
  getApiKeyCredentialsDir,
} from "./fileCredentialBroker";
export {
  createDefaultSecurityRunner,
  createMacOsKeychainCredentialBroker,
  credentialRefToMacOsKeychainService,
  MACOS_KEYCHAIN_ACCOUNT,
  MACOS_KEYCHAIN_SERVICE_PREFIX,
  SECURITY_ITEM_NOT_FOUND_EXIT,
} from "./macOsKeychainCredentialBroker";
export type {
  CreateMacOsKeychainCredentialBrokerOptions,
  SecurityRunner,
  SecurityRunnerResult,
} from "./macOsKeychainCredentialBroker";
export {
  buildWindowsCredentialPowerShellArgs,
  createDefaultWindowsCredentialRunner,
  createWindowsCredentialManagerBroker,
  credentialRefToWindowsCredentialTarget,
  WIN_ERROR_NOT_FOUND,
  WINDOWS_CREDENTIAL_MANAGER_SCRIPT,
  WINDOWS_CREDENTIAL_TARGET_PREFIX,
  WINDOWS_CREDENTIAL_USERNAME,
} from "./windowsCredentialManagerBroker";
export type {
  CreateWindowsCredentialManagerBrokerOptions,
  WindowsCredentialRunner,
  WindowsCredentialRunnerResult,
} from "./windowsCredentialManagerBroker";
export { createDesktopHostCredentialBroker } from "./desktopHostCredentialBroker";
export type {
  CreateDesktopHostCredentialBrokerOptions,
  DesktopCredentialStoreMode,
} from "./desktopHostCredentialBroker";
export {
  createFileSourceRegistry,
  getSourceRegistryPath,
} from "./sourceRegistry";
export type {
  SourceKind,
  SourceRecord,
  SourceRegistry,
  SourceStatus,
} from "./sourceRegistry";
export {
  applyAgentSecretMigrationUpdates,
  buildAgentApiKeyCredentialRef,
  migrateAgentSecrets,
} from "./migrateAgentSecrets";
export type {
  AgentSecretFields,
  AgentSecretMigrationResult,
  AgentSecretMigrationUpdates,
  CredentialMigrationStatus,
} from "./migrateAgentSecrets";
export {
  buildPlatformChatCompletionRequest,
  canUsePlatformChatProvider,
  executePlatformChatCompletion,
  executePlatformChatCompletionWithFallback,
  hasDirectOpenAiCompatibleProvider,
  parsePlatformChatCompletionData,
  parsePlatformChatCompletionResponse,
  readPlatformChatSseCompletion,
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
export {
  agentRuntimeConfigFromDesktopSnapshot,
  assertDesktopAgentRuntimeTurnBodyHasNoRawSecrets,
  buildDesktopAgentRuntimeAgentConfigSnapshot,
  buildDesktopAgentRuntimeDialogHistorySnapshot,
  isDesktopSnapshotSensitivePropertyName,
  parseDesktopAgentRuntimeAgentConfigSnapshot,
  parseDesktopAgentRuntimeDialogHistorySnapshot,
  redactSensitiveJsonTree,
  sanitizeToolCallArguments,
  DESKTOP_AGENT_CONFIG_SNAPSHOT_FORBIDDEN_KEYS,
  DESKTOP_AGENT_CONFIG_SNAPSHOT_STRING_FIELDS,
  DESKTOP_TOOL_CALL_ARGUMENTS_MAX_CHARS,
} from "./desktopRequestSnapshot";
export type {
  DesktopAgentRuntimeAgentConfigSnapshot,
  DesktopAgentRuntimeDialogHistorySnapshot,
} from "./desktopRequestSnapshot";
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

export {
  assertCloudGrantAllowed,
  createCloudCredentialGrant,
  uploadCloudCredentialGrant,
} from "./cloudCredentialGrant";
export type {
  CloudCredentialGrant,
  CloudCredentialGrantStatus,
  AssertCloudGrantAllowedInput,
  CreateCloudCredentialGrantInput,
} from "./cloudCredentialGrant";
