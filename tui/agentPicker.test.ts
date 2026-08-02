import { describe, expect, test } from "bun:test";

import { PLATFORM_AGENTS, type AgentCatalogEntry } from "./agentCatalog";
import { resolveAgentSwitchTarget } from "./agentPicker";

function mergeCatalogEntriesForTest(
  currentKey: string,
  platformAgents: AgentCatalogEntry[],
  privateAgents: AgentCatalogEntry[]
) {
  const seen = new Set<string>();
  const merged: AgentCatalogEntry[] = [];
  const push = (entry: AgentCatalogEntry) => {
    if (seen.has(entry.key)) return;
    seen.add(entry.key);
    merged.push(entry);
  };
  const current =
    [...platformAgents, ...privateAgents].find((entry) => entry.key === currentKey) ??
    null;
  if (current) push(current);
  for (const entry of platformAgents) {
    if (entry.key !== currentKey) push(entry);
  }
  for (const entry of privateAgents) {
    if (entry.key !== currentKey) push(entry);
  }
  return merged;
}

describe("agentPicker", () => {
  test("resolves aliases and numeric catalog entries", () => {
    const catalog: AgentCatalogEntry[] = [
      ...PLATFORM_AGENTS,
      {
        name: "MiniMax M3",
        key: "agent-0e95801d90-minimax-m3",
        model: "MiniMax-M3",
        kind: "private",
      },
    ];

    expect(resolveAgentSwitchTarget("minimax-m3", catalog)).toEqual({
      name: "MiniMax M3",
      key: "agent-0e95801d90-minimax-m3",
    });
    expect(resolveAgentSwitchTarget("2", catalog)?.key).toBe(PLATFORM_AGENTS[1].key);
  });

  test("keeps the current agent first when merging catalog entries", () => {
    const merged = mergeCatalogEntriesForTest(
      "agent-0e95801d90-minimax-m3",
      PLATFORM_AGENTS,
      [
        {
          name: "MiniMax M3",
          key: "agent-0e95801d90-minimax-m3",
          model: "MiniMax-M3",
          kind: "private",
        },
      ]
    );

    expect(merged[0]?.key).toBe("agent-0e95801d90-minimax-m3");
    expect(merged.some((entry) => entry.key === PLATFORM_AGENTS[0].key)).toBe(true);
  });
});