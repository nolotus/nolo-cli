// app/i18n/index.ts

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { Language } from "../i18n/types";
import { i18nConfig } from "./i18n.config";

i18n.use(initReactI18next).init({
  ...i18nConfig,
  lng: Language.ZH_CN, // 💡 强制设置为中文 (简体)
  fallbackLng: Language.ZH_CN, // 💡 失败回退也设为中文
  compatibilityJSON: 'v3', // Fixes "Intl not found" error on Android/RN
});

export default i18n;
