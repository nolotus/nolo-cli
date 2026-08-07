// packages/chat/dialog/actions/parseOAuthError.ts
//
// 把 provider 发送失败的错误文本结构化解析成用户可读、可操作的消息。
//
// 背景：桌面端 OAuth provider（Antigravity/Claude/ChatGPT/xAI）失败时，
// 错误形如 `local Antigravity OAuth provider failed: HTTP 403 {json}`，
// 其中 json 里 error.message 可能又是一层 JSON 字符串（双层转义），
// 例如 Google 的 VALIDATION_REQUIRED 错误。直接把原文塞进对话消息
// 会展示一坨转义 JSON，且正则抓 URL 会误抓嵌套链接（& 与内嵌 https://），
// 导致渲染/复制后链接失效（Google 返回 400 malformed）。
//
// 这里统一做一次结构化解析：尝试逐层 JSON.parse，提取 validation_url /
// validation_error_message / reason / status 等字段，生成简洁 markdown。

export type ParsedSendError = {
  /** 错误摘要（HTTP 状态 + provider 可读名），无原始 JSON dump */
  summary: string;
  /** Google 风格验证链接（若有） */
  validationUrl?: string;
  /** 验证链接的展示文案（Google 提供，如 "Verify your account"） */
  validationLinkText?: string;
  /** 附加辅助链接（如 Learn more） */
  extraLinks: Array<{ text: string; url: string }>;
  /** 若无法结构化解析，回退为原文（截断，避免超长） */
  fallbackText?: string;
};

const PROVIDER_NAMES: Record<string, string> = {
  antigravity: "Antigravity (Google)",
  claude: "Claude",
  chatgpt: "ChatGPT",
  xai: "xAI Grok",
  cursor: "Cursor",
  cloudflare: "Cloudflare",
};

/** 尝试把任意值解析为对象，失败返回 null */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 从 Google ErrorInfo details[].metadata 里收集验证链接 */
function collectValidationFromDetails(
  details: unknown
): { url?: string; text?: string; learnMoreUrl?: string } {
  if (!Array.isArray(details)) return {};
  let url: string | undefined;
  let text: string | undefined;
  let learnMoreUrl: string | undefined;
  for (const detail of details) {
    const rec = asRecord(detail);
    if (!rec) continue;
    const metadata = asRecord(rec.metadata);
    if (metadata) {
      url = url ?? asString(metadata.validation_url);
      text = text ?? asString(metadata.validation_url_link_text);
      learnMoreUrl = learnMoreUrl ?? asString(metadata.validation_learn_more_url);
    }
    const help = asRecord(rec) as Record<string, unknown> & { links?: unknown };
    if (Array.isArray(help.links)) {
      for (const link of help.links) {
        const linkRec = asRecord(link);
        if (!linkRec) continue;
        const linkUrl = asString(linkRec.url);
        if (!linkUrl) continue;
        const desc = asString(linkRec.description);
        if (!url && desc && /verify|continue/i.test(desc)) {
          url = linkUrl;
          text = desc;
        } else if (!learnMoreUrl && /learn more/i.test(desc ?? "")) {
          learnMoreUrl = linkUrl;
        }
      }
    }
  }
  return { url, text, learnMoreUrl };
}

/**
 * 主解析入口。errorMessage 形如：
 *   `local Antigravity OAuth provider failed: HTTP 403 {"error":{...}}`
 * 也可能带多层嵌套的 JSON 字符串 message。
 */
