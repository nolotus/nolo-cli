import { toTrimmedString } from "../../core/toTrimmedString";
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

/** First-seen order, trim, drop empties and duplicate type names. */
const normalizeTypeList = (types: string | string[]): string[] => {
    const raw = Array.isArray(types) ? types : [types];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of raw) {
        const n = toTrimmedString(t);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
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
    const typeArray = normalizeTypeList(types);
    const includeDeleted = options.includeDeleted === true;

    try {
        for (const type of typeArray) {
            // Multi-prefix merge: Map by storage key so overlapping alias ranges
            // never emit the same record twice.
            const byKey = new Map<string, any>();
            const prefixes = getUserDataPrefixes(type, userId);

            for (const prefix of prefixes) {
                if (!prefix) continue;

                let iterator = db.iterator({
                    gte: prefix,
                    lte: `${prefix}\uffff`,
                });

                if (iterator && typeof iterator.then === "function") {
                    iterator = await iterator;
                }

                // @ts-ignore - iterator compatibility
                for await (const [key, value] of iterator) {
                    const keyStr = String(key);
                    if (byKey.has(keyStr)) continue;

                    const hydrated = attachQueriedKey(keyStr, value);
                    if (!hydrated) continue;
                    if (!includeDeleted && hydrated.deletedAt) continue;
                    byKey.set(keyStr, hydrated);
                }
            }

            results[type] = [...byKey.values()];
        }

        if (Array.isArray(types)) {
            return results;
        }
        const single = toTrimmedString(types);
        return results[single] ?? [];
    } catch (error) {
        console.error("Query error:", error);
        throw error;
    }
}
