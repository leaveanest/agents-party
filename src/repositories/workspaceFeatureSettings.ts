import type { JsonValue } from "../domain/messageHistory.js";

export type WorkspaceFeatureKey = "image_generation";

export type WorkspaceFeatureSettingDocument = {
  enabled: boolean;
  featureKey: WorkspaceFeatureKey;
  payload: Record<string, JsonValue>;
  teamId: string;
  updatedAt: Date;
  updatedByUserId?: string;
};

export type ChannelFeatureSettingDocument = {
  channelId: string;
  featureKey: WorkspaceFeatureKey;
  payload: Record<string, JsonValue>;
  teamId: string;
  updatedAt: Date;
  updatedByUserId?: string;
};

export type WorkspaceFeatureSettingsRepository = {
  findWorkspaceFeatureSetting(input: {
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<WorkspaceFeatureSettingDocument | undefined>;
  isChannelAllowed(input: {
    channelId: string;
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<boolean>;
  listAllowedChannels(input: {
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<ChannelFeatureSettingDocument[]>;
  replaceAllowedChannels(input: {
    channelIds: readonly string[];
    featureKey: WorkspaceFeatureKey;
    teamId: string;
    updatedAt?: Date;
    updatedByUserId?: string;
  }): Promise<void>;
  saveWorkspaceFeatureSetting(document: WorkspaceFeatureSettingDocument): Promise<void>;
};
