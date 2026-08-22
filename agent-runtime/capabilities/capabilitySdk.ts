import type { AgentRuntimeToolResult } from "../hostAdapter";
import type { CapabilityExecutionContext, ExecutableCapability } from "./capability";
import { execShellCapability } from "./execShellCapability";

export interface CapabilitySdk {
  execShell(input: unknown): Promise<AgentRuntimeToolResult>;
  invoke<O = AgentRuntimeToolResult>(name: string, input: unknown): Promise<O>;
}

export const BUILTIN_CAPABILITIES: readonly ExecutableCapability<any, any>[] = [
  execShellCapability,
] as const;

export function createCapabilitySdk(args: {
  context: CapabilityExecutionContext;
  capabilities?: readonly ExecutableCapability<any, any>[];
}): CapabilitySdk {
  const registry = new Map<string, ExecutableCapability<any, any>>();
  for (const cap of args.capabilities ?? BUILTIN_CAPABILITIES) {
    registry.set(cap.name, cap);
  }

  const invoke = async <O = AgentRuntimeToolResult>(
    name: string,
    input: unknown,
  ): Promise<O> => {
    const capability = registry.get(name);
    if (!capability) {
      throw new Error(`Capability "${name}" not found.`);
    }
    const normalizedInput = capability.normalizeInput(input);
    if (args.context.onInvoke) {
      await args.context.onInvoke(name, normalizedInput);
    }
    return capability.invoke(args.context, normalizedInput) as Promise<O>;
  };

  return {
    execShell: (input: unknown) => invoke<AgentRuntimeToolResult>("execShell", input),
    invoke,
  };
}

export async function invokeCapability<I = unknown, O = AgentRuntimeToolResult>(
  capabilityOrName: string | ExecutableCapability<I, O>,
  input: unknown,
  ctx: CapabilityExecutionContext,
): Promise<O> {
  const capability: ExecutableCapability<I, O> | undefined =
    typeof capabilityOrName === "string"
      ? (BUILTIN_CAPABILITIES.find((c) => c.name === capabilityOrName) as ExecutableCapability<I, O> | undefined)
      : capabilityOrName;

  if (!capability) {
    throw new Error(`Capability "${String(capabilityOrName)}" not found.`);
  }

  const normalizedInput = capability.normalizeInput(input);
  if (ctx.onInvoke) {
    await ctx.onInvoke(capability.name, normalizedInput);
  }
  return capability.invoke(ctx, normalizedInput);
}
