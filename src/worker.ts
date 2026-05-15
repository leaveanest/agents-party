import { Pool } from "pg";

import { createDefaultAgentRunner } from "./agents/runner.js";
import { createSalesforcePdfToolDependencies } from "./agents/salesforcePdf/index.js";
import { loadSettings } from "./config.js";
import { FernetTextCipher } from "./integrations/oauth/fernet.js";
import {
  PostgresAgentRoutingRepository,
  PostgresOAuthRepository,
  PostgresSalesforcePdfWorkflowRepository,
} from "./infrastructure/postgres/appRepositories.js";
import { PostgresUserSettingsRepository } from "./infrastructure/postgres/userSettingsRepository.js";
import { PostgresWorkspaceCredentialRepository } from "./infrastructure/postgres/workspaceCredentialRepository.js";
import { createDefaultTranscriptionGateway } from "./providers/transcriptionGateway.js";
import { createBullMqSlackAgentJobWorker } from "./queues/slackAgentJobs.js";
import { EncryptedWorkspaceCredentialService } from "./repositories/workspaceCredentials.js";
import { processSlackAgentJob } from "./slack/agentHandlers.js";
import { createSlackWebClientProvider } from "./slack/webClient.js";

const settings = loadSettings();

if (settings.redisUrl === undefined) {
  throw new Error("REDIS_URL is required to run the Slack agent worker.");
}
if (settings.databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required to run the Slack agent worker.");
}

const pool = new Pool({ connectionString: settings.databaseUrl });
const routingRepository = new PostgresAgentRoutingRepository(pool);
const oauthRepository = new PostgresOAuthRepository(pool);
const salesforcePdfWorkflowRepository = new PostgresSalesforcePdfWorkflowRepository(pool);
const userSettingsRepository = new PostgresUserSettingsRepository(pool);
const workspaceCredentialResolver =
  settings.llmApiKeyEncryptionKey === undefined
    ? undefined
    : new EncryptedWorkspaceCredentialService(
        new PostgresWorkspaceCredentialRepository(pool),
        new FernetTextCipher(settings.llmApiKeyEncryptionKey),
      );
const salesforcePdfTools =
  settings.salesforceOAuthEnabled &&
  settings.salesforceOAuthContextSigningSecret !== undefined &&
  settings.salesforceTokenEncryptionKey !== undefined
    ? createSalesforcePdfToolDependencies({
        contextSigningSecret: settings.salesforceOAuthContextSigningSecret,
        oauthRepository,
        settingsRepository: salesforcePdfWorkflowRepository,
        tokenEncryptionKey: settings.salesforceTokenEncryptionKey,
      })
    : undefined;
const runner = createDefaultAgentRunner(settings, {
  credentialResolver: workspaceCredentialResolver,
  salesforcePdfTools,
});
const audioTranscriptionGateway = createDefaultTranscriptionGateway(settings, {
  credentialResolver: workspaceCredentialResolver,
});
const slackClients = createSlackWebClientProvider(settings, { pool });
const worker = createBullMqSlackAgentJobWorker(settings.redisUrl, async (job, context) => {
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
    await pool.end();
    process.exit();
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
