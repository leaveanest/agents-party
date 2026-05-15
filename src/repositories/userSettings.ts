import type { JsonValue } from "../domain/messageHistory.js";
import type { Locale } from "../i18n/index.js";

export type UserSettingsPayload = Record<string, JsonValue>;

export type UserSettingsScopeKind = "enterprise" | "team";

export type UserSettingsDocument = {
  createdAt: Date;
  enterpriseId?: string;
  locale?: Locale;
  payload: UserSettingsPayload;
  scopeId: string;
  scopeKind: UserSettingsScopeKind;
  slackUserId: string;
  teamId?: string;
  updatedAt: Date;
  updatedBySlackUserId?: string;
};

export type SaveUserSettingsInput = {
  enterpriseId?: string;
  locale?: Locale;
  payload?: UserSettingsPayload;
  slackUserId: string;
  teamId?: string;
  updatedAt?: Date;
  updatedBySlackUserId?: string;
};

export type UserSettingsRepository = {
  findUserSettings(input: {
    enterpriseId?: string;
    slackUserId: string;
    teamId?: string;
  }): Promise<UserSettingsDocument | undefined>;
  saveUserSettings(input: SaveUserSettingsInput): Promise<void>;
};
