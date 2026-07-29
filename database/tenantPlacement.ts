// 文件路径: database/tenantPlacement.ts

import { asOptionalTrimmedString } from "../core/optionalString";
import { chooseServersByKey } from "./fileRing";

/**
 * 当前 tenant（用户 / 组织）的副本个数：
 *
 * - TENANT_REPLICA_COUNT = 2:
 *   表示每个 tenant 至少分布在 2 台服务器上（例如 main + us）。
 *
 * 后续如果要提高容灾能力，可以改为 3，
 * 但是建议不要轻易降低（否则会破坏“至少两台机器有数据”的假设）。
 */
export const TENANT_REPLICA_COUNT = 2;

/**
 * 基于 tenantId（通常为 userId）为某个 tenant 选择服务器集合。
 *
 * 目标：
 * - 同一个 tenant 的所有数据（结构化 + 文件）尽量落在同一组服务器上；
 * - 至少 TENANT_REPLICA_COUNT 台服务器；
 * - currentServer 若在 allServers 中，强制包含在结果中（早期可以保证 main 一定在内）。
 *
 * 参数：
 * - allServers: 由 currentServer + syncServers 去重后得到的服务器列表。
 * - currentServer: 当前前端所连接的主服务器（可以为 null/undefined）。
 * - tenantId: 租户 ID，当前你可以直接用 userId。
 *
 * 返回：
 * - servers: 用于写入该 tenant 数据的服务器列表。
 */
export const planServersForTenant = (
    allServers: string[],
    currentServer: string | null | undefined,
    tenantId: string | null | undefined
): string[] => {
    const uniqueServers = Array.from(new Set(allServers)).filter(Boolean);
    if (!uniqueServers.length) return [];

    const key = asOptionalTrimmedString(tenantId) ?? "default-tenant";

    // 基于 tenantId 进行 hash ring 分布
    const fromRing = chooseServersByKey(
        uniqueServers,
        key,
        TENANT_REPLICA_COUNT
    );

    const set = new Set(fromRing);

    // 强制包含 currentServer（若其在配置中）
    if (currentServer && uniqueServers.includes(currentServer)) {
        set.add(currentServer);
    }

    return Array.from(set);
};