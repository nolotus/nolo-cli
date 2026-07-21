import { describe, expect, it } from "bun:test";
import {
  formatAgentSourceLabel,
  invalidateAgentCatalogCache,
  loadAgentCatalog,
  mergeCatalogEntries,
  type AgentCatalogEntry,
} from "./agentCatalog";
import type { CliFetchImpl } from "../cliFetch";

const platform = (name: string, key: string): AgentCatalogEntry => ({
  name,
  key,
  model: "-",
  kind: "platform",
});

const privateAgent = (
  name: string,
  key: string,
  updatedAt = 0,
): AgentCatalogEntry => ({
  name,
  key,
  model: "glm-5.2",
  kind: "private",
  updatedAt,
});

describe("mergeCatalogEntries favorites ordering", () => {
  it("puts favorited private agents before non-favorites, favoritedAt desc", () => {
    const merged = mergeCatalogEntries(
      "agent-pub-default",
      [platform("auto", "agent-pub-default")],
      [
        privateAgent("older-fav", "agent-fav-old", 100),
        privateAgent("plain-new", "agent-plain-new", 999),
        privateAgent("newer-fav", "agent-fav-new", 50),
        privateAgent("plain-old", "agent-plain-old", 1),
      ],
      { "agent-fav-old": 1000, "agent-fav-new": 2000 },
    );

    expect(merged.map((entry) => entry.name)).toEqual([
      "auto",
      "newer-fav",
      "older-fav",
      "plain-new",
      "plain-old",
    ]);
  });

  it("marks favoritedAt on entries and leaves others untouched", () => {
    const merged = mergeCatalogEntries(
      "agent-pub-default",
      [platform("auto", "agent-pub-default")],
      [privateAgent("fav", "agent-fav"), privateAgent("plain", "agent-plain")],
      { "agent-fav": 1234 },
    );

    const fav = merged.find((entry) => entry.key === "agent-fav");
    const plain = merged.find((entry) => entry.key === "agent-plain");
    expect(fav?.favoritedAt).toBe(1234);
    expect(plain?.favoritedAt).toBeUndefined();
  });

  it("keeps the current agent first and platform agents before private ones", () => {
    const merged = mergeCatalogEntries(
      "agent-fav",
      [platform("auto", "agent-pub-default")],
      [privateAgent("fav", "agent-fav"), privateAgent("plain", "agent-plain")],
      { "agent-fav": 1, "agent-plain": 2 },
    );

    expect(merged.map((entry) => entry.key)).toEqual([
      "agent-fav",
      "agent-pub-default",
      "agent-plain",
    ]);
  });

  it("dedupes entries sharing the same key", () => {
    const merged = mergeCatalogEntries(
      "",
      [platform("auto", "agent-pub-default"), platform("nolo", "agent-pub-default")],
      [],
    );
    expect(merged).toHaveLength(1);
  });
});

describe("formatAgentSourceLabel", () => {
  it("labels platform / custom api / cli subscription", () => {
    expect(formatAgentSourceLabel(platform("auto", "k1"))).toBe("平台");
    expect(
      formatAgentSourceLabel({ ...privateAgent("a", "k2"), apiSource: "platform" }),
    ).toBe("平台");
    expect(
      formatAgentSourceLabel({ ...privateAgent("b", "k3"), apiSource: "custom" }),
    ).toBe("API");
    expect(
      formatAgentSourceLabel({ ...privateAgent("c", "k4"), apiSource: "cli" }),
    ).toBe("订阅");
    expect(
      formatAgentSourceLabel({
        ...privateAgent("d", "k5"),
        apiSource: "cli",
        cliProvider: "codex",
      }),
    ).toBe("订阅(codex)");
    // 未标注 apiSource 的 agent 默认按平台展示
    expect(formatAgentSourceLabel(privateAgent("e", "k6"))).toBe("平台");
  });
});

describe("loadAgentCatalog caching (SWR)", () => {
  const token = `h.${Buffer.from('{"userId":"u1"}').toString("base64")}.s`;
  const env = { AUTH_TOKEN: token, NOLO_SERVER: "https://s.test" };

  const makeFetch = () => {
    let queryCount = 0;
    const fetchImpl: CliFetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/rpc/listFavorites")) {
        return new Response(JSON.stringify({ items: [] }));
      }
      queryCount++;
      return new Response(JSON.stringify({ data: [] }));
    };
    return { fetchImpl, getQueryCount: () => queryCount };
  };

  it("serves the cache within the fresh window and refetches after invalidation", async () => {
    invalidateAgentCatalogCache();
    const { fetchImpl, getQueryCount } = makeFetch();

    const first = await loadAgentCatalog({ env, currentKey: "", fetchImpl });
    expect(first.length).toBeGreaterThan(0);
    const afterFirst = getQueryCount();
    expect(afterFirst).toBeGreaterThan(0);

    // 新鲜窗口内：直接命中缓存，不再请求
    const second = await loadAgentCatalog({ env, currentKey: "", fetchImpl });
    expect(second).toEqual(first);
    expect(getQueryCount()).toBe(afterFirst);

    // 失效后重新拉取
    invalidateAgentCatalogCache();
    await loadAgentCatalog({ env, currentKey: "", fetchImpl });
    expect(getQueryCount()).toBeGreaterThan(afterFirst);
  });
});
