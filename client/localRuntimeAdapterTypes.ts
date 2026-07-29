/**
 * Shared types for CLI local runtime adapter.
 *
 * Extracted from localRuntimeAdapter.ts so that extracted modules (cliLocalToolExecutors,
 * etc.) can import them without a circular dependency back to localRuntimeAdapter.ts.
 */

export type UserChoiceOption = {
  id?: string;
  label: string;
  userMessage?: string;
};

export type UserChoiceRequest = {
  question: string;
  choices: UserChoiceOption[];
  blocking: boolean;
};

export type UserChoiceResult =
  | { kind: "selected"; userMessage: string; label: string }
  | { kind: "cancelled" };

export type CliLocalRuntimeDb = {
  get(key: string): Promise<any>;
  put(key: string, value: any): Promise<unknown>;
  del(key: string): Promise<unknown>;
  batch(ops: Array<{ type: "put"; key: string; value: any }>): Promise<unknown>;
  iterator(options: {
    gte: string;
    lte?: string;
    lt?: string;
    reverse?: boolean;
    limit?: number;
  }): AsyncIterable<[string, any]>;
};