/**
 * Injectable fetch used across CLI commands and client modules.
 *
 * Prefer this over `typeof fetch`: Bun's `fetch` type requires `preconnect`,
 * which plain test stubs and `mock()` functions never provide. Runtime code
 * only calls fetch as a function.
 */
export type CliFetchImpl = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** RequestInit without the optional-parameter `| undefined` from Parameters. */
export type CliFetchInit = RequestInit;
