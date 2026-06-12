export const DEFAULT_LOCAL_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_API_PORT = "38123";

export const DEFAULT_LOCAL_API_ORIGIN = `http://${DEFAULT_LOCAL_HOST}:${DEFAULT_LOCAL_API_PORT}`;

export function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
