export function buildAgentRuntimeAgentLookupKeys(args: {
  agentRef: string;
  userId: string;
}) {
  return [
    args.agentRef,
    `agent-${args.userId}-${args.agentRef}`,
    `cybot-${args.userId}-${args.agentRef}`,
  ];
}

export function shouldFetchAgentRuntimeRecordRemotely(dbKey: string) {
  return /^(agent|cybot)(-pub)?-/.test(dbKey);
}
