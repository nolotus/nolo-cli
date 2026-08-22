import { describe, expect, it } from "bun:test";
import {
  DEFAULT_TUI_AGENT_KEY,
  resolveCatalogPlatformAgents,
  formatAgentSourceLabel,
  invalidateAgentCatalogCache,
  loadAgentCatalog,
  mergeCatalogEntries,
  prefillCatalogFromLocalDb,
  prefetchAgentCatalog,
  type AgentCatalogEntry,
} from "./agentCatalog";
import type { CliFetchImpl } from "../cliFetch";
import { BUILTIN_NOLO_AGENT_KEY } from "../core/builtinAgents";
import { setCliLocale } from "./i18n";

setCliLocale("zh");

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

describe("TUI platform catalog", () => {
  it("shows nolo by default (no synthetic auto tier entry)", () => {
    expect(resolveCatalogPlatformAgents({} as Record<string, string | undefined>)[0]?.name).toBe("nolo");
    expect(resolveCatalogPlatformAgents({ NOLO_AUTO_ROUTE: "0" })[0]?.name).toBe("nolo");
    expect(resolveCatalogPlatformAgents({} as Record<string, string | undefined>)).toHaveLength(1);
  });
});

describe("TUI default agent", () => {
  it("uses the canonical Nolo key as the implicit fallback", () => {
    expect(DEFAULT_TUI_AGENT_KEY).toBe(BUILTIN_NOLO_AGENT_KEY);
  });
});

