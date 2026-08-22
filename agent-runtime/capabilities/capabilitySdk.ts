import type { AgentRuntimeToolResult } from "../hostAdapter";
import type { CapabilityExecutionContext, ExecutableCapability } from "./capability";
import { evaluateCapabilityPolicy } from "./capabilityPolicy";
import { execShellCapability } from "./execShellCapability";

export interface CapabilitySdk {
  execShell(input: unknown): Promise<AgentRuntimeToolResult>;
  invoke<O = AgentRuntimeToolResult>(name: string, input: unknown): Promise<O>;
}

export const BUILTIN_CAPABILITIES: readonly ExecutableCapability<any, any>[] = [
  execShellCapability,
] as const;

export async function invokeCapability<I = unknown, O = AgentRuntimeToolResult>(
  capabilityOrName: string | ExecutableCapability<I, O>,
  input: unknown,
  ctx: CapabilityExecutionContext = {},
): Promise<O> {
  const capability: ExecutableCapability<I, O> | undefined =
    typeof capabilityOrName === "string"
      ? (BUILTIN_CAPABILITIES.find((c) => c.name === capabilityOrName) as ExecutableCapability<I, O> | undefined)
      : capabilityOrName;

  if (!capability) {
    throw new Error(`Capability "${String(capabilityOrName)}" not found.`);
  }

  // 1. Canonical input normalization & validation
  const normalizedInput = capability.normalizeInput(input);

  // 2. Capability Policy Evaluation
  await evaluateCapabilityPolicy(capability, normalizedInput, ctx);

  // 3. Audit / hook (invoked only after policy approval and before execution)
  if (ctx.onInvoke) {
    await ctx.onInvoke(capability.name, normalizedInput);
  }

  // 4. Low-level capability execution
  return capability.invoke(ctx, normalizedInput);
}

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
    return invokeCapability<unknown, O>(capability, input, args.context);
  };

  return {
    execShell: (input: unknown) => invoke<AgentRuntimeToolResult>("execShell", input),
    invoke,
  };
}
