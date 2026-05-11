import { loadSettings } from "./config.js";
import { createDefaultAgentRunner } from "./agents/runner.js";
import { createAppServer } from "./server.js";
import { createOAuthHttpGateway } from "./integrations/oauth/http.js";
import { Pool } from "pg";
import { PostgresAgentRoutingRepository } from "./infrastructure/postgres/appRepositories.js";
import { createAgentSlackHandlers } from "./slack/agentHandlers.js";
import { createSlackGateway } from "./slack/app.js";

const settings = loadSettings();
const agentRunner = createDefaultAgentRunner(settings);
const agentRoutingPool =
  settings.databaseUrl === undefined
    ? undefined
    : new Pool({ connectionString: settings.databaseUrl });
const routingRepository =
  agentRoutingPool === undefined ? undefined : new PostgresAgentRoutingRepository(agentRoutingPool);
const slackGateway = settings.slackEnabled
  ? createSlackGateway(settings, {
      featureHandlers: createAgentSlackHandlers(agentRunner, { routingRepository }),
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
    if (agentRoutingPool !== undefined) {
      await agentRoutingPool.end();
    }
    process.exit();
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
