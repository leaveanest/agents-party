import { WebClient } from "@slack/web-api";
import type { Pool } from "pg";

import type { AppSettings } from "../config.js";
import { PostgresSlackInstallationRepository } from "../infrastructure/postgres/slackInstallationRepository.js";

export type SlackWebClientProvider = {
  close(): Promise<void>;
  forTeam(input: {
    enterpriseId?: string;
    isEnterpriseInstall?: boolean;
    teamId: string;
  }): Promise<WebClient>;
};

export function createSlackWebClientProvider(
  settings: AppSettings,
  options: { pool?: Pool } = {},
): SlackWebClientProvider {
  const repository =
    settings.slackInstallationStoreEnabled &&
    settings.slackClientId !== undefined &&
    (settings.databaseUrl !== undefined || options.pool !== undefined)
      ? new PostgresSlackInstallationRepository(settings.slackClientId, {
          databaseUrl: settings.databaseUrl,
          pool: options.pool,
        })
      : undefined;
  return {
    async close() {
      await repository?.close();
    },
    async forTeam(input) {
      if (repository !== undefined) {
        const bot = await repository.findBot({
          enterpriseId: input.enterpriseId,
          isEnterpriseInstall: input.isEnterpriseInstall ?? false,
          teamId: input.teamId,
        });
        if (bot !== undefined) {
          return new WebClient(bot.botToken);
        }
        throw new Error("Slack bot token is not available from installation storage.");
      }
      if (settings.slackBotToken !== undefined) {
        return new WebClient(settings.slackBotToken);
      }
      throw new Error("Slack bot token is not available for worker delivery.");
    },
  };
}
