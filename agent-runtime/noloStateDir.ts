import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve a directory of local nolo state (`credentials`, `sources`, …).
 *
 * Single source of truth for the `NOLO_HOME` fallback inside this package.
 * The rule — trim, treat blank as unset, otherwise `~/.nolo` — used to be
 * hand-copied per call site, and hand-copied rules drift: the copies that
 * *didn't* honour NOLO_HOME are exactly why test processes ended up writing
 * the developer's real credentials.
 *
 * `homeDir` still wins when a caller passes one explicitly, which is how
 * callers point the store at a directory of their own.
 */
export function resolveNoloStateDir(name: string, homeDir?: string): string {
  if (homeDir) return join(homeDir, ".nolo", name);
  const noloHome = process.env.NOLO_HOME?.trim();
  return noloHome ? join(noloHome, name) : join(homedir(), ".nolo", name);
}
