import { compactWhitespace } from "../../core/compactWhitespace";

const GENERATED_DIALOG_TITLE_MAX_CHARS = 28;
const FALLBACK_DIALOG_TITLE_MAX_CHARS = 24;

const WRAPPING_QUOTES_RE = /^[`"'“”‘’「」『』《》]+|[`"'“”‘’「」『』《》]+$/gu;
const TRAILING_TITLE_PUNCTUATION_RE = /[\s。！？!?；;，,、：:\-—–_…/\\|&]+$/u;
const HAS_CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/u;

const cleanTrailingPunctuation = (text: string): string => {
  let cleaned = text.trim();
  while (TRAILING_TITLE_PUNCTUATION_RE.test(cleaned)) {
    cleaned = cleaned.replace(TRAILING_TITLE_PUNCTUATION_RE, "").trim();
  }
  return cleaned;
};

const clip = (text: string, maxChars: number): string => {
  const trimmed = text.trim();
  if (!trimmed) return "";

  const isCjk = HAS_CJK_RE.test(trimmed);

  if (isCjk) {
    const chars = Array.from(trimmed);
    if (chars.length <= maxChars) {
      return cleanTrailingPunctuation(trimmed);
    }
    const truncated = chars.slice(0, Math.max(1, maxChars - 1)).join("");
    const cleaned = cleanTrailingPunctuation(truncated);
    return cleaned ? `${cleaned}…` : "…";
  }

  const words = trimmed.split(/\s+/);
  let isTruncated = false;
  let textToClip = trimmed;

  if (words.length > 6) {
    textToClip = words.slice(0, 6).join(" ");
    isTruncated = true;
  }

  const chars = Array.from(textToClip);
  if (chars.length > maxChars) {
    textToClip = chars.slice(0, Math.max(1, maxChars - 1)).join("");
    isTruncated = true;
  }

  if (isTruncated) {
    const cleaned = cleanTrailingPunctuation(textToClip);
    return cleaned ? `${cleaned}…` : "…";
  }

  return cleanTrailingPunctuation(trimmed);
};

const toSingleLine = (value: string): string =>
  value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";

const stripTitleFormatting = (value: string): string =>
  value
    .replace(/^(?:[-*#>]+\s*|\d+\.\s+)/, "")
    .replace(WRAPPING_QUOTES_RE, "")
    .replace(TRAILING_TITLE_PUNCTUATION_RE, "")
    .trim();

const pickLeadingClause = (value: string): string => {
  const firstLine = toSingleLine(value);
  if (!firstLine) return "";

  const separatorIndexes = [firstLine.indexOf("："), firstLine.indexOf(":")]
    .filter((index) => index > 0)
    .sort((left, right) => left - right);

  for (const index of separatorIndexes) {
    const clause = firstLine.slice(0, index).trim();
    if (clause.length >= 4) return clause;
  }

  return firstLine;
};

export const normalizeDialogTitle = (
  rawTitle: unknown,
  maxChars = GENERATED_DIALOG_TITLE_MAX_CHARS
): string => {
  if (typeof rawTitle !== "string") return "";

  const normalized = stripTitleFormatting(
    compactWhitespace(toSingleLine(rawTitle))
  );
  if (!normalized) return "";

  return clip(normalized, maxChars);
};

export const buildDialogFallbackTitleFromUserInput = (
  userInput: unknown,
  maxChars = FALLBACK_DIALOG_TITLE_MAX_CHARS
): string => {
  if (typeof userInput !== "string") return "";

  const candidate = pickLeadingClause(userInput);
  return normalizeDialogTitle(candidate || userInput, maxChars);
};

export const buildDialogFallbackTitleFromMessages = (
  messages: Array<{ role?: unknown; content?: unknown }>
): string => {
  for (const message of messages) {
    if (message?.role !== "user") continue;
    const title = buildDialogFallbackTitleFromUserInput(message?.content);
    if (title) return title;
  }

  return "";
};

export const resolveDialogTitle = (
  generatedTitle: unknown,
  fallbackTitle: string
): string => normalizeDialogTitle(generatedTitle) || fallbackTitle.trim();
