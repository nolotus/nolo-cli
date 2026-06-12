// auth/types.ts
import type { AdminPermissions } from "./adminPermissions";

export interface User {
  userId: string;
  username?: string;
  name?: string;
  nickname?: string;
  avatar?: string;
  email?: string;
  locale?: string;
  publicKey?: string;
  tokenVersion?: number;
  balance?: number;
  gptProAccess?: {
    status?: string;
    requiredRechargeAmount?: number;
    rechargeAmount?: number;
    source?: string;
    sourceTxId?: string;
    grantedAt?: number;
    updatedAt?: number;
  };
  adminPermissions?: AdminPermissions;
}
export interface TokenManager {
  getTokens(): Promise<string[]>;
  storeToken(token: string): Promise<void>;
  removeToken(token: string): Promise<void>;
  initTokens(): Promise<string[]>;
}

export const safelyParseJSON = (jsonString: string) => {
  try {
    const parsed = JSON.parse(jsonString);
    return typeof parsed === "string" ? [parsed] : parsed;
  } catch {
    return [jsonString];
  }
};
