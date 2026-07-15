export function buildAgentRuntimeAgentLookupKeys(args: {
  agentRef: string;
  userId: string;
}) {
  if (/^agent(-pub)?-/.test(args.agentRef)) {
    return [args.agentRef];
  }
  return [`agent-${args.userId}-${args.agentRef}`];
}

export function shouldFetchAgentRuntimeRecordRemotely(dbKey: string) {
  return /^agent(-pub)?-/.test(dbKey);
}
