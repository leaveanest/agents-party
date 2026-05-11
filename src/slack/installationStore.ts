import type { Installation, InstallationQuery, InstallationStore } from "@slack/bolt";

export type SlackInstallationRow = {
  appId: string | undefined;
  botId: string | undefined;
  botRefreshToken: string | undefined;
  botScopes: string | undefined;
  botToken: string | undefined;
  botTokenExpiresAt: Date | undefined;
  botUserId: string | undefined;
  enterpriseId: string | undefined;
  enterpriseName: string | undefined;
  enterpriseUrl: string | undefined;
  incomingWebhookChannel: string | undefined;
  incomingWebhookChannelId: string | undefined;
  incomingWebhookConfigurationUrl: string | undefined;
  incomingWebhookUrl: string | undefined;
  installedAt: Date;
  isEnterpriseInstall: boolean;
  payload: Record<string, unknown>;
  teamId: string | undefined;
  teamName: string | undefined;
  tokenType: "bot" | undefined;
  userId: string;
  userRefreshToken: string | undefined;
  userScopes: string | undefined;
  userToken: string | undefined;
  userTokenExpiresAt: Date | undefined;
};

export type SlackBotRow = {
  appId: string | undefined;
  botId: string;
  botRefreshToken: string | undefined;
  botScopes: string | undefined;
  botToken: string;
  botTokenExpiresAt: Date | undefined;
  botUserId: string;
  enterpriseId: string | undefined;
  enterpriseName: string | undefined;
  installedAt: Date;
  isEnterpriseInstall: boolean;
  payload: Record<string, unknown>;
  teamId: string | undefined;
  teamName: string | undefined;
};

export type SlackInstallationLookup = {
  enterpriseId: string | undefined;
  isEnterpriseInstall: boolean;
  teamId: string | undefined;
  userId?: string;
};

export type SlackInstallationRepository = {
  deleteBot(lookup: SlackInstallationLookup): Promise<void>;
  deleteInstallation(lookup: SlackInstallationLookup): Promise<void>;
  findBot(lookup: SlackInstallationLookup): Promise<SlackBotRow | undefined>;
  findInstallation(lookup: SlackInstallationLookup): Promise<SlackInstallationRow | undefined>;
  saveInstallationBundle(
    installation: SlackInstallationRow,
    bot: SlackBotRow | undefined,
  ): Promise<void>;
};

export class RepositorySlackInstallationStore implements InstallationStore {
  constructor(private readonly repository: SlackInstallationRepository) {}

  /**
   * Persist one Slack OAuth installation and its bot credentials.
   *
   * @param installation - Slack OAuth installation produced by Bolt.
   * @returns Promise that resolves after persistence completes.
   */
  async storeInstallation<AuthVersion extends "v1" | "v2">(
    installation: Installation<AuthVersion, boolean>,
  ): Promise<void> {
    const installedAt = new Date();
    await this.repository.saveInstallationBundle(
      installationToRow(installation, installedAt),
      installation.bot === undefined ? undefined : botToRow(installation, installedAt),
    );
  }

  /**
   * Fetch a Slack OAuth installation for Bolt authorization.
   *
   * @param query - Slack installation lookup supplied by Bolt.
   * @returns Stored installation with latest bot credentials rehydrated.
   * @throws Error when no stored installation exists for the supplied scope.
   */
  async fetchInstallation(
    query: InstallationQuery<boolean>,
  ): Promise<Installation<"v1" | "v2", boolean>> {
    const lookup = installationQueryToLookup(query);
    const row = await this.repository.findInstallation(lookup);
    if (row === undefined) {
      throw new Error("Slack installation not found for the requested scope.");
    }

    const bot = await this.repository.findBot(lookup);
    return rowToInstallation(row, bot);
  }

  /**
   * Delete stored installation and bot credentials for a Slack scope.
   *
   * @param query - Slack installation lookup supplied by Bolt.
   * @returns Promise that resolves after deletion completes.
   */
  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    const lookup = installationQueryToLookup(query);
    await this.repository.deleteInstallation(lookup);
    if (lookup.userId === undefined) {
      await this.repository.deleteBot(lookup);
    }
  }
}

export function installationQueryToLookup(
  query: InstallationQuery<boolean>,
): SlackInstallationLookup {
  return {
    enterpriseId: query.enterpriseId,
    isEnterpriseInstall: query.isEnterpriseInstall,
    teamId: query.isEnterpriseInstall ? undefined : query.teamId,
    userId: query.userId,
  };
}

