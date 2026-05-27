import { loadSettings } from "./config.js";
import { createDefaultAgentRunner } from "./agents/runner.js";
import { createSalesforcePdfToolDependencies } from "./agents/salesforcePdf/index.js";
import { createAppServer } from "./server.js";
import { issueSalesforceOAuthStartContext } from "./integrations/oauth/coordinators.js";
import { FernetTextCipher } from "./integrations/oauth/fernet.js";
import { createOAuthHttpGateway } from "./integrations/oauth/http.js";
import { Pool } from "pg";
import {
  PostgresAgentRoutingRepository,
  PostgresOAuthRepository,
  PostgresSalesforcePdfWorkflowRepository,
} from "./infrastructure/postgres/appRepositories.js";
import { PostgresRssFeedRepository } from "./infrastructure/postgres/rssFeedRepository.js";
import { PostgresSlackInstallationRepository } from "./infrastructure/postgres/slackInstallationRepository.js";
import { PostgresUserSettingsRepository } from "./infrastructure/postgres/userSettingsRepository.js";
import { createBullMqSlackAgentJobQueue } from "./queues/slackAgentJobs.js";
import { PostgresWorkspaceCredentialRepository } from "./infrastructure/postgres/workspaceCredentialRepository.js";
import { PostgresWorkspaceFeatureSettingsRepository } from "./infrastructure/postgres/workspaceFeatureSettingsRepository.js";
import { EncryptedWorkspaceCredentialService } from "./repositories/workspaceCredentials.js";
import { createDefaultTranscriptionGateway } from "./providers/transcriptionGateway.js";
import { createAgentSlackHandlers } from "./slack/apps/agents/handlers.js";
import { createSlackGateway } from "./slack/runtime/gateway.js";
import { createSlackInstallationMcpTokenResolver } from "./slack/mcpTokenResolver.js";
import { createSlackWebClientProvider } from "./slack/webClient.js";

const settings = loadSettings();
const appRepositoryPool =
  settings.databaseUrl === undefined
    ? undefined
    : new Pool({ connectionString: settings.databaseUrl });
const routingRepository =
  appRepositoryPool === undefined
    ? undefined
    : new PostgresAgentRoutingRepository(appRepositoryPool);
const oauthRepository =
  appRepositoryPool === undefined ? undefined : new PostgresOAuthRepository(appRepositoryPool);
const salesforcePdfWorkflowRepository =
  appRepositoryPool === undefined
    ? undefined
    : new PostgresSalesforcePdfWorkflowRepository(appRepositoryPool);
const userSettingsRepository =
  appRepositoryPool === undefined
    ? undefined
    : new PostgresUserSettingsRepository(appRepositoryPool);
const featureSettingsRepository =
  appRepositoryPool === undefined
    ? undefined
    : new PostgresWorkspaceFeatureSettingsRepository(appRepositoryPool);
const rssFeedRepository =
  appRepositoryPool === undefined ? undefined : new PostgresRssFeedRepository(appRepositoryPool);
const slackInstallationRepository =
  appRepositoryPool === undefined || settings.slackClientId === undefined
    ? undefined
    : new PostgresSlackInstallationRepository(settings.slackClientId, {
        pool: appRepositoryPool,
      });
const agentJobQueue =
  !settings.slackAgentQueueEnabled ||
  settings.redisUrl === undefined ||
  settings.databaseUrl === undefined
    ? undefined
    : createBullMqSlackAgentJobQueue(settings.redisUrl);
const slackTeamClients =
  appRepositoryPool === undefined
    ? undefined
    : createSlackWebClientProvider(settings, { pool: appRepositoryPool });
const workspaceCredentialResolver =
  appRepositoryPool === undefined || settings.llmApiKeyEncryptionKey === undefined
    ? undefined
    : new EncryptedWorkspaceCredentialService(
        new PostgresWorkspaceCredentialRepository(appRepositoryPool),
        new FernetTextCipher(settings.llmApiKeyEncryptionKey),
      );
