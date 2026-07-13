import { getUserDataPrefixes } from "../queryPrefixes";

interface FetchUserDataOptions {
    includeDeleted?: boolean;
}

const attachQueriedKey = (key: string, value: any) => {
    if (!value || typeof value !== "object") return value;
    if (
        typeof value.dbKey === "string" && value.dbKey.trim().length > 0
    ) {
        return value;
    }
    return {
        ...value,
        dbKey: key,
    };
};

// 支持单类型或多类型查询
// db should be passed from caller (e.g. thunk extra)
export async function fetchUserData(
    db: any,
    types: string,
    userId: string,
    options?: FetchUserDataOptions
): Promise<any[]>;
export async function fetchUserData(
    db: any,
    types: string[],
    userId: string,
    options?: FetchUserDataOptions
): Promise<Record<string, any[]>>;
export async function fetchUserData(
    db: any,
    types: string | string[],
    userId: string,
    options: FetchUserDataOptions = {}
): Promise<any[] | Record<string, any[]>> {
    const results: Record<string, any[]> = {};
    const typeArray = Array.isArray(types) ? types : [types];
    const includeDeleted = options.includeDeleted === true;

    try {
        for (const type of typeArray) {
            const prefixes = getUserDataPrefixes(type, userId);
            results[type] = [];
            for (const prefix of prefixes) {
                let iterator = db.iterator({
                    gte: prefix,
                    lte: `${prefix}\uffff`,
                });

                if (iterator && typeof iterator.then === "function") {
                    iterator = await iterator;
                }

                // @ts-ignore - iterator compatibility
                for await (const [key, value] of iterator) {
                    const hydrated = attachQueriedKey(String(key), value);
                    if (!hydrated) continue;
                    if (!includeDeleted && hydrated.deletedAt) continue;
                    results[type].push(hydrated);
                }
            }
        }

        return Array.isArray(types) ? results : results[types] ?? [];
    } catch (error) {
        console.error("Query error:", error);
        throw error;
    }
}