function installationToRow<AuthVersion extends "v1" | "v2">(
  installation: Installation<AuthVersion, boolean>,
  installedAt: Date,
): SlackInstallationRow {
  return {
    appId: installation.appId,
    botId: installation.bot?.id,
    botRefreshToken: installation.bot?.refreshToken,
    botScopes: joinScopes(installation.bot?.scopes),
    botToken: installation.bot?.token,
    botTokenExpiresAt: epochSecondsToDate(installation.bot?.expiresAt),
    botUserId: installation.bot?.userId,
    enterpriseId: installation.enterprise?.id,
    enterpriseName: installation.enterprise?.name,
    enterpriseUrl: installation.enterpriseUrl,
    incomingWebhookChannel: installation.incomingWebhook?.channel,
    incomingWebhookChannelId: installation.incomingWebhook?.channelId,
    incomingWebhookConfigurationUrl: installation.incomingWebhook?.configurationUrl,
    incomingWebhookUrl: installation.incomingWebhook?.url,
    installedAt,
    isEnterpriseInstall: installation.isEnterpriseInstall ?? false,
    payload: toJsonObject(installation),
    teamId: installation.team?.id,
    teamName: installation.team?.name,
    tokenType: installation.tokenType,
    userId: installation.user.id,
    userRefreshToken: installation.user.refreshToken,
    userScopes: joinScopes(installation.user.scopes),
    userToken: installation.user.token,
    userTokenExpiresAt: epochSecondsToDate(installation.user.expiresAt),
  };
}

function botToRow<AuthVersion extends "v1" | "v2">(
  installation: Installation<AuthVersion, boolean>,
  installedAt: Date,
): SlackBotRow {
  const { bot } = installation;
  if (bot === undefined) {
    throw new Error("Cannot persist Slack bot row without bot credentials.");
  }
  return {
    appId: installation.appId,
    botId: bot.id,
    botRefreshToken: bot.refreshToken,
    botScopes: joinScopes(bot.scopes),
    botToken: bot.token,
    botTokenExpiresAt: epochSecondsToDate(bot.expiresAt),
    botUserId: bot.userId,
    enterpriseId: installation.enterprise?.id,
    enterpriseName: installation.enterprise?.name,
    installedAt,
    isEnterpriseInstall: installation.isEnterpriseInstall ?? false,
    payload: toJsonObject({
      appId: installation.appId,
      bot,
      enterprise: installation.enterprise,
      isEnterpriseInstall: installation.isEnterpriseInstall ?? false,
      team: installation.team,
    }),
    teamId: installation.team?.id,
    teamName: installation.team?.name,
  };
}

function rowToInstallation(
  row: SlackInstallationRow,
  latestBot: SlackBotRow | undefined,
): Installation<"v1" | "v2", boolean> {
  const botSource = latestBot ?? row;
  return {
    appId: row.appId,
    authVersion: "v2",
    bot:
      botSource.botToken === undefined ||
      botSource.botId === undefined ||
      botSource.botUserId === undefined
        ? undefined
        : {
            id: botSource.botId,
            refreshToken: botSource.botRefreshToken,
            scopes: splitScopes(botSource.botScopes),
            token: botSource.botToken,
            userId: botSource.botUserId,
            expiresAt: dateToEpochSeconds(botSource.botTokenExpiresAt),
          },
    enterprise:
      row.enterpriseId === undefined
        ? undefined
        : {
            id: row.enterpriseId,
            name: row.enterpriseName,
          },
    enterpriseUrl: row.enterpriseUrl,
    incomingWebhook:
      row.incomingWebhookUrl === undefined
        ? undefined
        : {
            channel: row.incomingWebhookChannel,
            channelId: row.incomingWebhookChannelId,
            configurationUrl: row.incomingWebhookConfigurationUrl,
            url: row.incomingWebhookUrl,
          },
    isEnterpriseInstall: row.isEnterpriseInstall,
    team:
      row.teamId === undefined
        ? undefined
        : {
            id: row.teamId,
            name: row.teamName,
          },
    tokenType: row.tokenType,
    user: {
      id: row.userId,
      refreshToken: row.userRefreshToken,
      scopes: splitScopes(row.userScopes),
      token: row.userToken,
      expiresAt: dateToEpochSeconds(row.userTokenExpiresAt),
    },
  } as Installation<"v1" | "v2", boolean>;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function joinScopes(scopes: string[] | undefined): string | undefined {
  return scopes === undefined || scopes.length === 0 ? undefined : scopes.join(",");
}

function splitScopes(scopes: string | undefined): string[] | undefined {
  return scopes === undefined || scopes.length === 0 ? undefined : scopes.split(",");
}

function epochSecondsToDate(value: number | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value * 1000);
}

function dateToEpochSeconds(value: Date | undefined): number | undefined {
  return value === undefined ? undefined : Math.floor(value.getTime() / 1000);
}
