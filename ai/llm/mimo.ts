import type { Model } from "./types";

// Xiaomi MiMo platform models have been removed from the product.
// The export is retained as an empty array so legacy import sites
// (models.ts / providers.ts) keep compiling during the cleanup.
export const mimoModels: Model[] = [];