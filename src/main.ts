import { loadSettings } from "./config.js";
import { createDefaultAgentRunner } from "./agents/runner.js";
import { createSalesforcePdfToolDependencies } from "./agents/salesforcePdf/index.js";
import { createAppServer } from "./server.js";
import { issueSalesforceOAuthStartContext } from "./integrations/oauth/coordinators.js";
import { FernetTextCipher } from "./integrations/oauth/fernet.js";
import { createOAuthHttpGateway } from "./integrations/oauth/http.js";
import { createPostgresRepositoryBundle } from "./infrastructure/postgres/repositoryBundle.js";
import { createSlackAgentJobQueue } from "./queues/slackAgentJobs.js";
import { EncryptedWorkspaceCredentialService } from "./repositories/workspaceCredentials.js";
import { createDefaultTranscriptionGateway } from "./providers/transcriptionGateway.js";
import { createAgentSlackHandlers } from "./slack/agentHandlers.js";
import { createSlackGateway } from "./slack/app.js";
import { createSlackCanvasAccessSetter } from "./slack/canvasAccess.js";
import { RepositorySlackInstallationStore } from "./slack/installationStore.js";
import { createSlackInstallationMcpTokenResolver } from "./slack/mcpTokenResolver.js";
import { createSlackWebClientProvider } from "./slack/webClient.js";

const settings = loadSettings();
const repositories = createPostgresRepositoryBundle(settings);
const routingRepository = repositories?.routingRepository;
const oauthRepository = repositories?.oauthRepository;
const salesforcePdfWorkflowRepository = repositories?.salesforcePdfWorkflowRepository;
const userSettingsRepository = repositories?.userSettingsRepository;
const featureSettingsRepository = repositories?.featureSettingsRepository;
const rssFeedRepository = repositories?.rssFeedRepository;
const slackInstallationRepository = repositories?.slackInstallationRepository;
const agentJobQueue = createSlackAgentJobQueue(settings);
const slackTeamClients =
  repositories === undefined
    ? undefined
    : createSlackWebClientProvider(settings, { pool: repositories.pool });
const workspaceCredentialResolver =
  repositories === undefined || settings.llmApiKeyEncryptionKey === undefined
    ? undefined
    : new EncryptedWorkspaceCredentialService(
        repositories.workspaceCredentialRepository,
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
  slackMcpCanvasAccessSetter: createSlackCanvasAccessSetter(),
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
      installationStore:
        slackInstallationRepository === undefined
          ? undefined
          : new RepositorySlackInstallationStore(slackInstallationRepository),
    })
  : undefined;
const oauthGateway = createOAuthHttpGateway(settings, { repository: oauthRepository });
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
    if (repositories !== undefined) {
      await repositories.close();
    }
    process.exit();
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
