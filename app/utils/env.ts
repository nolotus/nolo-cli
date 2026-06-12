//  app/utils/fileUtils.ts
export const isBrowser = typeof window !== "undefined";
const processEnv = typeof process !== "undefined" ? process.env : undefined;
const reactNativeDev =
  typeof globalThis !== "undefined" && "__DEV__" in globalThis
    ? (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__
    : undefined;

export const isProduction =
  processEnv?.NOLO_FORCE_PRODUCTION === "1" ||
  processEnv?.NODE_ENV === "production" ||
  reactNativeDev === false;
export const isDevelopment = !isProduction;
export const getIsDesktopApp = (): boolean =>
  (typeof process !== "undefined" ? process.env?.NOLO_DESKTOP : processEnv?.NOLO_DESKTOP) === "1" ||
  (typeof window !== "undefined" && window.__NOLO_DESKTOP__ === true);
export const isDesktopApp = getIsDesktopApp();
