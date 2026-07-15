import { isRecord } from "../core/isRecord";
import { asOptionalTrimmedString } from "../core/optionalString";

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
  if (!isRecord(payload)) return null;
  if (!Array.isArray(payload.command)) return null;
  const command = payload.command.flatMap((item) => {
    const value = asOptionalTrimmedString(item);
    return value ? [value] : [];
  });
  if (command.length === 0) return null;
  const displayCommand = asOptionalTrimmedString(payload.displayCommand);
  return {
    command,
    ...(displayCommand ? { displayCommand } : {}),
  };
}

export function readActionGate(value: unknown): ActionGate | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  if (value.kind !== "confirm" && value.kind !== "handoff" && value.kind !== "input") return null;
  if (typeof value.title !== "string" || !value.title.trim()) return null;
  return {
    id: value.id.trim(),
    kind: value.kind,
    title: value.title.trim(),
    ...(asOptionalTrimmedString(value.body) ? { body: asOptionalTrimmedString(value.body) } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "payload") ? { payload: value.payload } : {}),
  };
}
