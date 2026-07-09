type RenderMarkdownOptions = {
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

function renderPlainText(node: any, options: RenderMarkdownOptions = {}): string {
  if (!node) return "";
  if (typeof node.text === "string") return renderTextNode(node);
  if (!Array.isArray(node.children)) return "";
  return node.children.map((child: any) => renderPlainText(child, options)).join("");
}

function renderTable(node: any, options: RenderMarkdownOptions): string {
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

  return [header, divider, ...body]
    .map((cells) => `| ${cells.join(" | ")} |`)
    .join("\n") + "\n\n";
}

function renderListItem(
  node: any,
  listDepth: number,
  ordered: boolean,
  start: number,
  index: number,
  options: RenderMarkdownOptions = {}
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
  const renderedSegments = segments
    .map((child: any) => renderNode(child, listDepth + 1, options).trimEnd())
    .filter(Boolean);

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

function renderNode(
  node: any,
  listDepth = 0,
  options: RenderMarkdownOptions = {}
): string {
  if (!node) return "";

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

    case "quote": {
      const content = node.children
        .map((n: any) => renderNode(n, listDepth, options))
        .join("")
        .trim();
      return `> ${content.replace(/\n/g, "\n> ")}\n\n`;
    }

    case "code-block": {
      const code = node.children
        .map((line: any) =>
          (line.children || []).map((text: any) => text.text).join("")
        )
        .join("\n");
      return "```" + (node.language || "") + "\n" + code + "\n```\n\n";
    }

    case "link": {
      const linkText = node.children
        .map((n: any) => renderNode(n, listDepth, options))
        .join("");
      return `[${linkText}](${node.url})`;
    }

    case "table":
      return renderTable(node, options);

    case "code-inline":
      return `\`${node.children.map((n: any) => renderNode(n, listDepth, options)).join("")}\``;

    case "mention": {
      if (options.mentionResolver) {
        return options.mentionResolver(node);
      }
      const label = node.label || node.resourceId || "mention";
      const resourceType = node.resourceType || "unknown";
      const resourceId = node.resourceId || "unknown";
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
 * 为只读展示生成 Markdown 缓存。
 *
 * 目标：
 * - 优先保证给 `Bun.markdown.*` 的结构稳定、可渲染。
 * - 用于只读展示缓存或 legacy `content` 桥接。
 *
 * 非目标：
 * - 不把它当主数据源。页面真源始终是 `slateData`。
 * - 不承担 AI 摘要 / 工具读取的职责。
 */
export function slateToRenderMarkdown(
  nodes: any[],
  options: RenderMarkdownOptions = {}
): string {
  if (!nodes || nodes.length === 0) return "";

  return (
    nodes
      .map((node) => renderNode(node, 0, options))
      .join("")
      .trim() + "\n"
  );
}
