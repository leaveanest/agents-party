import type { Pool } from "pg";

import { normalizeLocale } from "../../i18n/index.js";
import type {
  SaveUserSettingsInput,
  UserSettingsDocument,
  UserSettingsPayload,
  UserSettingsRepository,
} from "../../repositories/userSettings.js";

export class PostgresUserSettingsRepository implements UserSettingsRepository {
  constructor(private readonly pool: Pool) {}

  async findUserSettings(input: {
    slackUserId: string;
    teamId: string;
  }): Promise<UserSettingsDocument | undefined> {
    const result = await this.pool.query<UserSettingsRow>(
      `
        select team_id, slack_user_id, locale, created_at, updated_at,
               updated_by_slack_user_id, payload
        from app_user_settings
        where team_id = $1
          and slack_user_id = $2
      `,
      [input.teamId, input.slackUserId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapUserSettings(row);
  }

  async saveUserSettings(input: SaveUserSettingsInput): Promise<void> {
    const now = input.updatedAt ?? new Date();
    await this.pool.query(
      `
        insert into app_user_settings
          (team_id, slack_user_id, locale, created_at, updated_at,
           updated_by_slack_user_id, payload)
        values
          ($1, $2, $3, $4, $5, $6, $7)
        on conflict (team_id, slack_user_id)
        do update set
          locale = excluded.locale,
          updated_at = excluded.updated_at,
          updated_by_slack_user_id = excluded.updated_by_slack_user_id,
          payload = excluded.payload
      `,
      [
        input.teamId,
        input.slackUserId,
        input.locale ?? null,
        now,
        now,
        input.updatedBySlackUserId ?? null,
        JSON.stringify(input.payload ?? {}),
      ],
    );
  }
}

type UserSettingsRow = {
  created_at: Date;
  locale: string | null;
  payload: UserSettingsPayload;
  slack_user_id: string;
  team_id: string;
  updated_at: Date;
  updated_by_slack_user_id: string | null;
};

function mapUserSettings(row: UserSettingsRow): UserSettingsDocument {
  return {
    createdAt: row.created_at,
    locale: normalizeLocale(row.locale ?? undefined),
    payload: row.payload,
    slackUserId: row.slack_user_id,
    teamId: row.team_id,
    updatedAt: row.updated_at,
    updatedBySlackUserId: row.updated_by_slack_user_id ?? undefined,
  };
}
