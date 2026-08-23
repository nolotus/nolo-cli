/**
 * Model-generated PTC (Programmatic Tool Calling) Program Validator & Contract
 *
 * Provides static validation, schema parsing, and security boundary checks
 * for LLM-generated JavaScript programs targeting the CapabilitySdk tools surface.
 *
 * STRICT SECURITY PRINCIPLE:
 * Static validation is an early UX/rejection filter only. It does NOT replace
 * execution isolation (such as QuickJS-WASM or isolated subprocesses).
 * Host processes (runLocalAgentTurn, CLI, Desktop) MUST NEVER directly eval()
 * or new Function() model-generated code.
 */

export interface PtcProgramContract {
  language: "javascript" | "js";
  code: string;
}

export interface PtcValidationResult {
  valid: boolean;
  errors: string[];
}

const FORBIDDEN_IDENTIFIERS: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  { pattern: /\bimport\s*[\(\{]/, reason: "Dynamic import() or import statements are forbidden." },
  { pattern: /^\s*import\s+/m, reason: "Static import declarations are forbidden." },
  { pattern: /\brequire\s*\(/, reason: "require() is forbidden in PTC programs." },
  { pattern: /\bprocess\b/, reason: "Direct access to 'process' is forbidden." },
  { pattern: /\bBun\b/, reason: "Direct access to 'Bun' globals is forbidden." },
  { pattern: /\bDeno\b/, reason: "Direct access to 'Deno' globals is forbidden." },
  { pattern: /\bglobalThis\b/, reason: "Access to 'globalThis' is forbidden." },
  { pattern: /\bwindow\b/, reason: "Access to 'window' is forbidden." },
  { pattern: /\bglobal\b/, reason: "Access to 'global' is forbidden." },
  { pattern: /\beval\s*\(/, reason: "eval() is strictly forbidden." },
  { pattern: /\bnew\s+Function\b|\bFunction\s*\(/, reason: "Function constructor is strictly forbidden." },
  { pattern: /\bconstructor\b/, reason: "Access to .constructor is forbidden to prevent sandbox escape." },
  { pattern: /\b__proto__\b/, reason: "Access to __proto__ is forbidden." },
  { pattern: /\bprototype\b/, reason: "Access to prototype is forbidden." },
  { pattern: /\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b/, reason: "Raw network access is forbidden; use tools instead." },
  { pattern: /\bfs\b|\bchild_process\b|\bpath\b|\bos\b|\bnet\b|\bhttp\b/, reason: "Node system modules are forbidden." },
];

/**
 * Validate LLM-generated JavaScript code against the PTC safety contract.
 */
export function validatePtcProgramCode(code: string): PtcValidationResult {
  const errors: string[] = [];

  if (!code || typeof code !== "string" || !code.trim()) {
    return { valid: false, errors: ["Program code cannot be empty."] };
  }

  const trimmed = code.trim();

  // Must contain main entrypoint function
  const hasMainFunction =
    /async\s+function\s+main\s*\(\s*tools\s*\)/.test(trimmed) ||
    /export\s+default\s+async\s+function\s*(main)?\s*\(\s*tools\s*\)/.test(trimmed) ||
    /async\s*\(\s*tools\s*\)\s*=>/.test(trimmed);

  if (!hasMainFunction) {
    errors.push("Program must declare an async entrypoint: 'async function main(tools)' or 'export default async function main(tools)'.");
  }

  for (const { pattern, reason } of FORBIDDEN_IDENTIFIERS) {
    if (pattern.test(trimmed)) {
      errors.push(reason);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Parse structured JSON output from LLM for PTC execution.
 */
export function parsePtcProgramOutput(output: unknown): { ok: true; program: PtcProgramContract } | { ok: false; error: string } {
  let parsed = output;

  if (typeof output === "string") {
    const trimmed = output.trim();
    // Support markdown code blocks
    const jsonBlockMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    const content = jsonBlockMatch ? jsonBlockMatch[1] : trimmed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Check if it's raw JS code block
      const jsBlockMatch = trimmed.match(/^```(?:javascript|js)?\s*([\s\S]*?)\s*```$/);
      if (jsBlockMatch) {
        parsed = { language: "javascript", code: jsBlockMatch[1].trim() };
      } else if (trimmed.startsWith("async function") || trimmed.startsWith("export default")) {
        parsed = { language: "javascript", code: trimmed };
      } else {
        return { ok: false, error: "Output is not valid JSON or standard JavaScript code block." };
      }
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "PTC program payload must be an object." };
  }

  const record = parsed as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.trim() : "";
  const language = typeof record.language === "string" ? record.language.toLowerCase() : "javascript";

  if (!code) {
    return { ok: false, error: "Missing 'code' property in PTC payload." };
  }

  if (language !== "javascript" && language !== "js") {
    return { ok: false, error: `Unsupported program language: ${language}. Only 'javascript' is allowed.` };
  }

  return {
    ok: true,
    program: {
      language: "javascript",
      code,
    },
  };
}
