/**
 * Test-only type helpers for packages/cli.
 * Casts incomplete LevelDB / fetch stubs without changing runtime behavior.
 */
import type { HybridRecordKvDb } from "./agentRuntimeLocal";
import type { CliFetchImpl } from "./cliFetch";

export type { CliFetchImpl };

/** Accept any async-ish fetch stub as a CLI fetch implementation. */
export function asTestFetch(
  impl: (...args: any[]) => Promise<Response> | Response,
): CliFetchImpl {
  return impl as unknown as CliFetchImpl;
}

/** Also satisfies `typeof fetch` call sites that still use the wider type. */
export function asTypeofFetch(
  impl: (...args: any[]) => Promise<Response> | Response,
): typeof fetch {
  return impl as unknown as typeof fetch;
}

const defaultIterator = async function* (): AsyncGenerator<[string, any]> {
  // empty
};

/**
 * Fill missing HybridRecordKvDb methods (especially `del`) on partial test stubs.
 * Contextual typing of method parameters is preserved via Partial<HybridRecordKvDb>.
 */
export function asTestKvDb(
  partial: Partial<HybridRecordKvDb> = {},
): HybridRecordKvDb {
  return {
    get: async () => {
      throw new Error("not found");
    },
    put: async () => undefined,
    del: async () => undefined,
    batch: async () => undefined,
    iterator: () => defaultIterator(),
    ...partial,
  };
}
