import { isRecord } from "../core/isRecord";
import { asOptionalTrimmedString } from "../core/optionalString";

export type PermissionDecision = "allow" | "ask" | "deny";

export type PermissionRequest = {
  id: string;
  tool: string;
  action: string;
  title: string;
  body?: string;
  /**
   * The exact command (or other action target) the user is being asked to
   * approve, surfaced verbatim so the confirm dialog can render it — instead
   * of a generic "this may delete things" warning the user signs blind.
   * Optional for backward compatibility: existing construction sites that
   * don't carry a concrete command omit it and still compile.
   */
  command?: string;
  suggestedRule?: {
    scope: "once" | "session" | "policy";
    pattern: unknown;
  };
};

export type ActionGateKind = "confirm" | "handoff" | "input";

export type ActionGate = {
  id: string;
  kind: ActionGateKind;
  /** Display title, or an i18n key resolved by the consumer (e.g. chat web). */
  title: string;
  /** Optional i18n interpolation params for `title` when it is a locale key. */
  titleParams?: Record<string, string | number>;
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
  const titleParams = readTitleParams(value.titleParams);
  return {
    id: value.id.trim(),
    kind: value.kind,
    title: value.title.trim(),
    ...(titleParams ? { titleParams } : {}),
    ...(asOptionalTrimmedString(value.body) ? { body: asOptionalTrimmedString(value.body) } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "payload") ? { payload: value.payload } : {}),
  };
}

function readTitleParams(
  value: unknown
): Record<string, string | number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, raw]) => {
    if (typeof raw === "string" || typeof raw === "number") {
      return [[key, raw] as const];
    }
    return [];
  });
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}
