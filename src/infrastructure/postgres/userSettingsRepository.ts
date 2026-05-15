import type { Pool } from "pg";

import { normalizeLocale } from "../../i18n/index.js";
import type {
  SaveUserSettingsInput,
  UserSettingsDocument,
  UserSettingsPayload,
  UserSettingsRepository,
  UserSettingsScopeKind,
} from "../../repositories/userSettings.js";

export class PostgresUserSettingsRepository implements UserSettingsRepository {
  constructor(private readonly pool: Pool) {}

  async findUserSettings(input: {
    enterpriseId?: string;
    slackUserId: string;
    teamId?: string;
  }): Promise<UserSettingsDocument | undefined> {
    const scope = resolveUserSettingsScope(input);
    if (scope === undefined) {
      return undefined;
    }
    const result = await this.pool.query<UserSettingsRow>(
      `
        select scope_kind, scope_id, enterprise_id, team_id, slack_user_id,
               locale, created_at, updated_at, updated_by_slack_user_id, payload
        from app_user_settings
        where scope_kind = $1
          and scope_id = $2
          and slack_user_id = $3
      `,
      [scope.scopeKind, scope.scopeId, input.slackUserId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapUserSettings(row);
  }

  async saveUserSettings(input: SaveUserSettingsInput): Promise<void> {
    const scope = resolveUserSettingsScope(input);
    if (scope === undefined) {
      throw new Error("enterpriseId or teamId is required to save user settings.");
    }
    const now = input.updatedAt ?? new Date();
    await this.pool.query(
      `
        insert into app_user_settings
          (scope_kind, scope_id, enterprise_id, team_id, slack_user_id,
           locale, created_at, updated_at,
           updated_by_slack_user_id, payload)
        values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        on conflict (scope_kind, scope_id, slack_user_id)
        do update set
          enterprise_id = excluded.enterprise_id,
          team_id = excluded.team_id,
          locale = excluded.locale,
          updated_at = excluded.updated_at,
          updated_by_slack_user_id = excluded.updated_by_slack_user_id,
          payload = excluded.payload
      `,
      [
        scope.scopeKind,
        scope.scopeId,
        input.enterpriseId ?? null,
        input.teamId ?? null,
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
  enterprise_id: string | null;
  locale: string | null;
  payload: UserSettingsPayload;
  scope_id: string;
  scope_kind: UserSettingsScopeKind;
  slack_user_id: string;
  team_id: string | null;
  updated_at: Date;
  updated_by_slack_user_id: string | null;
};

function mapUserSettings(row: UserSettingsRow): UserSettingsDocument {
  return {
    createdAt: row.created_at,
    enterpriseId: row.enterprise_id ?? undefined,
    locale: normalizeLocale(row.locale ?? undefined),
    payload: row.payload,
    scopeId: row.scope_id,
    scopeKind: row.scope_kind,
    slackUserId: row.slack_user_id,
    teamId: row.team_id ?? undefined,
    updatedAt: row.updated_at,
    updatedBySlackUserId: row.updated_by_slack_user_id ?? undefined,
  };
}

function resolveUserSettingsScope(input: {
  enterpriseId?: string;
  teamId?: string;
}): { scopeId: string; scopeKind: UserSettingsScopeKind } | undefined {
  if (input.enterpriseId !== undefined && input.enterpriseId.trim() !== "") {
    return { scopeId: input.enterpriseId, scopeKind: "enterprise" };
  }
  if (input.teamId !== undefined && input.teamId.trim() !== "") {
    return { scopeId: input.teamId, scopeKind: "team" };
  }
  return undefined;
}
