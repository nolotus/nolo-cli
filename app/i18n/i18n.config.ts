// src/app/i18n/i18n.config.ts
import { Language } from "../i18n/types";
import { i18nBaseConfig } from "./i18n.base";
import aiLocale from "../../ai/ai.locale";
import chatLocale from "../../chat/chat.locale";
import spaceLocale from "../../create/space/space.locale";
import interfaceLocale from "./translations/interface.locale";
import errorLocale from "./translations/error.locale";
import seoLocale from "./translations/seo.locale";
import appBuilderLocale from "./translations/appBuilder.locale";
import pricingLocale from "./translations/pricing.locale";
import privacyLocale from "./translations/privacy.locale";
import termsLocale from "./translations/terms.locale";
import localFirstLocale from "./translations/localFirst.locale";

export const resources = {
  [Language.EN]: {
    common: {
      ...interfaceLocale[Language.EN].translation,
      ...errorLocale[Language.EN].translation,
      ...appBuilderLocale[Language.EN].translation,
      ...pricingLocale[Language.EN].translation,
      ...privacyLocale[Language.EN].translation,
      ...termsLocale[Language.EN].translation,
      ...localFirstLocale[Language.EN].translation,
      seo: seoLocale[Language.EN],
    },
    space: spaceLocale[Language.EN].translation,
    ai: aiLocale[Language.EN].translation,
    chat: chatLocale[Language.EN].translation,
  },
  [Language.ZH_CN]: {
    common: {
      ...interfaceLocale[Language.ZH_CN].translation,
      ...errorLocale[Language.ZH_CN].translation,
      ...appBuilderLocale[Language.ZH_CN].translation,
      ...pricingLocale[Language.ZH_CN].translation,
      ...privacyLocale[Language.ZH_CN].translation,
      ...termsLocale[Language.ZH_CN].translation,
      ...localFirstLocale[Language.ZH_CN].translation,
      seo: seoLocale[Language.ZH_CN],
    },
    space: spaceLocale[Language.ZH_CN].translation,
    ai: aiLocale[Language.ZH_CN].translation,
    chat: chatLocale[Language.ZH_CN].translation,
  },
  [Language.ZH_HANT]: {
    common: {
      ...interfaceLocale[Language.ZH_HANT].translation,
      ...errorLocale[Language.ZH_HANT].translation,
      ...appBuilderLocale[Language.ZH_HANT].translation,
      ...pricingLocale[Language.ZH_HANT].translation,
      ...privacyLocale[Language.ZH_HANT].translation,
      ...termsLocale[Language.ZH_HANT].translation,
      ...localFirstLocale[Language.ZH_HANT].translation,
      seo: seoLocale[Language.ZH_HANT],
    },
    space: spaceLocale[Language.ZH_HANT].translation,
    ai: aiLocale[Language.ZH_HANT].translation,
    chat: chatLocale[Language.ZH_HANT].translation,
  },
  [Language.JA]: {
    common: {
      ...interfaceLocale[Language.JA].translation,
      ...errorLocale[Language.JA].translation,
      ...appBuilderLocale[Language.JA].translation,
      ...pricingLocale[Language.JA].translation,
      ...privacyLocale[Language.JA].translation,
      ...termsLocale[Language.JA].translation,
      ...localFirstLocale[Language.JA].translation,
      seo: seoLocale[Language.JA],
    },
    space: spaceLocale[Language.JA].translation,
    ai: aiLocale[Language.JA].translation,
    chat: chatLocale[Language.JA].translation,
  },
};

export const i18nConfig = {
  ...i18nBaseConfig,
  resources,
};
