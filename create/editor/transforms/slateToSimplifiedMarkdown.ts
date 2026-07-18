type SimplifiedMarkdownOptions = {
  mentionResolver?: (node: any) => string;
};

function renderTextNode(node: any): string {
  if (!node || typeof node.text !== "string") return "";

  let text = node.text;
  if (!text) return "";

  if (node.bold) text = `**${text}**`;
  if (node.italic) text = `*${text}*`;
  if (node.strikethrough) text = `~~${text}~~`;
  return text;
}

function renderPlainText(node: any, options: SimplifiedMarkdownOptions = {}): string {
  if (!node) return "";
  if (typeof node.text === "string") return renderTextNode(node);
  if (!Array.isArray(node.children)) return "";
  return node.children.map((child: any) => renderPlainText(child, options)).join("");
}

function renderTable(node: any, listDepth: number, options: SimplifiedMarkdownOptions): string {
  const rows = Array.isArray(node.children) ? node.children : [];
  if (rows.length === 0) return "";

  const alignments = Array.isArray(node.columns)
    ? node.columns.map((column: any) => column?.align || "left")
    : [];

  const renderedRows = rows.map((row: any) =>
    (Array.isArray(row?.children) ? row.children : []).map((cell: any) => {
      const content = renderPlainText(cell, options).replace(/\n+/g, " ").trim();
      return content || " ";
    })
  );

  const header = renderedRows[0] || [];
  const divider = header.map((_: string, index: number) => {
    const align = alignments[index];
    if (align === "center") return ":---:";
    if (align === "right") return "---:";
    return "---";
  });
  const body = renderedRows.slice(1);

  const allRows = [header, divider, ...body]
    .map((cells) => `| ${cells.join(" | ")} |`)
    .join("\n");

  return `${allRows}\n\n`;
}

function renderListItem(
  node: any,
  listDepth: number,
  ordered: boolean,
  start: number,
  index: number,
  options: SimplifiedMarkdownOptions = {}
): string {
  const indentation = "  ".repeat(listDepth);
  const marker = node.checked === true
    ? "- [x]"
    : node.checked === false
      ? "- [ ]"
      : ordered
        ? `${start + index}.`
        : "-";

  const segments = Array.isArray(node.children) ? node.children : [];
  const renderedSegments = segments.flatMap((child: any) => {
    const rendered = renderNode(child, listDepth + 1, options).trimEnd();
    return rendered ? [rendered] : [];
  });

  if (renderedSegments.length === 0) {
    return `${indentation}${marker}\n`;
  }

  const [first, ...rest] = renderedSegments;
  const lines = first.split("\n");
  const firstLine = lines.shift() || "";
  const restFirst = lines.map((line: string) => `${indentation}  ${line}`).join("\n");
  const restBlocks = rest.map((block: string) => `${indentation}  ${block}`).join("\n");

  return [
    `${indentation}${marker} ${firstLine}`,
    restFirst,
    restBlocks,
  ]
    .filter(Boolean)
    .join("\n") + "\n";
}

/**
 * 递归地把 Slate 节点线性化为“易读 markdown”。
 * 这里的目标是让 AI / 工具读取时更稳定，不追求展示侧的视觉保真。
 */
function renderNode(
  node: any,
  listDepth = 0,
  options: SimplifiedMarkdownOptions = {}
): string {
  if (!node) return "";
  const indentation = "  ".repeat(listDepth);

  switch (node.type) {
    case "heading-one":
      return `# ${node.children.map((n: any) => renderNode(n, listDepth, options)).join("")}\n\n`;
    case "heading-two":
      return `## ${node.children.map((n: any) => renderNode(n, listDepth, options)).join("")}\n\n`;
    case "heading-three":
      return `### ${node.children.map((n: any) => renderNode(n, listDepth, options)).join("")}\n\n`;
    case "heading-four":
      return `#### ${node.children.map((n: any) => renderNode(n, listDepth, options)).join("")}\n\n`;
    case "heading-five":
      return `##### ${node.children.map((n: any) => renderNode(n, listDepth, options)).join("")}\n\n`;
    case "heading-six":
      return `###### ${node.children.map((n: any) => renderNode(n, listDepth, options)).join("")}\n\n`;

    case "paragraph":
      return `${node.children.map((n: any) => renderNode(n, listDepth, options)).join("")}\n\n`;

    case "list":
      return node.children
        .map((item: any, index: number) =>
          renderListItem(item, listDepth, !!node.ordered, node.start || 1, index, options)
        )
        .join("");

    case "list-item":
      return renderListItem(node, listDepth, false, 1, 0, options);

    case "quote":
      const content = node.children
        .map((n: any) => renderNode(n, listDepth, options))
        .join("")
        .trim();
      return `> ${content.replace(/\n/g, "\n> ")}\n\n`;

    case "code-block":
      const code = node.children
        .map((line: any) =>
          (line.children || []).map((text: any) => text.text).join("")
        )
        .join("\n");
      return "```" + (node.language || "") + "\n" + code + "\n```\n\n";

    case "link":
      const linkText = node.children
        .map((n: any) => renderNode(n, listDepth, options))
        .join("");
      return `[${linkText}](${node.url})`;

    case "table":
      return renderTable(node, listDepth, options);

    case "code-inline":
      return `\`${node.children.map((n: any) => renderNode(n, listDepth, options)).join("")}\``;

    case "mention": {
      if (options.mentionResolver) {
        return options.mentionResolver(node);
      }
      const label = node.label || node.resourceId || "mention";
      const resourceType = node.resourceType || "unknown";
      const resourceId = node.resourceId || "unknown";
      // AI / 工具链仍依赖 mention 的可逆文本表示。
      return `@[${resourceType}:${resourceId}|${label}]`;
    }

    case "image": {
      const alt = node.alt || "";
      const title = node.title ? ` "${node.title}"` : "";
      return `![${alt}](${node.url || ""}${title})`;
    }

    case "html-inline":
      return typeof node.html === "string" ? node.html : "";

    case "html-block":
      return typeof node.html === "string" ? `${node.html}\n\n` : "";

    case "thematic-break":
      return "---\n\n";

    default:
      return (
        renderTextNode(node) ||
        (node.children
          ? node.children
            .map((child: any) => renderNode(child, listDepth, options))
            .join("")
          : "")
      );
  }
}

/**
 * 把 Slate 转成给 AI / 工具消费的 markdown 文本。
 *
 * 目标：
 * - 保留结构信息，让模型和工具容易读。
 * - 保持 mention 等关键语义可逆。
 *
 * 非目标：
 * - 不保证展示侧完全复刻编辑器视觉。
 * - 不作为只读渲染缓存；展示侧请用 `slateToRenderMarkdown`。
 */
export function slateToSimplifiedMarkdown(
  nodes: any[],
  options: SimplifiedMarkdownOptions = {}
): string {
  if (!nodes || nodes.length === 0) {
    return "";
  }
  return (
    nodes
      .map((node) => renderNode(node, 0, options))
      .join("")
      .trim() + "\n"
  );
}
