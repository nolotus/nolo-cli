import { asRecordOrEmpty } from "../../core/recordOrEmpty";
import type { AgentRuntimeOptions } from "./types";

export function buildCanvasNodeEditingContextSummary(
  runtimeOptions?: AgentRuntimeOptions
): string | null {
  if (runtimeOptions?.editingTarget?.kind !== "canvas_node") return null;

  const editingTarget = runtimeOptions.editingTarget;
  const metadata = editingTarget.metadata ?? {};
  const selectedNodeId =
    typeof metadata.selectedNodeId === "string"
      ? metadata.selectedNodeId
      : editingTarget.key ?? "(未知节点)";
  const part =
    typeof metadata.part === "string"
      ? metadata.part
      : editingTarget.title ?? selectedNodeId;
  const nodeType =
    typeof metadata.type === "string" ? metadata.type : "(未知类型)";
  const path = Array.isArray(metadata.path)
    ? metadata.path.filter((item): item is string => typeof item === "string")
    : [];
  const props = asRecordOrEmpty(metadata.props);
  const style = asRecordOrEmpty(metadata.style);

  return [
    "当前编辑目标：Canvas Tree 中的一个选中节点。",
    `- 节点 ID: ${selectedNodeId}`,
    `- part: ${part}`,
    `- 节点类型: ${nodeType}`,
    ...(path.length ? [`- 节点路径: ${path.join(" > ")}`] : []),
    "",
    "当前节点 props:",
    JSON.stringify(props, null, 2),
    "",
    "当前节点 style:",
    JSON.stringify(style, null, 2),
    "",
    "【给 AI 的操作指南 / 非用户原话】",
    `1. 如果用户要求修改当前模块，只输出 updateNode，目标 id 必须是 ${selectedNodeId}。`,
    "2. 不要重建 root/shell，不要重新 append 已存在的大块内容。",
    "3. 除非用户明确要求新增子模块，否则不要 appendNode。",
    "4. 回复仍必须遵守 Canvas Tree MVP 协议：只输出 canvas_snapshot NDJSON，不要输出解释或源码。",
  ].join("\n");
}
