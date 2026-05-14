import {
  App,
  HTTPReceiver,
  type Authorize,
  type AuthorizeResult,
  type AuthorizeSourceData,
  type HTTPReceiverOptions,
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
      "Slack is not configured. Set SLACK_SIGNING_SECRET and either SLACK_BOT_TOKEN or SLACK_CLIENT_ID with DATABASE_URL.",
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
  const receiver = new HTTPReceiver(buildReceiverOptions(settings, installationStore));
  const app = new App({
    authorize:
      installationStore === undefined ? undefined : buildAuthorize(settings, installationStore),
    ignoreSelf: true,
    receiver,
    token: installationStore === undefined ? settings.slackBotToken : undefined,
  });

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
  if (!settings.slackInstallationStoreEnabled) {
    return {
      close: async () => {},
      store: undefined,
    };
  }
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

function buildReceiverOptions(
  settings: AppSettings,
  installationStore: InstallationStore | undefined,
): HTTPReceiverOptions {
  if (settings.slackSigningSecret === undefined) {
    throw new Error("SLACK_SIGNING_SECRET is required for Slack HTTP receiver setup.");
  }

  const options: HTTPReceiverOptions = {
    endpoints: settings.slackEventsPath,
    processBeforeResponse: false,
    signingSecret: settings.slackSigningSecret,
    unhandledRequestTimeoutMillis: 2500,
  };

  if (settings.slackOAuthInstallEnabled && installationStore !== undefined) {
    options.clientId = settings.slackClientId;
    options.clientSecret = settings.slackClientSecret;
    options.installationStore = installationStore;
    options.installerOptions = {
      authVersion: "v2",
      installPath: settings.slackInstallPath,
      redirectUriPath: settings.slackOAuthRedirectPath,
      userScopes: settings.slackUserScopes,
    };
    options.scopes = settings.slackScopes;
    options.stateSecret = settings.slackStateSecret;
  }

  return options;
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
      teamId: source.isEnterpriseInstall ? undefined : source.teamId,
      userId: source.userId,
    });
  } catch {
    return undefined;
  }
}
