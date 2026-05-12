import { Pool } from "pg";

import { RssFeedProcessor } from "./agents/rssFeedProcessor.js";
import { loadSettings } from "./config.js";
import { FernetTextCipher } from "./integrations/oauth/fernet.js";
import { PostgresAgentRoutingRepository } from "./infrastructure/postgres/appRepositories.js";
import { PostgresRssFeedRepository } from "./infrastructure/postgres/rssFeedRepository.js";
import { PostgresWorkspaceCredentialRepository } from "./infrastructure/postgres/workspaceCredentialRepository.js";
import { ArticleContentGateway } from "./infrastructure/rss/articleContentGateway.js";
import { RssFeedFetchGateway } from "./infrastructure/rss/rssFetchGateway.js";
import { createAiSdkAdapters } from "./providers/aiSdkAdapter.js";
import { createNativeProviderAdapters } from "./providers/nativeProviderAdapters.js";
import { ProviderRouter } from "./providers/providerRouter.js";
import { EncryptedWorkspaceCredentialService } from "./repositories/workspaceCredentials.js";
import { createSlackRssArticlePublisher } from "./slack/rssFeedPosts.js";
import { createSlackWebClientProvider } from "./slack/webClient.js";

const settings = loadSettings();

if (settings.databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required to run the RSS feed batch.");
}

const pool = new Pool({ connectionString: settings.databaseUrl });
const rssRepository = new PostgresRssFeedRepository(pool);
const routingRepository = new PostgresAgentRoutingRepository(pool);
const credentialResolver =
  settings.llmApiKeyEncryptionKey === undefined
    ? undefined
    : new EncryptedWorkspaceCredentialService(
        new PostgresWorkspaceCredentialRepository(pool),
        new FernetTextCipher(settings.llmApiKeyEncryptionKey),
      );
const providerRouter = new ProviderRouter([
  ...createNativeProviderAdapters({ credentialResolver }),
  ...createAiSdkAdapters({}, { credentialResolver }),
]);
const slackClients = createSlackWebClientProvider(settings, { pool });
const processor = new RssFeedProcessor({
  articleContentFetcher: new ArticleContentGateway({ repository: rssRepository }),
  articlePublisher: createSlackRssArticlePublisher({ clientProvider: slackClients }),
  feedFetcher: new RssFeedFetchGateway({ repository: rssRepository }),
  logger: console,
  modelSettingsRepository: routingRepository,
  providerRouter,
  repository: rssRepository,
});

try {
  const result = await processor.processDueRssFeeds();
  console.log("RSS feed batch finished.", result);
} finally {
  await slackClients.close();
  await pool.end();
}
