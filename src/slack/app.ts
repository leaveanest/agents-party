import {
  App,
  HTTPReceiver,
  type Authorize,
  type AuthorizeResult,
  type AuthorizeSourceData,
  type AppOptions,
  type Installation,
  type InstallationStore,
} from "@slack/bolt";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AppSettings } from "../config.js";
import { PostgresSlackInstallationRepository } from "../infrastructure/postgres/slackInstallationRepository.js";
import { InMemorySlackEventDeduplicator, type SlackEventDeduplicator } from "./idempotency.js";
import {
  createMigrationGapSlackHandlers,
  registerSlackEventHandlers,
  type SlackEventFeatureHandlers,
} from "./events.js";
import { RepositorySlackInstallationStore } from "./installationStore.js";

export type SlackGateway = {
  close(): Promise<void>;
  handle(request: IncomingMessage, response: ServerResponse): void;
};

export type SlackAppDependencies = {
  deduplicator?: SlackEventDeduplicator;
  featureHandlers?: SlackEventFeatureHandlers;
  installationStore?: InstallationStore;
};

export function createSlackGateway(
  settings: AppSettings,
  dependencies: SlackAppDependencies = {},
): SlackGateway {
  const { close, receiver } = createSlackApp(settings, dependencies);
  return {
    close,
    handle(request, response) {
      receiver.requestListener(request, response);
    },
  };
}

export function createSlackApp(
  settings: AppSettings,
  dependencies: SlackAppDependencies = {},
): {
  app: App;
  close(): Promise<void>;
  installationStore: InstallationStore | undefined;
  receiver: HTTPReceiver;
} {
  if (!settings.slackEnabled || settings.slackSigningSecret === undefined) {
    throw new Error(
      "Slack is not configured. Set SLACK_SIGNING_SECRET, SLACK_CLIENT_ID, and DATABASE_URL.",
    );
  }

  const installationStoreHandle =
    dependencies.installationStore === undefined
      ? buildInstallationStore(settings)
      : {
          close: async () => {},
          store: dependencies.installationStore,
        };
  const installationStore = installationStoreHandle.store;
  if (installationStore === undefined) {
    throw new Error("Slack installation storage is required.");
  }
  const app = new App(buildAppOptions(settings, installationStore));
  const receiver = getHttpReceiver(app);

  registerSlackEventHandlers(
    app,
    dependencies.featureHandlers ?? createMigrationGapSlackHandlers(),
    dependencies.deduplicator ?? new InMemorySlackEventDeduplicator(),
  );
  return {
    app,
    close: installationStoreHandle.close,
    installationStore,
    receiver,
  };
}

function buildInstallationStore(settings: AppSettings): {
  close(): Promise<void>;
  store: InstallationStore | undefined;
} {
  if (settings.slackClientId === undefined || settings.databaseUrl === undefined) {
    throw new Error(
      "SLACK_CLIENT_ID and DATABASE_URL are required for Slack installation storage.",
    );
  }
  const repository = new PostgresSlackInstallationRepository(settings.slackClientId, {
    databaseUrl: settings.databaseUrl,
  });
  return {
    close: () => repository.close(),
    store: new RepositorySlackInstallationStore(repository),
  };
}

function buildAppOptions(settings: AppSettings, installationStore: InstallationStore): AppOptions {
  if (settings.slackSigningSecret === undefined) {
    throw new Error("SLACK_SIGNING_SECRET is required for Slack app setup.");
  }
  const { slackRoutes } = settings;

  const options: AppOptions = {
    endpoints: slackRoutes.eventsPath,
    ignoreSelf: true,
    processBeforeResponse: false,
    signingSecret: settings.slackSigningSecret,
  };

  if (settings.slackOAuthInstallEnabled) {
    options.clientId = settings.slackClientId;
    options.clientSecret = settings.slackClientSecret;
    options.installationStore = installationStore;
    options.installerOptions = {
      authVersion: "v2",
      installPath: slackRoutes.installPath,
      redirectUriPath: slackRoutes.oauthRedirectPath,
      userScopes: settings.slackUserScopes,
    };
    options.scopes = settings.slackScopes;
    options.stateSecret = settings.slackStateSecret;
  } else {
    options.authorize = buildAuthorize(settings, installationStore);
  }

  return options;
}

function getHttpReceiver(app: App): HTTPReceiver {
  const receiver = (app as unknown as { receiver?: unknown }).receiver;
  if (!(receiver instanceof HTTPReceiver)) {
    throw new Error("Slack app did not initialize an HTTP receiver.");
  }
  return receiver;
}

function buildAuthorize(
  settings: AppSettings,
  installationStore: InstallationStore,
): Authorize<boolean> {
  return async (source: AuthorizeSourceData<boolean>): Promise<AuthorizeResult> => {
    const installation = await fetchInstallationOrUndefined(installationStore, source);
    if (installation !== undefined && installation.bot !== undefined) {
      const { bot } = installation;
      return {
        botId: bot.id,
        botToken: bot.token,
        botUserId: bot.userId,
        enterpriseId: source.enterpriseId,
        teamId: source.teamId,
        userId: installation.user.id,
        userToken: installation.user.token,
      };
    }

    throw new Error("Slack authorization failed: no stored installation bot token found.");
  };
}

async function fetchInstallationOrUndefined(
  installationStore: InstallationStore,
  source: AuthorizeSourceData<boolean>,
): Promise<Installation<"v1" | "v2", boolean> | undefined> {
  try {
    return await installationStore.fetchInstallation({
      enterpriseId: source.enterpriseId,
      isEnterpriseInstall: source.isEnterpriseInstall,
      teamId: source.teamId,
      userId: source.userId,
    });
  } catch {
    return undefined;
  }
}
