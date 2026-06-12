import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type EnvLike = Record<string, string | undefined>;

const WINDOWS_APPS_CODEX_PATTERN = /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\resources$/i;

function pathEntries(env: EnvLike) {
  return (env.PATH ?? process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
}

function findWindowsAppsCodex(env: EnvLike) {
  if (process.platform !== "win32") return "";
  for (const entry of pathEntries(env)) {
    if (!WINDOWS_APPS_CODEX_PATTERN.test(entry)) continue;
    const candidate = join(entry, "codex.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function copyCodexToUserBin(source: string, env: EnvLike) {
  const target =
    env.NOLO_CODEX_SHIM_PATH ??
    join(homedir(), ".nolo", "bin", "codex.exe");
  if (existsSync(target)) return target;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return target;
}

export function resolveLaunchableCodexCommand(env: EnvLike = process.env) {
  const explicit = env.NOLO_CODEX_BIN?.trim();
  if (explicit) return explicit;

  const windowsAppsCodex = findWindowsAppsCodex(env);
  if (windowsAppsCodex) return copyCodexToUserBin(windowsAppsCodex, env);

  return "codex";
}
