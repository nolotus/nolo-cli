export type PermissionDecision = "allow" | "ask" | "deny";

export type PermissionRequest = {
  id: string;
  tool: string;
  action: string;
  title: string;
  body?: string;
  suggestedRule?: {
    scope: "once" | "session" | "policy";
    pattern: unknown;
  };
};

export type ActionGateKind = "confirm" | "handoff" | "input";

export type ActionGate = {
  id: string;
  kind: ActionGateKind;
  title: string;
  body?: string;
  payload?: unknown;
};

export type ActionGateResult = {
  gateId: string;
  status: "completed" | "cancelled" | "failed";
  output?: unknown;
};

export type CommandActionGatePayload = {
  command: string[];
  displayCommand?: string;
};

export function readCommandActionGatePayload(
  payload: unknown
): CommandActionGatePayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (!Array.isArray(raw.command)) return null;
  const command = raw.command.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : []
  );
  if (command.length === 0) return null;
  return {
    command,
    ...(typeof raw.displayCommand === "string" && raw.displayCommand.trim()
      ? { displayCommand: raw.displayCommand.trim() }
      : {}),
  };
}

export function readActionGate(value: unknown): ActionGate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  if (raw.kind !== "confirm" && raw.kind !== "handoff" && raw.kind !== "input") return null;
  if (typeof raw.title !== "string" || !raw.title.trim()) return null;
  return {
    id: raw.id.trim(),
    kind: raw.kind,
    title: raw.title.trim(),
    ...(typeof raw.body === "string" && raw.body.trim() ? { body: raw.body.trim() } : {}),
    ...(Object.prototype.hasOwnProperty.call(raw, "payload") ? { payload: raw.payload } : {}),
  };
}
