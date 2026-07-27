/**
 * SSE 读取的两条共享读法。帧**内容**怎么解释仍归各 provider（见 sseDataLine.ts）。
 *
 * 两条而不是一条，是因为四个 provider 本来就分成两类，硬并成一个会改语义：
 *   - `readSseFrames`（流式，按 `\n\n` 切帧）：openAiCompatible / platformChat。
 *     边收边 yield，调用方能逐帧回调 onTextDelta。
 *   - `readSseDataValues`（攒完再返回，按 `\n` 逐行解析）：codexResponses /
 *     antigravityCloudCode。这两家的事件本身就是整包语义，没有增量回调，
 *     且 body 缺失时返回空数组而不是抛错。
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
 * 逐行解析 SSE `data:`，收集 `parse` 返回的非空值。
 *
 * codexResponses 与 antigravityCloudCode 此前各抄一份逐字相同的实现，
 * 只有 `parse` 和数组元素类型不同。
 */
export async function readSseDataValues<T>(
  response: Response,
  parse: (line: string) => T | null,
): Promise<T[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  const values: T[] = [];
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parse(line);
      if (parsed) values.push(parsed);
    }
  }
  if (buffer.trim()) {
    const parsed = parse(buffer);
    if (parsed) values.push(parsed);
  }
  return values;
}