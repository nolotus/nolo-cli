export function buildAgentRuntimeAgentLookupKeys(args: {
  agentRef: string;
  userId: string;
}) {
  if (/^(agent|cybot)(-pub)?-/.test(args.agentRef)) {
    return [args.agentRef];
  }
  return [
    `agent-${args.userId}-${args.agentRef}`,
    `cybot-${args.userId}-${args.agentRef}`,
  ];
}

export function shouldFetchAgentRuntimeRecordRemotely(dbKey: string) {
  return /^(agent|cybot)(-pub)?-/.test(dbKey);
}
