import { createDefaultAgentRunner } from "./agents/runner.js";
import { createSalesforcePdfToolDependencies } from "./agents/salesforcePdf/index.js";
import { loadSettings } from "./config.js";
import { FernetTextCipher } from "./integrations/oauth/fernet.js";
import { createPostgresRepositoryBundle } from "./infrastructure/postgres/repositoryBundle.js";
import { createDefaultTranscriptionGateway } from "./providers/transcriptionGateway.js";
import { createSlackAgentJobWorker } from "./queues/slackAgentJobs.js";
import { EncryptedWorkspaceCredentialService } from "./repositories/workspaceCredentials.js";
import { processSlackAgentJob } from "./slack/agentHandlers.js";
import { createSlackCanvasAccessSetter } from "./slack/canvasAccess.js";
import { createSlackInstallationMcpTokenResolver } from "./slack/mcpTokenResolver.js";
import { createSlackWebClientProvider } from "./slack/webClient.js";

const settings = loadSettings();

if (settings.databaseBackend !== "postgres" || settings.databaseUrl === undefined) {
  throw new Error(
    "APP_DATABASE_BACKEND=postgres and DATABASE_URL are required to run the Slack agent worker.",
  );
}

const repositories = createPostgresRepositoryBundle(settings);
if (repositories === undefined) {
  throw new Error("PostgreSQL repositories are required to run the Slack agent worker.");
}
const postgresRepositories = repositories;
const { featureSettingsRepository, oauthRepository, routingRepository, userSettingsRepository } =
  postgresRepositories;
const workspaceCredentialResolver =
  settings.llmApiKeyEncryptionKey === undefined
    ? undefined
    : new EncryptedWorkspaceCredentialService(
        postgresRepositories.workspaceCredentialRepository,
        new FernetTextCipher(settings.llmApiKeyEncryptionKey),
      );
const salesforcePdfTools =
  settings.salesforceOAuthEnabled &&
  settings.salesforceOAuthContextSigningSecret !== undefined &&
  settings.salesforceTokenEncryptionKey !== undefined
    ? createSalesforcePdfToolDependencies({
        contextSigningSecret: settings.salesforceOAuthContextSigningSecret,
        oauthRepository,
        settingsRepository: postgresRepositories.salesforcePdfWorkflowRepository,
        tokenEncryptionKey: settings.salesforceTokenEncryptionKey,
      })
    : undefined;
const runner = createDefaultAgentRunner(settings, {
  credentialResolver: workspaceCredentialResolver,
  featureSettingsRepository,
  logger: console,
  salesforcePdfTools,
  slackMcpCanvasAccessSetter: createSlackCanvasAccessSetter(),
  slackMcpTokenResolver:
    postgresRepositories.slackInstallationRepository === undefined
      ? undefined
      : createSlackInstallationMcpTokenResolver(postgresRepositories.slackInstallationRepository),
});
const audioTranscriptionGateway = createDefaultTranscriptionGateway(settings, {
  credentialResolver: workspaceCredentialResolver,
});
const slackClients = createSlackWebClientProvider(settings, { pool: postgresRepositories.pool });
const worker = createSlackAgentJobWorker(settings, async (job, context) => {
  const client = await slackClients.forTeam({
    enterpriseId: job.enterpriseId,
    isEnterpriseInstall: job.isEnterpriseInstall,
    teamId: job.teamId,
  });
  await processSlackAgentJob(job, {
    audioTranscriptionGateway,
    client,
    defaultLocale: settings.defaultLocale,
    logger: console,
    retryContext: context,
    routingRepository,
    runner,
    userSettingsRepository,
  });
});

console.log("Slack agent worker started.");

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}; shutting down Slack agent worker.`);
  void (async () => {
    await worker.close();
    await slackClients.close();
    await postgresRepositories.close();
    process.exit();
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
