import { loadSettings } from "./config.js";
import { createDefaultAgentRunner } from "./agents/runner.js";
import { createAppServer } from "./server.js";
import { createOAuthHttpGateway } from "./integrations/oauth/http.js";
import { issueSalesforceOAuthStartContext } from "./integrations/oauth/coordinators.js";
import { FernetTextCipher } from "./integrations/oauth/fernet.js";
import { Pool } from "pg";
import {
  PostgresAgentRoutingRepository,
  PostgresOAuthRepository,
} from "./infrastructure/postgres/appRepositories.js";
import { PostgresWorkspaceCredentialRepository } from "./infrastructure/postgres/workspaceCredentialRepository.js";
import { EncryptedWorkspaceCredentialService } from "./repositories/workspaceCredentials.js";
import { createAgentSlackHandlers } from "./slack/agentHandlers.js";
import { createSlackGateway } from "./slack/app.js";

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
const workspaceCredentialResolver =
  appRepositoryPool === undefined || settings.llmApiKeyEncryptionKey === undefined
    ? undefined
    : new EncryptedWorkspaceCredentialService(
        new PostgresWorkspaceCredentialRepository(appRepositoryPool),
        new FernetTextCipher(settings.llmApiKeyEncryptionKey),
      );
const agentRunner = createDefaultAgentRunner(settings, {
  credentialResolver: workspaceCredentialResolver,
});
const salesforceHomeContextSigningSecret = settings.salesforceOAuthContextSigningSecret;
const slackGateway = settings.slackEnabled
  ? createSlackGateway(settings, {
      featureHandlers: createAgentSlackHandlers(agentRunner, {
        routingRepository,
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
    if (oauthGateway !== undefined) {
      await oauthGateway.close();
    }
    if (appRepositoryPool !== undefined) {
      await appRepositoryPool.end();
    }
    process.exit();
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
