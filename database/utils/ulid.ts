import { monotonicFactory } from "ulid";

// Use a monotonic ULID factory so that successive ids generated within the
// same millisecond strictly increase in lexicographic order. The chat message
// entity adapter sorts by `id` via `localeCompare`, so monotonic ids make
// insertion order match the sorted render order — which is what lets a freshly
// created assistant text segment land *after* a preceding tool message even
// when a tool call returns within the same millisecond (e.g. in tests).
// Native already uses monotonicFactory (see ulid.native.ts); this keeps web
// consistent with it.
const prng = () => Math.random();
export const ulid = monotonicFactory(prng);
