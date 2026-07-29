const DEFAULT_MISS_COOLDOWN_MS = 2000;
const DEFAULT_LOCAL_HIT_REVALIDATE_COOLDOWN_MS = 1500;
const DEFAULT_MISS_CACHE_MAX_SIZE = 1000;

export class ReadRequestManager {
  private readonly inFlightReads = new Map<string, Promise<any>>();
  private readonly recentMisses = new Map<string, number>();
  private readonly recentLocalHitRevalidations = new Map<string, number>();

  constructor(
    private readonly options: {
      missCooldownMs?: number;
      missCacheMaxSize?: number;
      localHitRevalidateCooldownMs?: number;
    } = {}
  ) {}

  private get missCooldownMs() {
    return this.options.missCooldownMs ?? DEFAULT_MISS_COOLDOWN_MS;
  }

  private get missCacheMaxSize() {
    return this.options.missCacheMaxSize ?? DEFAULT_MISS_CACHE_MAX_SIZE;
  }

  private get localHitRevalidateCooldownMs() {
    return (
      this.options.localHitRevalidateCooldownMs ??
      DEFAULT_LOCAL_HIT_REVALIDATE_COOLDOWN_MS
    );
  }

  getInFlight(dbKey: string) {
    return this.inFlightReads.get(dbKey);
  }

  setInFlight(dbKey: string, promise: Promise<any>) {
    this.inFlightReads.set(dbKey, promise);
  }

  clearInFlight(dbKey: string, promise: Promise<any>) {
    if (this.inFlightReads.get(dbKey) === promise) {
      this.inFlightReads.delete(dbKey);
    }
  }

  clearMiss(dbKey: string) {
    this.recentMisses.delete(dbKey);
  }

  getRetryInMs(dbKey: string, now: number) {
    const missUntil = this.recentMisses.get(dbKey);
    if (typeof missUntil !== "number") return null;
    if (missUntil <= now) {
      this.recentMisses.delete(dbKey);
      return null;
    }
    return missUntil - now;
  }

  markMiss(dbKey: string, now: number, cooldownMs = this.missCooldownMs) {
    this.recentMisses.set(dbKey, now + cooldownMs);
    this.cleanupMisses(now);
  }

  getLocalHitRevalidateInMs(dbKey: string, now: number) {
    const nextAllowedAt = this.recentLocalHitRevalidations.get(dbKey);
    if (typeof nextAllowedAt !== "number") return null;
    if (nextAllowedAt <= now) {
      this.recentLocalHitRevalidations.delete(dbKey);
      return null;
    }
    return nextAllowedAt - now;
  }

  markLocalHitRevalidated(
    dbKey: string,
    now: number,
    cooldownMs = this.localHitRevalidateCooldownMs
  ) {
    this.recentLocalHitRevalidations.set(dbKey, now + cooldownMs);
    this.cleanupLocalHitRevalidations(now);
  }

  private cleanupExpiringMap(map: Map<string, number>, now: number) {
    for (const [key, expiresAt] of Array.from(map.entries())) {
      if (expiresAt <= now) {
        map.delete(key);
      }
    }

    if (map.size <= this.missCacheMaxSize) return;
    const overflow = map.size - this.missCacheMaxSize;
    const keys = Array.from(map.keys());
    for (let i = 0; i < overflow; i += 1) {
      const key = keys[i];
      if (key) map.delete(key);
    }
  }

  cleanupMisses(now: number) {
    this.cleanupExpiringMap(this.recentMisses, now);
  }

  cleanupLocalHitRevalidations(now: number) {
    this.cleanupExpiringMap(this.recentLocalHitRevalidations, now);
  }

  // test helper
  getMissCacheSize() {
    return this.recentMisses.size;
  }

  // test helper
  getLocalHitRevalidationCacheSize() {
    return this.recentLocalHitRevalidations.size;
  }
}

export const readRequestManager = new ReadRequestManager();
