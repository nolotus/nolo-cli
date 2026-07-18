import { Language } from "../i18n/types";

export const i18nBaseConfig = {
  defaultNS: "common",
  ns: ["common", "space", "ai", "chat"],
  interpolation: { escapeValue: false },
  fallbackLng: {
    zh: [Language.ZH_CN, Language.EN],
    "zh-TW": [Language.ZH_HANT],
    "zh-HK": [Language.ZH_HANT],
    "zh-MO": [Language.ZH_HANT],
    default: [Language.EN],
  },
};
