// 文件路径: database/fileRing.ts

/**
 * 简单的 FNV-1a 32bit 字符串哈希
 * - 稳定、实现简单，适合作为 hash ring 的排序依据
 */
const fnv1a32 = (str: string): number => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0; // 32bit
    }
    return hash >>> 0;
};

/**
 * 通用服务器选择函数：
 *
 * 给定一组服务器和一个“key”（可以是 tenantId / userId / orgId / fileId …），
 * 选择 replicaCount 个服务器作为该 key 的“归属服务器”。
 *
 * 规则：
 * - 对每个 server 计算 hash(server + "::" + key)
 * - 按 hash 升序排序
 * - 取前 replicaCount 个
 *
 * 说明：
 * - 这不是严格意义上的一致性哈希环，但分布效果 + 实现复杂度比较均衡；
 * - 之后要支持更多服务器，只需要在配置中把新 server 加入列表即可，
 *   这里不需要改代码。
 */
export const chooseServersByKey = (
    allServers: string[],
    key: string,
    replicaCount: number
): string[] => {
    if (!allServers.length || replicaCount <= 0) return [];

    const uniqueServers = Array.from(new Set(allServers)).filter((s) => !!s);
    if (uniqueServers.length === 0) return [];

    const scored = uniqueServers.map((server) => ({
        server,
        score: fnv1a32(`${server}::${key}`),
    }));

    scored.sort((a, b) => a.score - b.score);

    const limit = Math.min(replicaCount, scored.length);
    return scored.slice(0, limit).map((item) => item.server);
};