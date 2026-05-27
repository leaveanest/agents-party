import { describe, expect, it } from "vite-plus/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { AppSettings } from "../../src/config.js";
import { createSlackApp } from "../../src/slack/runtime/gateway.js";

const baseSettings: AppSettings = {
  agentModelId: "google:gemini-2.5-flash",
  appEnv: "test",
  appHost: "127.0.0.1",
  appName: "Agents party",
  appPort: 0,
  databaseUrl: undefined,
  defaultLocale: "ja",
  imageGenerationModelId: "google:gemini-2.5-flash-image",
  llmApiKeyEncryptionKey: undefined,
  objectStorageAccessKeyId: undefined,
  objectStorageBucket: undefined,
  objectStorageEnabled: false,
  objectStorageEndpoint: undefined,
  objectStorageForcePathStyle: false,
  objectStoragePrefix: undefined,
  objectStoragePublicBaseUrl: undefined,
  objectStorageRegion: undefined,
  objectStorageSecretAccessKey: undefined,
  googleOAuthCallbackPath: "/oauth/google/callback",
  googleOAuthCallbackUrl: "/oauth/google/callback",
  googleOAuthClientId: undefined,
  googleOAuthClientSecret: undefined,
  googleOAuthContextSigningSecret: undefined,
  googleOAuthEnabled: false,
  googleOAuthRedirectBaseUrl: undefined,
  googleOAuthStartPath: "/oauth/google/start",
  googleTokenEncryptionKey: undefined,
  googleMapsApiKey: undefined,
  textToSpeechModelId: undefined,
  transcriptionAlternativeLanguageCodes: ["en-US"],
  transcriptionLanguageCode: "ja-JP",
  transcriptionModelId: "google:speech-to-text-latest-long",
  videoGenerationModelId: "google:veo-3.1-fast-generate-001",
  slackClientId: undefined,
  slackClientSecret: undefined,
  slackEnabled: false,
  slackEventsPath: "/agents/slack/events",
  slackInstallationStoreEnabled: false,
  slackInstallPath: "/agents/slack/install",
  slackOAuthInstallEnabled: false,
  slackOAuthRedirectPath: "/agents/slack/oauth_redirect",
  slackRoutes: {
    eventsPath: "/agents/slack/events",
    installPath: "/agents/slack/install",
    oauthRedirectPath: "/agents/slack/oauth_redirect",
  },
  slackScopes: [],
  slackSigningSecret: undefined,
  slackStateSecret: undefined,
  slackUserScopes: [],
  salesforceOAuthCallbackPath: "/oauth/salesforce/callback",
  salesforceOAuthCallbackUrl: "/oauth/salesforce/callback",
  salesforceOAuthContextSigningSecret: undefined,
  salesforceOAuthDisconnectPath: "/oauth/salesforce/disconnect",
  salesforceOAuthEnabled: false,
  salesforceOAuthRedirectBaseUrl: undefined,
  salesforceOAuthStartPath: "/oauth/salesforce/start",
  salesforceTokenEncryptionKey: undefined,
};

describe("createSlackApp", () => {
  it("rejects missing Slack configuration", () => {
    expect(() => createSlackApp(baseSettings)).toThrow("Slack is not configured");
  });

  it("constructs a Bolt app with installation storage", async () => {
    const result = createSlackApp({
      ...baseSettings,
      databaseUrl: "postgres://localhost/app",
      slackClientId: "123.456",
      slackEnabled: true,
      slackInstallationStoreEnabled: true,
      slackSigningSecret: "secret",
    });

    expect(result.app).toBeDefined();
    expect(result.receiver).toBeDefined();
    expect(result.installationStore).toBeDefined();
    await result.close();
  });

  it("constructs a Bolt app with OAuth installation enabled", async () => {
    const result = createSlackApp({
      ...baseSettings,
      databaseUrl: "postgres://localhost/app",
      slackClientId: "123.456",
      slackClientSecret: "client-secret",
      slackEnabled: true,
      slackInstallationStoreEnabled: true,
      slackOAuthInstallEnabled: true,
      slackSigningSecret: "secret",
      slackStateSecret: "state-secret",
    });

    expect(result.app).toBeDefined();
    expect(result.receiver).toBeDefined();
    expect(result.installationStore).toBeDefined();
    await result.close();
  });

  it("serves the OAuth install page with configured user scopes", async () => {
    const result = createSlackApp({
      ...baseSettings,
      databaseUrl: "postgres://localhost/app",
      slackClientId: "123.456",
      slackClientSecret: "client-secret",
      slackEnabled: true,
      slackInstallationStoreEnabled: true,
      slackOAuthInstallEnabled: true,
      slackSigningSecret: "secret",
      slackStateSecret: "state-secret",
      slackUserScopes: ["search:read.public", "users:read"],
    });
    const server = createServer((request, response) => {
      result.receiver.requestListener(request, response);
    });
    try {
      await listen(server);
      const address = server.address() as AddressInfo;

      const response = await fetch(`http://127.0.0.1:${address.port}/agents/slack/install`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("user_scope=search%3Aread.public%2Cusers%3Aread");
    } finally {
      await closeServer(server);
      await result.close();
    }
  });
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
