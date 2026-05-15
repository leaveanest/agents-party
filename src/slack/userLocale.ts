import { createTranslator, normalizeLocale, type Locale, type Translator } from "../i18n/index.js";
import type { UserSettingsRepository } from "../repositories/userSettings.js";

export async function resolveUserSettingsTranslator(input: {
  defaultLocale: Locale;
  enterpriseId: string | undefined;
  logger: unknown;
  repository: UserSettingsRepository | undefined;
  teamId: string | undefined;
  userId: string | undefined;
}): Promise<Translator> {
  return createTranslator(await resolveUserSettingsLocale(input));
}

export async function resolveUserSettingsLocale(input: {
  defaultLocale: Locale;
  enterpriseId: string | undefined;
  logger: unknown;
  repository: UserSettingsRepository | undefined;
  teamId: string | undefined;
  userId: string | undefined;
}): Promise<Locale> {
  if (
    input.repository === undefined ||
    (input.enterpriseId === undefined && input.teamId === undefined) ||
    input.userId === undefined
  ) {
    return input.defaultLocale;
  }
  try {
    const settings = await input.repository.findUserSettings({
      enterpriseId: input.enterpriseId,
      slackUserId: input.userId,
      teamId: input.teamId,
    });
    return normalizeLocale(settings?.locale) ?? input.defaultLocale;
  } catch (error) {
    logWarn(input.logger, "Failed to resolve user settings locale.", {
      error,
      enterpriseId: input.enterpriseId,
      slackUserId: input.userId,
      teamId: input.teamId,
    });
    return input.defaultLocale;
  }
}

function logWarn(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.warn === "function") {
    logger.warn(message, metadata);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
