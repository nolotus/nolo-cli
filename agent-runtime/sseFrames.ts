/**
 * SSE 读取的共享读法。帧**内容**怎么解释仍归各 provider（见 sseDataLine.ts）。
 *
 * - `readSseFrames`（流式，按 `\n\n` 切帧）：openAiCompatible / platformChat。
 *   边收边 yield，调用方能逐帧回调 onTextDelta。
 * - `streamSseDataValues`（流式，按 `\n` 逐行解析并 yield）：codexResponses /
 *   antigravityCloudCode 等逐行 JSON 协议，上游每推一个 chunk 就能立即被消费。
 * - `readSseDataValues`（攒完再返回，按 `\n` 逐行解析）：基于 streamSseDataValues。
 */
export async function* readSseFrames(
  response: Response,
): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("SSE response did not include a readable body.");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      yield buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) yield buffer;
}

/**
 * 逐行解析 SSE `data:` 并以 AsyncGenerator 形式实时 yield `parse` 返回的非空值。
 */
export async function* streamSseDataValues<T>(
  response: Response,
  parse: (line: string) => T | null,
): AsyncGenerator<T> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parse(line);
      if (parsed) yield parsed;
    }
  }
  if (buffer.trim()) {
    const parsed = parse(buffer);
    if (parsed) yield parsed;
  }
}

/**
 * 逐行解析 SSE `data:`，收集 `parse` 返回的非空值。
 */
export async function readSseDataValues<T>(
  response: Response,
  parse: (line: string) => T | null,
): Promise<T[]> {
  const values: T[] = [];
  for await (const value of streamSseDataValues(response, parse)) {
    values.push(value);
  }
  return values;
}
