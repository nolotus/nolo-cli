export const FONT_PRESET_VALUES = [
  "system",
  "hei",
  "song",
  "kai",
  "fang-song",
] as const;

export type FontPreset = (typeof FONT_PRESET_VALUES)[number];

export const DEFAULT_FONT_PRESET: FontPreset = "system";
export const FONT_PRESET_STORAGE_KEY = "nolo-font-preset";

const FONT_PRESET_ALIASES: Record<string, FontPreset> = {
  system: "system",
  default: "system",
  hei: "hei",
  heiti: "hei",
  sans: "hei",
  song: "song",
  songti: "song",
  serif: "song",
  kai: "kai",
  kaiti: "kai",
  "kai-ti": "kai",
  "fang-song": "fang-song",
  fangsong: "fang-song",
  "fang song": "fang-song",
};

export const normalizeFontPreset = (value: unknown): FontPreset | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return FONT_PRESET_ALIASES[normalized];
};

export const FONT_PRESET_CSS_VARIABLES: Record<
  FontPreset,
  Record<string, string>
> = {
  system: {
    ui: "var(--font-ui-system)",
    "sans-zh": "var(--font-sans-zh-system)",
    "sans-en": "var(--font-sans-en-system)",
    "sans-ja": "var(--font-sans-ja-system)",
    "sans-ko": "var(--font-sans-ko-system)",
  },
  hei: {
    ui: "var(--font-ui-hei)",
    "sans-zh": "var(--font-sans-zh-hei)",
    "sans-en": "var(--font-sans-en-hei)",
    "sans-ja": "var(--font-sans-ja-system)",
    "sans-ko": "var(--font-sans-ko-system)",
  },
  song: {
    ui: "var(--font-ui-song)",
    "sans-zh": "var(--font-sans-zh-song)",
    "sans-en": "var(--font-sans-en-song)",
    "sans-ja": "var(--font-sans-ja-system)",
    "sans-ko": "var(--font-sans-ko-system)",
  },
  kai: {
    ui: "var(--font-ui-kai)",
    "sans-zh": "var(--font-sans-zh-kai)",
    "sans-en": "var(--font-sans-en-kai)",
    "sans-ja": "var(--font-sans-ja-system)",
    "sans-ko": "var(--font-sans-ko-system)",
  },
  "fang-song": {
    ui: "var(--font-ui-fang-song)",
    "sans-zh": "var(--font-sans-zh-fang-song)",
    "sans-en": "var(--font-sans-en-fang-song)",
    "sans-ja": "var(--font-sans-ja-system)",
    "sans-ko": "var(--font-sans-ko-system)",
  },
};

