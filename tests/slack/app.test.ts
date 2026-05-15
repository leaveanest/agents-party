import { describe, expect, it } from "vite-plus/test";

import type { AppSettings } from "../../src/config.js";
import { createSlackApp } from "../../src/slack/app.js";

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
  transcriptionAlternativeLanguageCodes: ["en-US"],
  transcriptionLanguageCode: "ja-JP",
  transcriptionModelId: "google:speech-to-text-latest-long",
  videoGenerationModelId: "google:veo-3.1-fast-generate-001",
  slackClientId: undefined,
  slackClientSecret: undefined,
  slackEnabled: false,
  slackEventsPath: "/slack/events",
  slackInstallationStoreEnabled: false,
  slackInstallPath: "/slack/install",
  slackOAuthInstallEnabled: false,
  slackOAuthRedirectPath: "/slack/oauth_redirect",
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
});
