import type { Pool } from "pg";

import type { JsonValue } from "../../domain/messageHistory.js";
import type {
  ChannelFeatureSettingDocument,
  WorkspaceFeatureKey,
  WorkspaceFeatureSettingDocument,
  WorkspaceFeatureSettingsRepository,
} from "../../repositories/workspaceFeatureSettings.js";

export class PostgresWorkspaceFeatureSettingsRepository implements WorkspaceFeatureSettingsRepository {
  constructor(private readonly pool: Pool) {}

  async findWorkspaceFeatureSetting(input: {
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<WorkspaceFeatureSettingDocument | undefined> {
    const result = await this.pool.query<WorkspaceFeatureSettingRow>(
      `
        select team_id, feature_key, enabled, updated_at, updated_by_user_id, payload
        from workspace_feature_settings
        where team_id = $1
          and feature_key = $2
      `,
      [input.teamId, input.featureKey],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapWorkspaceFeatureSetting(row);
  }

  async saveWorkspaceFeatureSetting(document: WorkspaceFeatureSettingDocument): Promise<void> {
    await this.pool.query(
      `
        insert into workspace_feature_settings
          (team_id, feature_key, enabled, updated_at, updated_by_user_id, payload)
        values
          ($1, $2, $3, $4, $5, $6)
        on conflict (team_id, feature_key)
        do update set
          enabled = excluded.enabled,
          updated_at = excluded.updated_at,
          updated_by_user_id = excluded.updated_by_user_id,
          payload = excluded.payload
      `,
      [
        document.teamId,
        document.featureKey,
        document.enabled,
        document.updatedAt,
        document.updatedByUserId ?? null,
        JSON.stringify(document.payload),
      ],
    );
  }

  async listAllowedChannels(input: {
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<ChannelFeatureSettingDocument[]> {
    const result = await this.pool.query<ChannelFeatureSettingRow>(
      `
        select team_id, channel_id, feature_key, updated_at, updated_by_user_id, payload
        from channel_feature_settings
        where team_id = $1
          and feature_key = $2
        order by channel_id
      `,
      [input.teamId, input.featureKey],
    );
    return result.rows.map(mapChannelFeatureSetting);
  }

  async isChannelAllowed(input: {
    channelId: string;
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `
        select exists (
          select 1
          from channel_feature_settings
          where team_id = $1
            and channel_id = $2
            and feature_key = $3
        )
      `,
      [input.teamId, input.channelId, input.featureKey],
    );
    return result.rows[0]?.exists === true;
  }

  async replaceAllowedChannels(input: {
    channelIds: readonly string[];
    featureKey: WorkspaceFeatureKey;
    teamId: string;
    updatedAt?: Date;
    updatedByUserId?: string;
  }): Promise<void> {
    const uniqueChannelIds = [...new Set(input.channelIds.map((id) => id.trim()).filter(Boolean))];
    const updatedAt = input.updatedAt ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
          delete from channel_feature_settings
          where team_id = $1
            and feature_key = $2
        `,
        [input.teamId, input.featureKey],
      );
      for (const channelId of uniqueChannelIds) {
        await client.query(
          `
            insert into channel_feature_settings
              (team_id, channel_id, feature_key, updated_at, updated_by_user_id, payload)
            values
              ($1, $2, $3, $4, $5, $6)
          `,
          [
            input.teamId,
            channelId,
            input.featureKey,
            updatedAt,
            input.updatedByUserId ?? null,
            JSON.stringify({ channel_id: channelId, feature_key: input.featureKey }),
          ],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

type WorkspaceFeatureSettingRow = {
  enabled: boolean;
  feature_key: WorkspaceFeatureKey;
  payload: Record<string, JsonValue>;
  team_id: string;
  updated_at: Date;
  updated_by_user_id: string | null;
};

type ChannelFeatureSettingRow = {
  channel_id: string;
  feature_key: WorkspaceFeatureKey;
  payload: Record<string, JsonValue>;
  team_id: string;
  updated_at: Date;
  updated_by_user_id: string | null;
};

function mapWorkspaceFeatureSetting(
  row: WorkspaceFeatureSettingRow,
): WorkspaceFeatureSettingDocument {
  return {
    enabled: row.enabled,
    featureKey: row.feature_key,
    payload: row.payload,
    teamId: row.team_id,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id ?? undefined,
  };
}

function mapChannelFeatureSetting(row: ChannelFeatureSettingRow): ChannelFeatureSettingDocument {
  return {
    channelId: row.channel_id,
    featureKey: row.feature_key,
    payload: row.payload,
    teamId: row.team_id,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id ?? undefined,
  };
}
