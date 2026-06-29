export type CliLocale = "zh" | "en";

const ZH_PATTERNS = /^zh/i;

function detectLocaleFromEnv(): CliLocale | null {
  const env = process.env;
  const candidates = [env.LC_ALL, env.LC_CTYPE, env.LANG].filter(Boolean);
  for (const candidate of candidates) {
    if (ZH_PATTERNS.test(candidate!)) return "zh";
    if (candidate && !candidate.startsWith("C.") && !candidate.startsWith("POSIX")) {
      return "en";
    }
  }
  return null;
}

function detectLocale(): CliLocale {
  const fromEnv = detectLocaleFromEnv();
  if (fromEnv) return fromEnv;
  return "zh";
}

let currentLocale: CliLocale = detectLocale();

export function getCliLocale(): CliLocale {
  return currentLocale;
}

export function setCliLocale(locale: CliLocale) {
  currentLocale = locale;
}

const STRINGS = {
  welcomeHint: {
    en: "Tell nolo what you want. Use /help for commands. Shift+Enter for newline.",
    zh: "告诉 nolo 你想要什么。输入 /help 查看命令。Shift+Enter 换行。",
  },
  promptLabel: {
    en: "❯ ",
    zh: "❯ ",
  },
  continueLabel: {
    en: "│ ",
    zh: "│ ",
  },
  placeholder: {
    en: "Type a message or / for commands...",
    zh: "输入消息或 / 查看命令...",
  },
  newDialog: {
    en: "new dialog",
    zh: "新对话",
  },
  startedFreshDialog: {
    en: "Started a fresh dialog.",
    zh: "已开始新对话。",
  },
  bye: {
    en: "Bye.",
    zh: "再见。",
  },
} as const;

export type CliStringKey = keyof typeof STRINGS;

export function t(key: CliStringKey): string {
  return STRINGS[key][currentLocale];
}
