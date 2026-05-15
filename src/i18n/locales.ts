export const DEFAULT_LOCALE = "ja";
export const FALLBACK_LOCALE = "en";
export const supportedLocales = ["ja", "en"] as const;

export type Locale = (typeof supportedLocales)[number];

export function isSupportedLocale(value: string): value is Locale {
  return supportedLocales.includes(value as Locale);
}

export function normalizeLocale(value: string | undefined): Locale | undefined {
  const normalized = value?.trim().replace("_", "-").toLocaleLowerCase();
  if (normalized === undefined || normalized === "") {
    return undefined;
  }
  const language = normalized.split("-")[0];
  return isSupportedLocale(language) ? language : undefined;
}

export function resolveLocale(
  value: string | undefined,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  return normalizeLocale(value) ?? fallback;
}
