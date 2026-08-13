export type ChatWire = "responses" | "completions" | "anthropic" | "codex";

export interface ChatWireAdapterBuildArgs {
  messages: any[];
  agent?: any;
  userInput?: string;
  tools?: any[];
  options?: { stream?: boolean };
}

export interface ChatWireAdapter {
  wire: ChatWire;
  buildRequest(args: ChatWireAdapterBuildArgs): Record<string, unknown>;
  normalizeUsage(raw: unknown): any | null;
}
