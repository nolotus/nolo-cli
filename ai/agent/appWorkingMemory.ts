import type { Message } from "../../chat/messages/types";
import type { ToolRun } from "../tools/toolRunSlice";

const APP_TOOL_NAMES = new Set([
  "appList",
  "appRead",
  "appDeploy",
  "appPreflight",
  "appDelete",
]);

const contentToText = (content: Message["content"] | undefined): string => {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => ("text" in part ? part.text ?? "" : ""))
      .join("\n");
  }
  return "";
};

const parseAppListEntries = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- **") && line.includes("(appId:"));

export const buildRecentAppToolMemory = (
  messages: Message[],
  toolRuns: ToolRun[],
): string | null => {
  const messageById = new Map(messages.map((msg) => [msg.id, msg]));
  const recentRuns = [...toolRuns]
    .filter((run) => APP_TOOL_NAMES.has(run.toolName))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, 8);

  if (recentRuns.length === 0) return null;

  const lines: string[] = [
    "这些信息来自当前对话里最近的 app 工具调用，不依赖右侧编辑态。",
  ];

  const latestDeployLike = recentRuns.find((run) =>
    ["appDeploy", "appRead", "appPreflight"].includes(run.toolName),
  );
  if (latestDeployLike) {
    const input = latestDeployLike.input ?? {};
    const parts = [
      `- 最近一次关键 app 操作: ${latestDeployLike.toolName}`,
      typeof input.appId === "string" ? `appId=${input.appId}` : null,
      typeof input.name === "string" ? `name=${input.name}` : null,
      typeof input.framework === "string" ? `framework=${input.framework}` : null,
    ].filter(Boolean);
    lines.push(parts.join("，"));
  }

  const relatedMessages = recentRuns
    .map((run) => messageById.get(run.messageId))
    .filter((msg): msg is Message => !!msg);

  const appListMessage = relatedMessages.find((msg) => msg.toolName === "appList");
  if (appListMessage) {
    const entries = parseAppListEntries(contentToText(appListMessage.content)).slice(0, 5);
    if (entries.length > 0) {
      lines.push("- 最近一次 appList 结果：");
      lines.push(...entries.map((entry) => `  ${entry}`));
    }
  }

  const latestReadMessage = relatedMessages.find((msg) => msg.toolName === "appRead");
  if (latestReadMessage) {
    const text = contentToText(latestReadMessage.content);
    const appId = text.match(/- appId:\s*(.+)/)?.[1]?.trim();
    const url = text.match(/- 访问地址:\s*(.+)/)?.[1]?.trim();
    if (appId || url) {
      lines.push(
        [
          "- 最近一次 appRead 真值:",
          appId ? `appId=${appId}` : null,
          url ? `url=${url}` : null,
        ]
          .filter(Boolean)
          .join("，"),
      );
    }
  }

  const latestPreflightRun = recentRuns.find((run) => run.toolName === "appPreflight");
  if (latestPreflightRun) {
    lines.push(
      [
        "- 最近一次 appPreflight:",
        latestPreflightRun.status === "failed" ? "失败" : "已执行",
        latestPreflightRun.outputSummary ? `摘要=${latestPreflightRun.outputSummary}` : null,
      ]
        .filter(Boolean)
        .join("，"),
    );
  }

  const latestDeployMessage = relatedMessages.find((msg) => msg.toolName === "appDeploy");
  if (latestDeployMessage) {
    const text = contentToText(latestDeployMessage.content);
    const appId = text.match(/- appId:\s*(.+)/)?.[1]?.trim();
    const url = text.match(/- 访问地址:\s*(.+)/)?.[1]?.trim();
    if (appId || url) {
      lines.push(
        [
          "- 最近一次 appDeploy 结果:",
          appId ? `appId=${appId}` : null,
          url ? `url=${url}` : null,
        ]
          .filter(Boolean)
          .join("，"),
      );
    }
  }

  lines.push(
    "- 如果用户说“刚才那个 app / 那个网站”，优先把它理解为上面最近一次被读取、预检或部署的应用；若仍有歧义，再用 appList 或 appRead 确认。",
  );

  return lines.join("\n");
};
