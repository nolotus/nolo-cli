/**
 * CLI 命令通用输出工具。
 * 消除各命令文件里手拼 process.stdout.write key:value 的重复。
 */

/**
 * 从对象中挑出非 null/undefined 的字段，返回新对象。
 * 用于从 CLI 参数构造 API body（只含已提供的字段）。
 */
export function pickDefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) result[key] = value;
  }
  return result;
}

/**
 * 格式化 key-value 对为对齐的多行文本并写出。
 * @example formatFields({ name: "my-app", url: "https://..." }) →
 *   name: my-app
 *   url:  https://...
 */
export function formatFields(
  fields: Array<[string, unknown]>,
  indent = "",
): string {
  const maxKeyLen = fields.reduce((max, [k]) => Math.max(max, k.length), 0);
  const lines = fields.map(([key, value]) => {
    const display = value === undefined || value === null ? "-" : String(value);
    return `${indent}${key.padEnd(maxKeyLen)}: ${display}`;
  });
  return lines.join("\n");
}

/**
 * 当 --json 时输出 JSON，否则输出人类可读格式。
 */
export function outputResult(
  data: Record<string, unknown>,
  shouldOutputJson: boolean,
  formatter: () => void,
  output: { write(chunk: string): unknown } = process.stdout,
): void {
  if (shouldOutputJson) {
    output.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    formatter();
  }
}