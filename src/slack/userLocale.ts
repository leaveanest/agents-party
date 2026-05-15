import { createTranslator, normalizeLocale, type Locale, type Translator } from "../i18n/index.js";

export type SlackUserLocaleClient = {
  users?: {
    info(input: { include_locale?: boolean; user: string }): Promise<unknown>;
  };
};

export async function resolveSlackUserTranslator(input: {
  client: SlackUserLocaleClient;
  defaultLocale: Locale;
  logger: unknown;
  userId: string | undefined;
}): Promise<Translator> {
  return createTranslator(await resolveSlackUserLocale(input));
}

export async function resolveSlackUserLocale(input: {
  client: SlackUserLocaleClient;
  defaultLocale: Locale;
  logger: unknown;
  userId: string | undefined;
}): Promise<Locale> {
  const info = input.client.users?.info;
  if (info === undefined || input.userId === undefined) {
    return input.defaultLocale;
  }
  try {
    const response = await info({ include_locale: true, user: input.userId });
    const locale = normalizeLocale(readSlackUserLocale(response));
    return locale ?? input.defaultLocale;
  } catch (error) {
    logWarn(input.logger, "Failed to resolve Slack user locale.", {
      error,
      slackUserId: input.userId,
    });
    return input.defaultLocale;
  }
}

function readSlackUserLocale(response: unknown): string | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  const user = response.user;
  if (!isRecord(user)) {
    return undefined;
  }
  const locale = user.locale;
  return typeof locale === "string" && locale.trim().length > 0 ? locale : undefined;
}

function logWarn(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.warn === "function") {
    logger.warn(message, metadata);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
