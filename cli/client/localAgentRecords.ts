import {
  buildAgentRuntimeAgentLookupKeys,
  shouldFetchAgentRuntimeRecordRemotely,
} from "../agentRuntimeLocal";

export const buildLocalAgentLookupKeys = buildAgentRuntimeAgentLookupKeys;
export const shouldReadAgentKeyRemotely = shouldFetchAgentRuntimeRecordRemotely;
