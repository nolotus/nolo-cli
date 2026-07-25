// Wave16 — shared message shape guards (Redux-free).

import type { Message } from "./types";

export const isValidMessage = (msg: unknown): msg is Message =>
  !!msg && typeof msg === "object" && typeof (msg as Message).id === "string";
