// 文件路径: chat/messages/parseMultilineSSE.ts

/**
 * 创建一个 SSE 解析器实例，支持跨 chunk 累积完整事件。
 *
 * 用法：
 *   const parseSSE = createSSEParser();
 *   const objs = parseSSE(chunk); // 每次网络 chunk 调一次
 */
export function createSSEParser() {
  // buffer 保存「还没形成完整事件」的残余文本（跨 chunk 累积）
  let buffer = "";

  return function parseSSE(chunk: string): any[] {
    const results: any[] = [];
    if (!chunk) return results;

    // 追加到全局 buffer
    buffer += chunk;

    // 按 “空行” 分割成若干完整事件：
    //   一个 event = 若干行，以空行 (\n\n 或 \r\n\r\n) 结束
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? ""; // 最后一个当作“残余”，留在 buffer

    for (const ev of events) {
      if (!ev.trim()) continue;

      const lines = ev.split(/\r?\n/);
      let accumulator = "";

      for (const line of lines) {
        const t = line.trim();

        // 1. 处理 [DONE]
        if (t === "data: [DONE]") {
          if (accumulator.trim()) {
            // 尝试解析残余
            try { results.push(JSON.parse(accumulator)); } catch (e) { }
            accumulator = "";
          }
          results.push("[DONE]");
          continue;
        }

        let content = "";
        let isDataLine = false;

        // 2. 提取内容
        if (t.startsWith("data:")) {
          content = line.substring(line.indexOf("data:") + 5).trim();
          isDataLine = true;
        } else if (accumulator && t && !t.startsWith("event:") && !t.startsWith("id:") && !t.startsWith("retry:")) {
          // 支持非标多行 JSON（没有 data: 前缀的行，视为上一行的延续）
          content = line;
        } else {
          continue; // 其他行或空行忽略
        }

        // 3. 尝试即时解析（针对每行都是独立 JSON 的情况）
        if (isDataLine && !accumulator) {
          // 只有在 accumulator 为空时才尝试单行解析，避免要把单行插入到多行中间
          try {
            // 快速检查：如果 content 看起来不完整（比如以 { 结尾），就别试了，直接进 acc
            // 但 JSON.parse 会处理。
            const obj = JSON.parse(content);
            results.push(obj);
            continue; // 成功解析，本行处理完毕
          } catch (e) {
            // 解析失败，说明可能是多行 JSON 的一部分
          }
        }

        // 4. 累积
        accumulator += content;
      }

      // 5. 事件结束，尝试解析累积的内容
      if (accumulator.trim()) {
        try {
          const obj = JSON.parse(accumulator);
          results.push(obj);
        } catch (e) {
          // 仍然失败？那就真没办法了，或者尝试容错
          // console.warn("Parse failed:", accumulator);
        }
      }
    }

    return results;
  };
}

/** 若仍需旧的函数名导入，可用此单例（但不隔离并发流） */
export const parseMultilineSSE = createSSEParser();