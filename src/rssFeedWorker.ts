import { RssFeedProcessor } from "./agents/rssFeedProcessor.js";
import { loadSettings } from "./config.js";
import { FernetTextCipher } from "./integrations/oauth/fernet.js";
import { createPostgresRepositoryBundle } from "./infrastructure/postgres/repositoryBundle.js";
import { RssFeedFetchGateway } from "./infrastructure/rss/rssFetchGateway.js";
import { createAiSdkAdapters } from "./providers/aiSdkAdapter.js";
import { createNativeProviderAdapters } from "./providers/nativeProviderAdapters.js";
import { ProviderRouter } from "./providers/providerRouter.js";
import { EncryptedWorkspaceCredentialService } from "./repositories/workspaceCredentials.js";
import { createSlackRssArticlePublisher } from "./slack/rssFeedPosts.js";
import { createSlackWebClientProvider } from "./slack/webClient.js";

const settings = loadSettings();

if (settings.databaseBackend !== "postgres" || settings.databaseUrl === undefined) {
  throw new Error(
    "APP_DATABASE_BACKEND=postgres and DATABASE_URL are required to run the RSS feed batch.",
  );
}

const repositories = createPostgresRepositoryBundle(settings);
if (repositories === undefined) {
  throw new Error("PostgreSQL repositories are required to run the RSS feed batch.");
}
const rssRepository = repositories.rssFeedRepository;
const routingRepository = repositories.routingRepository;
const credentialResolver =
  settings.llmApiKeyEncryptionKey === undefined
    ? undefined
    : new EncryptedWorkspaceCredentialService(
        repositories.workspaceCredentialRepository,
        new FernetTextCipher(settings.llmApiKeyEncryptionKey),
      );
const providerRouter = new ProviderRouter([
  ...createNativeProviderAdapters({ credentialResolver }),
  ...createAiSdkAdapters({}, { credentialResolver }),
]);
const slackClients = createSlackWebClientProvider(settings, { pool: repositories.pool });
const processor = new RssFeedProcessor({
  articlePublisher: createSlackRssArticlePublisher({
    clientProvider: slackClients,
    defaultLocale: settings.defaultLocale,
  }),
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
  await repositories.close();
}
