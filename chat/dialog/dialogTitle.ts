const GENERATED_DIALOG_TITLE_MAX_CHARS = 36;
const FALLBACK_DIALOG_TITLE_MAX_CHARS = 24;

const WRAPPING_QUOTES_RE = /^[`"'“”‘’「」『』《》]+|[`"'“”‘’「」『』《》]+$/gu;
const TRAILING_TITLE_PUNCTUATION_RE = /[。！？!?；;，,、：:]+$/u;

const clip = (text: string, maxChars: number): string =>
  text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars - 1).trimEnd()}…`;

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
    toSingleLine(rawTitle).replace(/\s+/g, " ").trim()
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
