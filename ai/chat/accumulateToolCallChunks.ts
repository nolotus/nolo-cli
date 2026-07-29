/**
 * 处理流式工具调用数据块，将其累积到数组中。
 * 关键点：
 * - 支持按 index 拼接，也支持同一 id、无 index 的分片追加（OpenAI 风格常见）
 * - 字符串分片追加；对象分片直接覆盖（最后一段为准）
 * - 不再过滤特殊标记，保持原样透传
 */


export interface ToolCallChunk {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string | object;
  };
}

export interface AccumulatedToolCall {
  index?: number;
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string | object;
  };
}

export function accumulateToolCallChunks(
  currentAccumulatedCalls: AccumulatedToolCall[],
  toolCallChunks: ToolCallChunk[]
): AccumulatedToolCall[] {
  const out = [...currentAccumulatedCalls];

  for (const chunk of toolCallChunks) {
    const { index, id, type, function: fn } = chunk;

    // 分块流（带 index）
    if (index !== undefined) {
      // 确保数组长度足够覆盖 index
      while (out.length <= index) {
        // 先占位，后续填充。初始化所有必需字段以防空指针。
        out.push({
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        });
      }

      const cur = out[index];

      // 初始化或更新基础字段
      if (id && !cur.id) cur.id = id;
      if (type && !cur.type) cur.type = type;
      if (!cur.function) cur.function = { name: "", arguments: "" };

      if (fn) {
        if (fn.name) cur.function.name += fn.name;

        if (fn.arguments) {
          if (typeof fn.arguments === "string") {
            // 字符串增量：追加
            const currentArgs =
              typeof cur.function.arguments === "string"
                ? cur.function.arguments
                : "";
            cur.function.arguments = currentArgs + fn.arguments;
          } else {
            // 对象全量：覆盖（非标流直接给 final object）
            cur.function.arguments = fn.arguments;
          }
        }
      }
      continue;
    }

    // 无 index，但有 fn 的分片（同 id 的后续片段会被追加）
    // 这种模式下通常 id 在第一个 chunk 给定，后续 chunk 可能没有 id
    if (fn?.name || fn?.arguments) {
      let targetIndex = -1;

      // 尝试通过 ID 查找现有调用
      if (id) {
        targetIndex = out.findIndex((c) => c.id === id);
      } else if (out.length > 0) {
        // 如果没有 ID，默认追加到最后一个（假设顺序性）
        targetIndex = out.length - 1;
      }

      if (targetIndex >= 0) {
        const target = out[targetIndex];
        if (fn.name) target.function.name += fn.name; // 追加

        if (fn.arguments) {
          if (typeof fn.arguments === "string") {
            const currentArgs = typeof target.function.arguments === "string" ? target.function.arguments : "";
            target.function.arguments = currentArgs + fn.arguments;
          } else {
            target.function.arguments = fn.arguments;
          }
        }
      } else if (id) {
        // 是新的调用
        const newCall: AccumulatedToolCall = {
          id,
          type: type || "function",
          function: {
            name: fn.name || "",
            arguments: fn.arguments || (!fn.arguments && typeof fn.arguments === 'object' ? {} : "") // Initial empty value based on type? Or just default string
          },
        };
        // For arguments, if it's object, use it. If undefined, use "".
        if (fn.arguments) {
          newCall.function.arguments = fn.arguments;
        } else {
          newCall.function.arguments = "";
        }

        out.push(newCall);
      }
    }
  }

  return out;
}
