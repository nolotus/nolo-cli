// auth/routes.ts
import { API_VERSION } from "../database/config";

export interface RouteParams {
  userId?: string;
}

export const authRoutes = {
  login: {
    path: `${API_VERSION}/users/login`,
    method: "POST" as const,
    createPath: () => `${API_VERSION}/users/login`,
  },
  signup: {
    path: `${API_VERSION}/users/signup`,
    method: "POST" as const,
    createPath: () => `${API_VERSION}/users/signup`,
  },
  users: {
    cliLoginStart: {
      path: `${API_VERSION}/users/cli-login/start`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/cli-login/start`,
    },
    cliLoginAuthorize: {
      path: `${API_VERSION}/users/cli-login/authorize`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/cli-login/authorize`,
    },
    cliLoginPoll: {
      path: `${API_VERSION}/users/cli-login/poll`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/cli-login/poll`,
    },
    list: {
      path: `${API_VERSION}/users`,
      method: "GET" as const,
      createPath: () => `${API_VERSION}/users`,
    },
    usageReport: {
      path: `${API_VERSION}/users/usage-report`,
      method: "GET" as const,
      createPath: () => `${API_VERSION}/users/usage-report`,
    },
    growthReport: {
      path: `${API_VERSION}/users/growth-report`,
      method: "GET" as const,
      createPath: () => `${API_VERSION}/users/growth-report`,
    },
    providerBillingHealth: {
      path: `${API_VERSION}/users/provider-billing-health`,
      method: "GET" as const,
      createPath: () => `${API_VERSION}/users/provider-billing-health`,
    },
    providerBillingDrilldown: {
      path: `${API_VERSION}/users/provider-billing-drilldown`,
      method: "GET" as const,
      createPath: () => `${API_VERSION}/users/provider-billing-drilldown`,
    },
    providerCredentials: {
      path: `${API_VERSION}/users/provider-credentials`,
      method: "GET" as const,
      createPath: () => `${API_VERSION}/users/provider-credentials`,
    },
    providerCredentialLifecycle: {
      path: `${API_VERSION}/users/provider-credentials/lifecycle`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/provider-credentials/lifecycle`,
    },
    billingAnomalyLifecycle: {
      path: `${API_VERSION}/users/billing-anomalies/lifecycle`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/billing-anomalies/lifecycle`,
    },
    billingAnomalyDrilldown: {
      path: `${API_VERSION}/users/billing-anomalies/drilldown`,
      method: "GET" as const,
      createPath: () => `${API_VERSION}/users/billing-anomalies/drilldown`,
    },
    billingAnomalyAudit: {
      path: `${API_VERSION}/users/billing-anomalies/audit`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/billing-anomalies/audit`,
    },
    detail: {
      path: `${API_VERSION}/users/:userId`,
      method: "GET" as const,
      createPath: (params: RouteParams) =>
        `${API_VERSION}/users/${params.userId}`,
    },
    sessionRevoke: {
      path: `${API_VERSION}/users/session-revoke`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/session-revoke`,
    },
    transfer: {
      path: `${API_VERSION}/users/:userId/transfer`,
      method: "POST" as const,
      createPath: (params: RouteParams) =>
        `${API_VERSION}/users/${params.userId}/transfer`,
    },
    delete: {
      path: `${API_VERSION}/users/:userId`,
      method: "DELETE" as const,
      createPath: (params: RouteParams) =>
        `${API_VERSION}/users/${params.userId}`,
    },
    disable: {
      path: `${API_VERSION}/users/:userId/disable`,
      method: "POST" as const,
      createPath: (params: RouteParams) =>
        `${API_VERSION}/users/${params.userId}/disable`,
    },
    enable: {
      path: `${API_VERSION}/users/:userId/enable`,
      method: "POST" as const,
      createPath: (params: RouteParams) =>
        `${API_VERSION}/users/${params.userId}/enable`,
    },
    adminPermissions: {
      path: `${API_VERSION}/users/:userId/admin-permissions`,
      method: "POST" as const,
      createPath: (params: RouteParams) =>
        `${API_VERSION}/users/${params.userId}/admin-permissions`,
    },
    sendEmail: {
      path: `${API_VERSION}/users/send-email`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/send-email`,
    },
    spaceInvite: {
      path: `${API_VERSION}/users/space-invite`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/space-invite`,
    },
    spaceInviteStatus: {
      path: `${API_VERSION}/users/space-invite/status`,
      method: "GET" as const,
      createPath: () => `${API_VERSION}/users/space-invite/status`,
    },
    spaceInviteAccept: {
      path: `${API_VERSION}/users/space-invite/accept`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/space-invite/accept`,
    },
    emailPreferencesGet: {
      path: `${API_VERSION}/users/email-preferences`,
      method: "GET" as const,
      createPath: () => `${API_VERSION}/users/email-preferences`,
    },
    emailPreferencesUpdate: {
      path: `${API_VERSION}/users/email-preferences`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/email-preferences`,
    },
    emailReport: {
      path: `${API_VERSION}/users/email-report`,
      method: "GET" as const,
      createPath: () => `${API_VERSION}/users/email-report`,
    },
    emailRetryRun: {
      path: `${API_VERSION}/users/email-retry/run`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/email-retry/run`,
    },
    emailReplayFailures: {
      path: `${API_VERSION}/users/email-replay-failures`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/email-replay-failures`,
    },
    emailConfigGet: {
      path: `${API_VERSION}/users/email-config`,
      method: "GET" as const,
      createPath: () => `${API_VERSION}/users/email-config`,
    },
    emailConfigUpdate: {
      path: `${API_VERSION}/users/email-config`,
      method: "POST" as const,
      createPath: () => `${API_VERSION}/users/email-config`,
    },
    emailUnsubscribe: {
      path: `${API_VERSION}/users/email-unsubscribe`,
      method: "GET" as const,
      createPath: () => `${API_VERSION}/users/email-unsubscribe`,
    },
    rechargeHistory: {
      path: `${API_VERSION}/users/:userId/recharge-history`,
      method: "POST" as const,
      createPath: (params: RouteParams) =>
        `${API_VERSION}/users/${params.userId}/recharge-history`,
    },
  },
} as const;

/**
 * 简单的路径匹配器，只处理基本的参数提取。
 * 非参数部分的 regex 特殊字符会被转义，防止 regex injection。
 */
export function createPathMatcher(routePath: string) {
  // 按 :paramName 拆分，偶数位是静态 path，奇数位是参数名
  const segments = routePath.split(/:(\w+)/);
  const pattern = segments
    .map((part, i) =>
      i % 2 === 0
        ? part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        : "([^/]+)",
    )
    .join("");
  return new RegExp(`^${pattern}$`);
}