const salesforcePdfTools =
  settings.salesforceOAuthEnabled &&
  settings.salesforceOAuthContextSigningSecret !== undefined &&
  settings.salesforceTokenEncryptionKey !== undefined &&
  oauthRepository !== undefined &&
  salesforcePdfWorkflowRepository !== undefined
    ? createSalesforcePdfToolDependencies({
        contextSigningSecret: settings.salesforceOAuthContextSigningSecret,
        oauthRepository,
        settingsRepository: salesforcePdfWorkflowRepository,
        tokenEncryptionKey: settings.salesforceTokenEncryptionKey,
      })
    : undefined;
const agentRunner = createDefaultAgentRunner(settings, {
  credentialResolver: workspaceCredentialResolver,
  featureSettingsRepository,
  logger: console,
  salesforcePdfTools,
  slackMcpTokenResolver:
    slackInstallationRepository === undefined
      ? undefined
      : createSlackInstallationMcpTokenResolver(slackInstallationRepository),
});
const audioTranscriptionGateway = createDefaultTranscriptionGateway(settings, {
  credentialResolver: workspaceCredentialResolver,
});
const salesforceHomeContextSigningSecret = settings.salesforceOAuthContextSigningSecret;
const slackGateway = settings.slackEnabled
  ? createSlackGateway(settings, {
      featureHandlers: createAgentSlackHandlers(agentRunner, {
        agentJobQueue,
        audioTranscriptionGateway,
        defaultLocale: settings.defaultLocale,
        installedWorkspaceDirectory: slackInstallationRepository,
        featureSettingsHome:
          featureSettingsRepository === undefined
            ? undefined
            : {
                imageGenerationModelId: settings.imageGenerationModelId,
                repository: featureSettingsRepository,
                textToSpeechModelId: settings.textToSpeechModelId,
              },
        routingRepository,
        rssFeedHome:
          rssFeedRepository === undefined ? undefined : { repository: rssFeedRepository },
        salesforceConnectionHome:
          settings.salesforceOAuthEnabled &&
          salesforceHomeContextSigningSecret !== undefined &&
          settings.salesforceOAuthRedirectBaseUrl !== undefined &&
          oauthRepository !== undefined
            ? {
                buildStartUrl(input) {
                  const url = new URL(
                    settings.salesforceOAuthStartPath,
                    settings.salesforceOAuthRedirectBaseUrl,
                  );
                  url.searchParams.set(
                    "context",
                    issueSalesforceOAuthStartContext({
                      contextSigningSecret: salesforceHomeContextSigningSecret,
                      ...input,
                    }),
                  );
                  return url.toString();
                },
                repository: oauthRepository,
              }
            : undefined,
        salesforcePdfWorkflowHome:
          settings.salesforceOAuthEnabled && salesforcePdfWorkflowRepository !== undefined
            ? { repository: salesforcePdfWorkflowRepository }
            : undefined,
        slackTeamClients,
        userSettingsRepository,
        workspaceCredentialSettings: workspaceCredentialResolver,
      }),
    })
  : undefined;
const oauthGateway = createOAuthHttpGateway(settings);
const server = createAppServer(settings, {
  oauthGateway,
  slackGateway,
});

server.listen(settings.appPort, settings.appHost, () => {
  console.log(
    `${settings.appName} listening on http://${settings.appHost}:${settings.appPort} in ${settings.appEnv} mode`,
  );
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}; shutting down.`);
  server.close(async (error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    if (slackGateway !== undefined) {
      await slackGateway.close();
    }
    if (agentJobQueue !== undefined) {
      await agentJobQueue.close();
    }
    if (oauthGateway !== undefined) {
      await oauthGateway.close();
    }
    if (slackTeamClients !== undefined) {
      await slackTeamClients.close();
    }
    if (appRepositoryPool !== undefined) {
      await appRepositoryPool.end();
    }
    process.exit();
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
