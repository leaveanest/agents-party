import { Pool, type QueryResult, type QueryResultRow } from "pg";

import type {
  SlackInstalledWorkspace,
  SlackBotRow,
  SlackInstallationLookup,
  SlackInstallationRepository,
  SlackInstallationRow,
} from "../../slack/installationStore.js";

export class PostgresSlackInstallationRepository implements SlackInstallationRepository {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(
    private readonly clientId: string,
    options: { databaseUrl?: string; pool?: Pool },
  ) {
    if (options.pool === undefined && options.databaseUrl === undefined) {
      throw new Error("databaseUrl or pool is required for Slack installation storage.");
    }
    this.pool = options.pool ?? new Pool({ connectionString: options.databaseUrl });
    this.ownsPool = options.pool === undefined;
  }

  /**
   * Close the owned PostgreSQL pool.
   *
   * @returns Promise that resolves after the pool is closed.
   */
  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async saveInstallationBundle(
    installation: SlackInstallationRow,
    bot: SlackBotRow | undefined,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await insertInstallation(client, this.clientId, installation);
      if (bot !== undefined) {
        await insertBot(client, this.clientId, bot);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveInstallation(installation: SlackInstallationRow): Promise<void> {
    await insertInstallation(this.pool, this.clientId, installation);
  }

  async saveBot(bot: SlackBotRow): Promise<void> {
    await insertBot(this.pool, this.clientId, bot);
  }

  async findInstallation(
    lookup: SlackInstallationLookup,
  ): Promise<SlackInstallationRow | undefined> {
    const result = await this.pool.query<SlackInstallationRecord>(
      `select * from slack_installations
       where client_id = $1
         and enterprise_id is not distinct from $2
         and team_id is not distinct from $3
         and ($4::text is null or user_id = $4)
       order by installed_at desc
       limit 1`,
      [this.clientId, lookup.enterpriseId, resolvedTeamId(lookup), lookup.userId],
    );
    const [row] = result.rows;
    return row === undefined ? undefined : installationRecordToRow(row);
  }

  async findBot(lookup: SlackInstallationLookup): Promise<SlackBotRow | undefined> {
    const result = await this.pool.query<SlackBotRecord>(
      `select * from slack_bots
       where client_id = $1
         and enterprise_id is not distinct from $2
         and team_id is not distinct from $3
         and bot_token is not null
       order by installed_at desc
       limit 1`,
      [this.clientId, lookup.enterpriseId, resolvedTeamId(lookup)],
    );
    const [row] = result.rows;
    return row === undefined ? undefined : botRecordToRow(row);
  }

  async listInstalledWorkspaces(input: {
    enterpriseId?: string;
  }): Promise<SlackInstalledWorkspace[]> {
    const result = await this.pool.query<InstalledWorkspaceRecord>(
      `with latest_bots as (
         select distinct on (team_id)
                enterprise_id, team_id, team_name, installed_at
           from slack_bots
          where client_id = $1
            and ($2::text is null or enterprise_id is not distinct from $2)
            and team_id is not null
            and bot_token is not null
          order by team_id, installed_at desc
       ),
       latest_names as (
         select distinct on (team_id)
                team_id, team_name
           from slack_installations
          where client_id = $1
            and ($2::text is null or enterprise_id is not distinct from $2)
            and team_id is not null
            and team_name is not null
          order by team_id, installed_at desc
       )
       select latest_bots.enterprise_id,
              latest_bots.team_id,
              coalesce(latest_bots.team_name, latest_names.team_name) as team_name,
              latest_bots.installed_at
         from latest_bots
         left join latest_names on latest_names.team_id = latest_bots.team_id
        order by coalesce(latest_bots.team_name, latest_names.team_name, latest_bots.team_id),
                 latest_bots.team_id`,
      [this.clientId, input.enterpriseId ?? null],
    );
    return result.rows.map((row) => ({
      enterpriseId: nullable(row.enterprise_id),
      installedAt: row.installed_at,
      teamId: row.team_id,
      teamName: nullable(row.team_name),
    }));
  }

  async deleteInstallation(lookup: SlackInstallationLookup): Promise<void> {
    await this.pool.query(
      `delete from slack_installations
       where client_id = $1
         and enterprise_id is not distinct from $2
         and team_id is not distinct from $3
         and ($4::text is null or user_id = $4)`,
      [this.clientId, lookup.enterpriseId, resolvedTeamId(lookup), lookup.userId],
    );
  }

  async deleteBot(lookup: SlackInstallationLookup): Promise<void> {
    await this.pool.query(
      `delete from slack_bots
       where client_id = $1
         and enterprise_id is not distinct from $2
         and team_id is not distinct from $3`,
      [this.clientId, lookup.enterpriseId, resolvedTeamId(lookup)],
    );
  }
}

type Queryable = {
  query<TResult extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<TResult>>;
};

async function insertInstallation(
  queryable: Queryable,
  clientId: string,
  installation: SlackInstallationRow,
): Promise<void> {
  await queryable.query(
    `insert into slack_installations (
        client_id, app_id, enterprise_id, enterprise_name, enterprise_url,
        team_id, team_name, bot_token, bot_id, bot_user_id, bot_scopes,
        bot_refresh_token, bot_token_expires_at, user_id, user_token,
        user_scopes, user_refresh_token, user_token_expires_at,
        incoming_webhook_url, incoming_webhook_channel,
        incoming_webhook_channel_id, incoming_webhook_configuration_url,
        is_enterprise_install, token_type, installed_at, payload
      ) values (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17, $18,
        $19, $20,
        $21, $22,
        $23, $24, $25, $26::json
      )`,
    [
      clientId,
      installation.appId,
      installation.enterpriseId,
      installation.enterpriseName,
      installation.enterpriseUrl,
      installation.teamId,
      installation.teamName,
      installation.botToken,
      installation.botId,
      installation.botUserId,
      installation.botScopes,
      installation.botRefreshToken,
      installation.botTokenExpiresAt,
      installation.userId,
      installation.userToken,
      installation.userScopes,
      installation.userRefreshToken,
      installation.userTokenExpiresAt,
      installation.incomingWebhookUrl,
      installation.incomingWebhookChannel,
      installation.incomingWebhookChannelId,
      installation.incomingWebhookConfigurationUrl,
      installation.isEnterpriseInstall,
      installation.tokenType,
      installation.installedAt,
      JSON.stringify(installation.payload),
    ],
  );
}

async function insertBot(queryable: Queryable, clientId: string, bot: SlackBotRow): Promise<void> {
  await queryable.query(
    `insert into slack_bots (
        client_id, app_id, enterprise_id, enterprise_name, team_id, team_name,
        bot_token, bot_id, bot_user_id, bot_scopes, bot_refresh_token,
        bot_token_expires_at, is_enterprise_install, installed_at, payload
      ) values (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15::json
      )`,
    [
      clientId,
      bot.appId,
      bot.enterpriseId,
      bot.enterpriseName,
      bot.teamId,
      bot.teamName,
      bot.botToken,
      bot.botId,
      bot.botUserId,
      bot.botScopes,
      bot.botRefreshToken,
      bot.botTokenExpiresAt,
      bot.isEnterpriseInstall,
      bot.installedAt,
      JSON.stringify(bot.payload),
    ],
  );
}

type SlackInstallationRecord = QueryResultRow & {
  app_id: string | null;
  bot_id: string | null;
  bot_refresh_token: string | null;
  bot_scopes: string | null;
  bot_token: string | null;
  bot_token_expires_at: Date | null;
  bot_user_id: string | null;
  enterprise_id: string | null;
  enterprise_name: string | null;
  enterprise_url: string | null;
  incoming_webhook_channel: string | null;
  incoming_webhook_channel_id: string | null;
  incoming_webhook_configuration_url: string | null;
  incoming_webhook_url: string | null;
  installed_at: Date;
  is_enterprise_install: boolean;
  payload: Record<string, unknown>;
  team_id: string | null;
  team_name: string | null;
  token_type: "bot" | null;
  user_id: string;
  user_refresh_token: string | null;
  user_scopes: string | null;
  user_token: string | null;
  user_token_expires_at: Date | null;
};

type SlackBotRecord = QueryResultRow & {
  app_id: string | null;
  bot_id: string | null;
  bot_refresh_token: string | null;
  bot_scopes: string | null;
  bot_token: string | null;
  bot_token_expires_at: Date | null;
  bot_user_id: string | null;
  enterprise_id: string | null;
  enterprise_name: string | null;
  installed_at: Date;
  is_enterprise_install: boolean;
  payload: Record<string, unknown>;
  team_id: string | null;
  team_name: string | null;
};

type InstalledWorkspaceRecord = QueryResultRow & {
  enterprise_id: string | null;
  installed_at: Date;
  team_id: string;
  team_name: string | null;
};

function installationRecordToRow(record: SlackInstallationRecord): SlackInstallationRow {
  return {
    appId: nullable(record.app_id),
    botId: nullable(record.bot_id),
    botRefreshToken: nullable(record.bot_refresh_token),
    botScopes: nullable(record.bot_scopes),
    botToken: nullable(record.bot_token),
    botTokenExpiresAt: nullable(record.bot_token_expires_at),
    botUserId: nullable(record.bot_user_id),
    enterpriseId: nullable(record.enterprise_id),
    enterpriseName: nullable(record.enterprise_name),
    enterpriseUrl: nullable(record.enterprise_url),
    incomingWebhookChannel: nullable(record.incoming_webhook_channel),
    incomingWebhookChannelId: nullable(record.incoming_webhook_channel_id),
    incomingWebhookConfigurationUrl: nullable(record.incoming_webhook_configuration_url),
    incomingWebhookUrl: nullable(record.incoming_webhook_url),
    installedAt: record.installed_at,
    isEnterpriseInstall: record.is_enterprise_install,
    payload: record.payload,
    teamId: nullable(record.team_id),
    teamName: nullable(record.team_name),
    tokenType: nullable(record.token_type),
    userId: record.user_id,
    userRefreshToken: nullable(record.user_refresh_token),
    userScopes: nullable(record.user_scopes),
    userToken: nullable(record.user_token),
    userTokenExpiresAt: nullable(record.user_token_expires_at),
  };
}

function botRecordToRow(record: SlackBotRecord): SlackBotRow | undefined {
  if (record.bot_id === null || record.bot_token === null || record.bot_user_id === null) {
    return undefined;
  }
  return {
    appId: nullable(record.app_id),
    botId: record.bot_id,
    botRefreshToken: nullable(record.bot_refresh_token),
    botScopes: nullable(record.bot_scopes),
    botToken: record.bot_token,
    botTokenExpiresAt: nullable(record.bot_token_expires_at),
    botUserId: record.bot_user_id,
    enterpriseId: nullable(record.enterprise_id),
    enterpriseName: nullable(record.enterprise_name),
    installedAt: record.installed_at,
    isEnterpriseInstall: record.is_enterprise_install,
    payload: record.payload,
    teamId: nullable(record.team_id),
    teamName: nullable(record.team_name),
  };
}

function resolvedTeamId(lookup: SlackInstallationLookup): string | undefined {
  return lookup.isEnterpriseInstall ? undefined : lookup.teamId;
}

function nullable<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}
