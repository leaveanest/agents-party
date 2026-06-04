import { Pool } from "pg";

import type { AppSettings } from "../../config.js";
import {
  PostgresAgentRoutingRepository,
  PostgresOAuthRepository,
  PostgresSalesforcePdfWorkflowRepository,
} from "./appRepositories.js";
import { PostgresRssFeedRepository } from "./rssFeedRepository.js";
import { PostgresSlackInstallationRepository } from "./slackInstallationRepository.js";
import { PostgresUserSettingsRepository } from "./userSettingsRepository.js";
import { PostgresWorkspaceCredentialRepository } from "./workspaceCredentialRepository.js";
import { PostgresWorkspaceFeatureSettingsRepository } from "./workspaceFeatureSettingsRepository.js";

export type PostgresRepositoryBundle = {
  close(): Promise<void>;
  featureSettingsRepository: PostgresWorkspaceFeatureSettingsRepository;
  oauthRepository: PostgresOAuthRepository;
  pool: Pool;
  routingRepository: PostgresAgentRoutingRepository;
  rssFeedRepository: PostgresRssFeedRepository;
  salesforcePdfWorkflowRepository: PostgresSalesforcePdfWorkflowRepository;
  slackInstallationRepository: PostgresSlackInstallationRepository | undefined;
  userSettingsRepository: PostgresUserSettingsRepository;
  workspaceCredentialRepository: PostgresWorkspaceCredentialRepository;
};

export function createPostgresRepositoryBundle(
  settings: Pick<AppSettings, "databaseBackend" | "databaseUrl" | "slackClientId">,
): PostgresRepositoryBundle | undefined {
  if (settings.databaseBackend === undefined) {
    return undefined;
  }
  if (settings.databaseBackend !== "postgres") {
    throw new Error("APP_DATABASE_BACKEND=postgres is required by this Node runtime.");
  }
  if (settings.databaseUrl === undefined) {
    throw new Error("DATABASE_URL is required when APP_DATABASE_BACKEND=postgres.");
  }

  const pool = new Pool({ connectionString: settings.databaseUrl });
  const slackInstallationRepository =
    settings.slackClientId === undefined
      ? undefined
      : new PostgresSlackInstallationRepository(settings.slackClientId, { pool });

  return {
    async close() {
      await pool.end();
    },
    featureSettingsRepository: new PostgresWorkspaceFeatureSettingsRepository(pool),
    oauthRepository: new PostgresOAuthRepository(pool),
    pool,
    routingRepository: new PostgresAgentRoutingRepository(pool),
    rssFeedRepository: new PostgresRssFeedRepository(pool),
    salesforcePdfWorkflowRepository: new PostgresSalesforcePdfWorkflowRepository(pool),
    slackInstallationRepository,
    userSettingsRepository: new PostgresUserSettingsRepository(pool),
    workspaceCredentialRepository: new PostgresWorkspaceCredentialRepository(pool),
  };
}
