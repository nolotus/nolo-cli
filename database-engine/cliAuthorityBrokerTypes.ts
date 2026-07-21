import type {
  AuthorityBatchOperation,
  AuthorityIteratorOptions,
} from "./authorityStoreTypes";

export type CliAuthorityBrokerRequest =
  | { type: "status" }
  | { type: "open" }
  | { type: "close" }
  | { type: "get"; key: string }
  | { type: "put"; key: string; value: unknown }
  | { type: "del"; key: string }
  | { type: "batchWrite"; ops: AuthorityBatchOperation[] }
  | {
      type: "iterator";
      options?: AuthorityIteratorOptions;
      cursor?: string | null;
      limit?: number;
    };

export type CliAuthorityBrokerIteratorPage = {
  entries: Array<[string, unknown]>;
  nextCursor: string | null;
  done: boolean;
};

export type CliAuthorityBrokerSuccessResponse =
  | { ok: true; result: { type: "status" | "open" | "close" | "put" | "del" | "batchWrite" } }
  | { ok: true; result: { type: "get"; value: unknown } }
  | { ok: true; result: { type: "iterator"; page: CliAuthorityBrokerIteratorPage } };

export type CliAuthorityBrokerErrorResponse = {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
  };
};

export type CliAuthorityBrokerResponse =
  | CliAuthorityBrokerSuccessResponse
  | CliAuthorityBrokerErrorResponse;
