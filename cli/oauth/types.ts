import type {
  OAuthCredential,
  OAuthProvider,
  OAuthRefreshFn,
  OAuthTokenStore,
} from "../../agent-runtime/oauthTokenStore";
export type {
  OAuthCredential,
  OAuthProvider,
  OAuthRefreshFn,
  OAuthTokenStore,
};

export type PkcePair = {
  verifier: string;
  challenge: string;
  method: "S256";
};

export type OAuthCallbackResult = {
  code: string;
  state?: string;
};

export type OAuthTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  idToken?: string;
};

export type OAuthFlowDeps = {
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<boolean> | boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  output?: Pick<Console, "log">;
  error?: Pick<Console, "error">;
};

export type OAuthFlowController = {
  runDeviceCode(deps?: OAuthFlowDeps): Promise<OAuthCredential>;
  runBrowserPkce(deps?: OAuthFlowDeps): Promise<OAuthCredential>;
};