export function parseSendError(errorMessage: string): ParsedSendError {
  const summary = errorMessage
    .replace(/^local\s+/, "")
    .split("\n")[0]
    .trim();

  // 提取 provider 名与 HTTP 状态
  const providerMatch = errorMessage.match(/local\s+(\w+)\s+OAuth provider failed/i);
  const providerName = providerMatch
    ? PROVIDER_NAMES[providerMatch[1].toLowerCase()] ?? providerMatch[1]
    : undefined;
  const statusMatch = errorMessage.match(/HTTP\s+(\d{3})/);
  const status = statusMatch?.[1];

  // 提取 JSON 部分（HTTP xxx 之后）
  const jsonStart = errorMessage.indexOf("{");
  let payload: unknown = null;
  if (jsonStart >= 0) {
    let candidate = errorMessage.slice(jsonStart);
    // 可能是双层/多层嵌套：error.message 里又是 JSON 字符串。
    // 逐层尝试：如果外层解析后 message 是字符串且能再 parse，就用内层。
    for (let depth = 0; depth < 3; depth += 1) {
      try {
        const parsed = JSON.parse(candidate);
        payload = parsed;
        const message = asString((parsed as Record<string, unknown>)?.error?.message);
        if (message && message.trim().startsWith("{")) {
          // 内层又是一个 JSON 字符串，继续解析更内层
          candidate = message;
          continue;
        }
        break;
      } catch {
        break;
      }
    }
  }

  const errorRec = payload ? asRecord((payload as Record<string, unknown>).error) : null;
  const innerMessage = errorRec ? asString(errorRec.message) : undefined;
  const statusFromBody = errorRec ? asString(errorRec.status) : undefined;
  const details = errorRec?.details;
  const { url, text, learnMoreUrl } = collectValidationFromDetails(details);

  // reason/domain 在 details[0]（google.rpc.ErrorInfo）里，而非 error 顶层
  let reason = errorRec ? asString(errorRec.reason) : undefined;
  let domain = errorRec ? asString(errorRec.domain) : undefined;
  if (!reason && Array.isArray(details)) {
    const first = asRecord(details[0]);
    reason = first ? asString(first.reason) : undefined;
    domain = first ? asString(first.domain) : undefined;
  }

  // 组装可读摘要
  const parts: string[] = [];
  const head = providerName ? `${providerName} 连接失败` : "发送失败";
  parts.push(
    `${head}${status ? ` (HTTP ${status})` : ""}${statusFromBody ? ` ${statusFromBody}` : ""}`
  );
  if (reason) {
    parts.push(`原因：${reason}`);
  }
  if (domain) {
    parts.push(`服务：${domain}`);
  }
  const humanMessage =
    innerMessage && innerMessage.trim() !== "Verify your account to continue."
      ? innerMessage
      : undefined;
  if (humanMessage) {
    parts.push(`提示：${humanMessage}`);
  }

  const extraLinks: Array<{ text: string; url: string }> = [];
  if (learnMoreUrl) {
    extraLinks.push({ text: "了解更多", url: learnMoreUrl });
  }

  if (url) {
    return {
      summary: parts.join("\n"),
      validationUrl: url,
      validationLinkText: text ?? "验证我的账号",
      extraLinks,
    };
  }

  // 没有验证链接：回退为截断的原始摘要（避免超长 JSON 刷屏）
  const MAX_FALLBACK = 500;
  const fallbackText =
    errorMessage.length > MAX_FALLBACK
      ? `${errorMessage.slice(0, MAX_FALLBACK)}…`
      : errorMessage;
  return { summary: parts.join("\n"), extraLinks, fallbackText };
}

/** 生成最终写入对话消息的 markdown 文本 */
export function buildSendErrorMessageMarkdown(parsed: ParsedSendError): string {
  const lines: string[] = ["[发送失败]", "", parsed.summary];
  if (parsed.validationUrl) {
    lines.push(
      "",
      `请点击链接完成验证：`,
      `- [${parsed.validationLinkText ?? "验证我的账号"}](${parsed.validationUrl})`
    );
  }
  for (const link of parsed.extraLinks) {
    lines.push(`- [${link.text}](${link.url})`);
  }
  if (parsed.fallbackText && !parsed.validationUrl) {
    lines.push("", "```", parsed.fallbackText, "```");
  }
  return lines.join("\n");
}
