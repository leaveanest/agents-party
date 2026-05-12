import { Pool } from "pg";

import { createDefaultAgentRunner } from "./agents/runner.js";
import { loadSettings } from "./config.js";
import { PostgresAgentRoutingRepository } from "./infrastructure/postgres/appRepositories.js";
import { createBullMqSlackAgentJobWorker } from "./queues/slackAgentJobs.js";
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
const runner = createDefaultAgentRunner(settings);
const slackClients = createSlackWebClientProvider(settings, { pool });
const worker = createBullMqSlackAgentJobWorker(settings.redisUrl, async (job) => {
  const client = await slackClients.forTeam({
    enterpriseId: job.enterpriseId,
    isEnterpriseInstall: job.isEnterpriseInstall,
    teamId: job.teamId,
  });
  await processSlackAgentJob(job, {
    client,
    logger: console,
    routingRepository,
    runner,
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
