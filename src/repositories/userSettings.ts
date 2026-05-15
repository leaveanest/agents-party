import type { JsonValue } from "../domain/messageHistory.js";
import type { Locale } from "../i18n/index.js";

export type UserSettingsPayload = Record<string, JsonValue>;

export type UserSettingsDocument = {
  createdAt: Date;
  locale?: Locale;
  payload: UserSettingsPayload;
  slackUserId: string;
  teamId: string;
  updatedAt: Date;
  updatedBySlackUserId?: string;
};

export type SaveUserSettingsInput = {
  locale?: Locale;
  payload?: UserSettingsPayload;
  slackUserId: string;
  teamId: string;
  updatedAt?: Date;
  updatedBySlackUserId?: string;
};

export type UserSettingsRepository = {
  findUserSettings(input: {
    slackUserId: string;
    teamId: string;
  }): Promise<UserSettingsDocument | undefined>;
  saveUserSettings(input: SaveUserSettingsInput): Promise<void>;
};
