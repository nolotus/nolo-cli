import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { Language } from "../i18n/types";
import { i18nBaseConfig } from "./i18n.base";

i18n.use(initReactI18next).init({
  ...i18nBaseConfig,
  lng: Language.ZH_CN,
  fallbackLng: Language.ZH_CN,
  compatibilityJSON: "v3",
});

export default i18n;
