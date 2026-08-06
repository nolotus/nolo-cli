/**
 * Fold a user home directory prefix in an absolute path to `~`.
 *
 * Shared by the CLI (`formatHomePath`, which supplies `osHomedir()` from Node)
 * and the Desktop webview (`compactWorkspacePath`, which has no Node APIs and
 * relies on the Unix home-layout regex fallback). Keeping one implementation
 * prevents the two consumers from drifting.
 *
 * Pure string transform; no Node `os`/`fs` dependency, so it is safe to run in
 * a browser webview. Callers that know the exact home dir pass it as `home`
 * for an exact prefix match; otherwise the `/Users/<name>/` or
 * `/home/<name>/` regex fallback is used.
 *
 * Examples:
 *   foldHomePath("/Users/nolotus/bun-nolo", "/Users/nolotus") -> "~/bun-nolo"
 *   foldHomePath("/Users/nolotus")                          -> "~"
 *   foldHomePath("/home/dev/repo", "/home/dev")             -> "~/repo"
 *   foldHomePath("/tmp/x")                                  -> "/tmp/x"
 */
export function foldHomePath(path: string, home?: string): string {
  if (!path) return path;
  if (home) {
    // Normalize a trailing slash so callers passing "/home/dev/" (e.g. some
    // HOME env values) do not produce a double-slash and silently miss the
    // prefix.
    const cleanHome = home.endsWith("/") ? home.slice(0, -1) : home;
    if (path === cleanHome) return "~";
    if (path.startsWith(cleanHome + "/")) return `~${path.slice(cleanHome.length)}`;
  }
  // Generic fallback for Unix home layouts (/Users/<name> or /home/<name>).
  // Tolerates a missing trailing slash so exact home (e.g. /Users/nolotus)
  // still folds to ~.
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)(\/|$)/, "~$2");
}