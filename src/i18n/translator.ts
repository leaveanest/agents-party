import i18next from "i18next";

import { DEFAULT_LOCALE, FALLBACK_LOCALE, type Locale, supportedLocales } from "./locales.js";
import { resources, type TranslationKey } from "./resources.js";

const i18n = i18next.createInstance();

void i18n.init({
  fallbackLng: FALLBACK_LOCALE,
  initAsync: false,
  interpolation: { escapeValue: false },
  lng: DEFAULT_LOCALE,
  resources,
  supportedLngs: [...supportedLocales],
});

export type TranslationValues = Record<string, string | number | boolean | null | undefined>;

export type Translator = {
  locale: Locale;
  t(key: TranslationKey, values?: TranslationValues): string;
};

export function createTranslator(locale: Locale): Translator {
  const t = i18n.getFixedT(locale);
  return {
    locale,
    t(key, values) {
      return t(key, values);
    },
  };
}

export const defaultTranslator = createTranslator(FALLBACK_LOCALE);
