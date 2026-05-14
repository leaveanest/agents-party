import { Pool } from "pg";

import { createDefaultModelRegistry } from "../../providers/modelRegistry.js";
import { PostgresAgentRoutingRepository } from "./appRepositories.js";

const databaseUrl = readRequiredEnv("DATABASE_URL");
const teamId = readRequiredEnv("AGENTS_PARTY_BOOTSTRAP_TEAM_ID");
const agentId = readText(process.env.AGENTS_PARTY_BOOTSTRAP_AGENT_ID) ?? "assistant";
const modelId =
  readText(process.env.AGENTS_PARTY_BOOTSTRAP_MODEL_ID) ?? readRequiredEnv("AGENT_MODEL");
const threadAutoReply = parseBoolean(process.env.AGENTS_PARTY_BOOTSTRAP_THREAD_AUTO_REPLY, true);
const enabledChannelIds = parseList(process.env.AGENTS_PARTY_BOOTSTRAP_ENABLED_CHANNEL_IDS);

const model = createDefaultModelRegistry().get(modelId);
const pool = new Pool({ connectionString: databaseUrl });
const repository = new PostgresAgentRoutingRepository(pool);
const now = new Date();

try {
  await repository.saveAgent({
    agentId,
    enabled: true,
    payload: {
      agent_id: agentId,
      description: "Bootstrap general Slack assistant.",
      name: "Bootstrap general Slack assistant",
    },
    updatedAt: now,
  });
  await repository.saveWorkspaceSettings({
    defaultAgentId: agentId,
    defaultModelId: model.id,
    payload: {
      bootstrap_source: "seedBootstrap",
      enabled_channel_ids: enabledChannelIds,
    },
    teamId,
    threadAutoReply,
    updatedAt: now,
  });
  console.log("Seeded bootstrap Slack routing settings.", {
    agentId,
    enabledChannelIds,
    modelId: model.id,
    teamId,
    threadAutoReply,
  });
} finally {
  await pool.end();
}

function readRequiredEnv(name: string): string {
  const value = readText(process.env[name]);
  if (value === undefined) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readText(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

function parseList(value: string | undefined): string[] {
  return (readText(value) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const text = readText(value);
  if (text === undefined) {
    return fallback;
  }
  const normalized = text.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${value} is not a valid boolean value.`);
}
