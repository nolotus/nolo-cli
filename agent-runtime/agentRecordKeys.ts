/**
 * Build candidate dbKeys for an agentRef (alias/handle/id).
 *
 * If the ref already looks like a concrete agent key (starts with "agent-" or
 * "agent-pub-"), return it as-is — caller asked for a specific record.
 *
 * Otherwise, treat the ref as an alias and return both the user-scoped
 * private key and the public key, matching the resolution order in
 * noloWorkspaceServerTools.readAgent:
 *   1. agent-{userId}-{ref}  (private alias)
 *   2. agent-pub-{ref}       (public alias)
 *
 * Previously this only returned the private candidate, causing startAgentRun to
 * miss public agents that the readAgent tool could find — an inconsistency
 * between the two agent lookup paths.
 */
export function buildAgentRuntimeAgentLookupKeys(args: {
  agentRef: string;
  userId: string;
}) {
  if (/^agent(-pub)?-/.test(args.agentRef)) {
    return [args.agentRef];
  }
  return [`agent-${args.userId}-${args.agentRef}`, `agent-pub-${args.agentRef}`];
}

export function shouldFetchAgentRuntimeRecordRemotely(dbKey: string) {
  return /^agent(-pub)?-/.test(dbKey);
}
