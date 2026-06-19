export type MachineRunPermissionMode = "read_only" | "full_access";

export type MachineRunPermissionPolicy = {
  mode: MachineRunPermissionMode;
  allowFilesystemRead: boolean;
  allowFilesystemWrite: boolean;
  allowShell: boolean;
  writableRoots: string[];
};

const DEFAULT_POLICY: MachineRunPermissionPolicy = {
  mode: "read_only",
  allowFilesystemRead: true,
  allowFilesystemWrite: false,
  allowShell: false,
  writableRoots: [],
};

const WRITE_DENIED =
  "Machine permission denied: this bound machine agent is read-only for filesystem writes. Enable machine write permission for this agent before asking it to modify files.";

const SHELL_DENIED =
  "Machine permission denied: this bound machine agent cannot run arbitrary shell commands. Enable machine shell permission for this agent before asking it to execute commands.";

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function normalizeWritableRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveMachineRunPermissionPolicy(agentConfig: any): MachineRunPermissionPolicy {
  const runtimeBinding = asObject(agentConfig?.runtimeBinding);
  const raw = asObject(
    agentConfig?.machinePermissions ??
      runtimeBinding.permissions ??
      runtimeBinding.machinePermissions
  );

  const mode: MachineRunPermissionMode =
    raw.mode === "full_access" || raw.allowFilesystemWrite === true || raw.allowShell === true
      ? "full_access"
      : "read_only";

  if (mode === "full_access") {
    return {
      mode,
      allowFilesystemRead: raw.allowFilesystemRead !== false,
      allowFilesystemWrite: true,
      allowShell: raw.allowShell !== false,
      writableRoots: normalizeWritableRoots(raw.writableRoots),
    };
  }

  return {
    ...DEFAULT_POLICY,
    allowFilesystemRead: raw.allowFilesystemRead !== false,
  };
}

const WRITE_INTENT_RE =
  /\b(write|overwrite|edit|modify|delete|remove|rename|move|create|save|patch|apply patch|mkdir|touch|rm|rmdir|del|erase|copy-item|move-item|remove-item|set-content|add-content|new-item)\b|(\u5199\u5165|\u5199\u6587\u4EF6|\u5220\u9664|\u79FB\u9664|\u91CD\u547D\u540D|\u79FB\u52A8|\u521B\u5EFA|\u65B0\u5EFA|\u4FDD\u5B58|\u4FEE\u6539|\u7F16\u8F91|\u6253\u8865\u4E01|\u5E94\u7528\u8865\u4E01)/i;

const SHELL_INTENT_RE =
  /\b(run|execute|exec)\s+(?:a\s+)?(?:shell|command|terminal|powershell|pwsh|bash|zsh|cmd\.exe|npm|bun|node|python|git|curl|wget|ssh|scp|chmod|chown|sudo|tests?|test suite)\b|\b(open|start)\s+(?:a\s+)?(?:shell|terminal)\b|\b(powershell|pwsh|bash|zsh|cmd\.exe|ssh|sudo)\b|(\u8FD0\u884C\u547D\u4EE4|\u6267\u884C\u547D\u4EE4|\u547D\u4EE4\u884C|\u7EC8\u7AEF|\u63A7\u5236\u53F0)/i;

const NEGATION_RE =
  /\b(do not|don't|dont|never|no need to|without|非目标|不要|不需要|禁止|无需)\b|[\u4E0D\u975E]/i;

function stripNegatedPolicySentences(task: string): string {
  return task
    .split(/([\n.;!?。；！？])/)
    .reduce<string[]>((segments, part, index, parts) => {
      if (index % 2 === 1) return segments;
      const separator = parts[index + 1] ?? "";
      const segment = `${part}${separator}`;
      const mentionsRestrictedAction = WRITE_INTENT_RE.test(segment) || SHELL_INTENT_RE.test(segment);
      if (mentionsRestrictedAction && NEGATION_RE.test(segment)) return segments;
      segments.push(segment);
      return segments;
    }, [])
    .join("");
}

export function assertMachineRunAllowed(userInput: string, policy: MachineRunPermissionPolicy) {
  const task = stripNegatedPolicySentences(String(userInput || ""));
  if (!policy.allowFilesystemWrite && WRITE_INTENT_RE.test(task)) {
    throw new Error(WRITE_DENIED);
  }
  if (!policy.allowShell && SHELL_INTENT_RE.test(task)) {
    throw new Error(SHELL_DENIED);
  }
}

export function buildMachinePermissionPromptBlock(policy: MachineRunPermissionPolicy) {
  return [
    "--- Machine permission policy ---",
    `Mode: ${policy.mode}`,
    `Filesystem reads are ${policy.allowFilesystemRead ? "allowed" : "not allowed"}.`,
    `File writes are ${policy.allowFilesystemWrite ? "allowed" : "not allowed"}.`,
    `Arbitrary shell commands are ${policy.allowShell ? "allowed" : "not allowed"}.`,
    policy.writableRoots.length
      ? `Writable roots: ${policy.writableRoots.join(", ")}`
      : "Writable roots: none.",
    "If the user asks for an operation outside this policy, refuse instead of attempting it.",
  ].join("\n");
}
