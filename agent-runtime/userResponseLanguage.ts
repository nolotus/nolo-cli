/** Platform-owned response-language context shared by every runtime. */

export type UserResponseLanguageInput = {
  responseLanguage?: unknown;
  language?: unknown;
  fallbackLanguage?: unknown;
};

export type ResolvedUserResponseLanguage = {
  locale: string;
  languageName: string;
};

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  "en-US": "English",
  "en-GB": "English",
  zh: "Simplified Chinese",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  "zh-HK": "Traditional Chinese",
  ja: "Japanese",
  "ja-JP": "Japanese",
  ko: "Korean",
  "ko-KR": "Korean",
  fr: "French",
  de: "German",
  es: "Spanish",
  pt: "Portuguese",
  ru: "Russian",
};

const LANGUAGE_DISPLAY_NAMES = new Intl.DisplayNames(["en"], {
  type: "language",
});

const asLocale = (value: unknown): string =>
  typeof value === "string"
    ? value.trim().split(".", 1)[0]?.replace(/_/g, "-") ?? ""
    : "";

const normalizeLocale = (value: string): string => {
  if (!value) return "en-US";
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(value);
  } catch {
    return "en-US";
  }
  const language = locale.language.toLowerCase();
  const region = locale.region?.toUpperCase();
  const script = locale.script;
  if (language === "zh") {
    if (script === "Hant" || region === "TW" || region === "HK" || region === "MO") {
      return "zh-TW";
    }
    return "zh-CN";
  }
  if (language === "en") return region === "GB" ? "en-GB" : "en-US";
  if (region) return `${language}-${region}`;
  return language;
};

export const resolveUserResponseLanguage = (
  input: UserResponseLanguageInput = {},
): ResolvedUserResponseLanguage => {
  const raw =
    asLocale(input.responseLanguage) ||
    asLocale(input.language) ||
    asLocale(input.fallbackLanguage) ||
    "en-US";
  const locale = normalizeLocale(raw);
  return {
    locale,
    languageName:
      LANGUAGE_NAMES[locale] ??
      LANGUAGE_NAMES[locale.split("-")[0]] ??
      LANGUAGE_DISPLAY_NAMES.of(locale) ??
      locale,
  };
};

export const buildUserResponseLanguageReadFailureContext = (args: {
  userId: string;
  error: unknown;
}): string => {
  // Keep the failure visible to the model without exposing storage paths,
  // backend details, or other raw error content that it could echo to users.
  void args.error;
  return [
    "--- 平台回复语言策略 ---",
    `读取用户 ${args.userId} 的回复语言设置失败（存储读取错误）。`,
    "请根据当前对话中用户明确使用或要求的语言回复；不要猜测用户的语言偏好。",
  ].join("\n");
};

export const buildUserResponseLanguageContext = (
  input: UserResponseLanguageInput = {},
): string => {
  const { locale, languageName } = resolveUserResponseLanguage(input);
  return [
    "--- 平台回复语言策略 ---",
    `用户客户端语言：${languageName}（${locale}）`,
    "默认使用用户客户端语言回复。",
    "用户在当前对话中明确要求使用其他语言时，遵循用户的明确要求。",
    "单个通用词或短语（例如 hi、ok、thanks）不改变已经建立的交流语言。",
    "Agent 的角色、skill、model 不得自行覆盖这条平台回复语言策略。",
  ].join("\n");
};