describe("mergeCatalogEntries favorites ordering", () => {
  it("shows auto and all owned agents, with favorites first", () => {
    const merged = mergeCatalogEntries(
      "agent-pub-default",
      [platform("auto", DEFAULT_TUI_AGENT_KEY)],
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

  it("keeps non-favorited owned entries", () => {
    const merged = mergeCatalogEntries(
      "agent-pub-default",
      [platform("auto", DEFAULT_TUI_AGENT_KEY)],
      [privateAgent("fav", "agent-fav"), privateAgent("plain", "agent-plain")],
      { "agent-fav": 1234 },
    );

    const fav = merged.find((entry) => entry.key === "agent-fav");
    const plain = merged.find((entry) => entry.key === "agent-plain");
    expect(fav?.favoritedAt).toBe(1234);
    expect(plain?.favoritedAt).toBeUndefined();
  });

  it("keeps the current agent first and excludes unselected entries", () => {
    const merged = mergeCatalogEntries(
      "agent-fav",
      [],
      [privateAgent("fav", "agent-fav"), privateAgent("plain", "agent-plain")],
      { "agent-fav": 1, "agent-plain": 2 },
    );

    expect(merged.map((entry) => entry.key)).toEqual([
      "agent-fav",
      "agent-plain",
    ]);
  });

  it("keeps the current agent first", () => {
    const merged = mergeCatalogEntries(
      "agent-current",
      [],
      [privateAgent("current", "agent-current"), privateAgent("plain", "agent-plain")],
      {},
    );

    expect(merged.map((entry) => entry.key)).toEqual(["agent-current", "agent-plain"]);
  });

  it("dedupes duplicate favorited entries sharing the same key", () => {
    const merged = mergeCatalogEntries(
      "",
      [],
      [
        privateAgent("first", "agent-duplicate"),
        privateAgent("second", "agent-duplicate"),
      ],
      { "agent-duplicate": 1234 },
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe("first");
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
    expect(first.length).toBe(1);
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

describe("favorites-only switcher cache behavior", () => {
  const token = `h.${Buffer.from('{"userId":"u1"}').toString("base64")}.s`;
  const env = { AUTH_TOKEN: token, NOLO_SERVER: "https://s.test" };

  /** Fake DB whose iterator yields the given [key, value] pairs. */
  function makeFakeDb(pairs: [string, Record<string, unknown>][]) {
    return {
      iterator: () => ({
        async *[Symbol.asyncIterator]() {
          for (const pair of pairs) yield pair;
        },
      }),
    };
  }

  it("does not prefill the favorites-only switcher from local DB", async () => {
    invalidateAgentCatalogCache();

    const fakeDb = makeFakeDb([
      ["agent-u1-cached", { name: "cached-agent", model: "test-model", userId: "u1" }],
    ]);

    // The server response is intentionally immediate; a local prefill must not
    // make this test depend on cached, non-authoritative favorite state.
    let queryCount = 0;
    const fetchImpl: CliFetchImpl = async () => {
      queryCount++;
      return new Response(JSON.stringify({ data: [] }));
    };

    // Local DB data has no authoritative favorite metadata, so it must not seed
    // the switcher. The server response is the source of truth.
    await prefillCatalogFromLocalDb({ env, getDb: async () => fakeDb });
    const entries = await loadAgentCatalog({ env, currentKey: "", fetchImpl });

    expect(entries.some((e) => e.key === "agent-u1-cached")).toBe(false);
    expect(queryCount).toBeGreaterThan(0);
    invalidateAgentCatalogCache();
  });

  it("falls back gracefully when local DB is empty (no prefill, network fetch proceeds)", async () => {
    invalidateAgentCatalogCache();

    const fakeDb = makeFakeDb([]);

    let queryCount = 0;
    const fetchImpl: CliFetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/rpc/listFavorites")) {
        return new Response(JSON.stringify({ items: [] }));
      }
      queryCount++;
      return new Response(JSON.stringify({ data: [] }));
    };

    // Prefill finds no local agents → cache stays empty
    await prefillCatalogFromLocalDb({ env, getDb: async () => fakeDb });

    // loadAgentCatalog must do a foreground fetch
    const entries = await loadAgentCatalog({ env, currentKey: "", fetchImpl });
    expect(queryCount).toBeGreaterThan(0);
    expect(entries.length).toBe(1); // auto is always available
    invalidateAgentCatalogCache();
  });

  it("prefetchAgentCatalog does not throw (smoke test)", async () => {
    invalidateAgentCatalogCache();
    // Just verify it doesn't throw — the full async flow is tested above
    prefetchAgentCatalog({ env });
    invalidateAgentCatalogCache();
  });
});

describe("loadAgentCatalog orphan favorite hydrate", () => {
  const token = `h.${Buffer.from('{"userId":"u1"}').toString("base64")}.s`;
  const env = { AUTH_TOKEN: token, NOLO_SERVER: "https://s.test" };

  /** 收藏项里使用的 orphan key：不归当前用户所有，listRemoteAgents 不会返回它。 */
  const orphanKey = "agent-pub-ORPHANFAV000000000001";

  /** 服务端单条记录读取应返回的 orphan agent 原始记录。 */
  const orphanRecord = {
    dbKey: orphanKey,
    id: "ORPHANFAV000000000001",
    userId: "other-user",
    name: "orphan-fav-agent",
    model: "glm-5.2",
    type: "agent",
  };

  /**
   * fetch mock：
   * - /rpc/listFavorites 返回一个只含 orphan key 的收藏，模拟「收藏了别人/公开 agent」。
   * - query 用户自有记录（/api/v1/db/query/）返回空，确保 orphan 走 hydrate 路径。
   * - 单条读取（/api/v1/db/read/<key>）按 dbKey 返回对应记录。
   */
  function makeFetch(records: Record<string, any> = { [orphanKey]: orphanRecord }): CliFetchImpl {
    return async (input) => {
      const url = String(input);
      if (url.includes("/rpc/listFavorites")) {
        return new Response(JSON.stringify({ items: [{ id: orphanKey, favoritedAt: 5000 }] }));
      }
      if (url.includes("/api/v1/db/query/")) {
        return new Response(JSON.stringify({ data: { data: [] } }));
      }
      if (url.includes("/api/v1/db/read/")) {
        const key = decodeURIComponent(url.split("/api/v1/db/read/")[1].split("?")[0]);
        const record = records[key];
        if (!record) throw new Error(`read failed: HTTP 404 {"error":"not found"}`);
        return new Response(JSON.stringify({ data: record }));
      }
      return new Response(JSON.stringify({ data: [] }));
    };
  }

  it("hydrates orphan favorite (not in listRemoteAgents) into the catalog with ★", async () => {
    invalidateAgentCatalogCache();
    const entries = await loadAgentCatalog({
      env,
      currentKey: "",
      fetchImpl: makeFetch(),
    });

    const orphan = entries.find((entry) => entry.key === orphanKey);
    expect(orphan).toBeDefined();
    expect(orphan?.name).toBe("orphan-fav-agent");
    // mergeCatalogEntries 会用 favoritedAtByKey 给已存在 entry 打 ★，孤儿 entry 也带收藏时间戳
    expect(orphan?.favoritedAt).toBe(5000);
    invalidateAgentCatalogCache();
  });

  it("skips an orphan favorite whose record read fails (silent, no throw)", async () => {
    invalidateAgentCatalogCache();
    // 读取时服务端 404 → readLiveDbRecordAfterTombstoneMerge 抛错 → 静默跳过
    const fetchImpl = makeFetch({});
    const entries = await loadAgentCatalog({
      env,
      currentKey: "",
      fetchImpl,
    });

    expect(entries.find((entry) => entry.key === orphanKey)).toBeUndefined();
    // 不应抛错：空的收藏目录仍然合法
    expect(entries.length).toBe(1);
    invalidateAgentCatalogCache();
  });

  it("does not duplicate a self-owned public agent favorited by its publicKey", async () => {
    invalidateAgentCatalogCache();
    // 自有 public agent：listRemoteAgents 返回它（key=agent-u1-AGENT1），其 publicKey=agent-pub-AGENT1。
    // 用户同时收藏了它的 publicKey 形态（agent-pub-AGENT1）→ 三键去重应命中，不重复 hydrate。
    const selfRecord = {
      dbKey: "agent-u1-AGENT1",
      id: "AGENT1",
      userId: "u1",
      name: "my-pub-agent",
      model: "glm-5.2",
      type: "agent",
      isPublic: true,
    };
    const pubKey = "agent-pub-AGENT1";
    const fetchImpl: CliFetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/rpc/listFavorites")) {
        return new Response(JSON.stringify({ items: [{ id: pubKey, favoritedAt: 7000 }] }));
      }
      if (url.includes("/api/v1/db/query/")) {
        return new Response(JSON.stringify({ data: { data: [selfRecord] } }));
      }
      if (url.includes("/api/v1/db/read/")) {
        const key = decodeURIComponent(url.split("/api/v1/db/read/")[1].split("?")[0]);
        if (key === pubKey) {
          return new Response(JSON.stringify({ data: { ...selfRecord, dbKey: pubKey } }));
        }
        throw new Error(`read failed: HTTP 404 {"error":"not found"}`);
      }
      return new Response(JSON.stringify({ data: [] }));
    };

    const entries = await loadAgentCatalog({
      env,
      currentKey: "",
      fetchImpl,
    });

    // 自有 agent 只出现一次（privateKey 形态），publicKey 形态不重复入目
    expect(entries.filter((entry) => entry.key === "agent-u1-AGENT1").length).toBe(1);
    expect(entries.find((entry) => entry.key === pubKey)).toBeUndefined();
    invalidateAgentCatalogCache();
  });
});
