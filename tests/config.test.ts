import { describe, expect, it } from "vite-plus/test";

import { loadSettings, parsePort } from "../src/config.js";

describe("loadSettings", () => {
  it("uses local defaults", () => {
    expect(loadSettings({})).toEqual({
      agentModelId: "google:gemini-2.5-flash",
      appEnv: "local",
      appHost: "0.0.0.0",
      appName: "agents-party",
      appPort: 8000,
      databaseUrl: undefined,
      redisUrl: undefined,
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
      googleGenerativeAiApiKey: undefined,
      transcriptionAlternativeLanguageCodes: ["en-US"],
      transcriptionLanguageCode: "ja-JP",
      transcriptionModelId: "google:speech-to-text-latest-long",
      videoGenerationModelId: "google:veo-3.1-fast-generate-001",
      slackBotToken: undefined,
      slackClientId: undefined,
      slackClientSecret: undefined,
      slackAgentQueueEnabled: false,
      slackEnabled: false,
      slackEventsPath: "/slack/events",
      slackInstallationStoreEnabled: false,
      slackInstallPath: "/slack/install",
      slackOAuthInstallEnabled: false,
      slackOAuthRedirectPath: "/slack/oauth_redirect",
      slackScopes: [
        "app_mentions:read",
        "channels:history",
        "chat:write",
        "files:read",
        "files:write",
        "groups:history",
        "im:history",
        "mpim:history",
        "reactions:read",
        "users:read",
        "views:write",
      ],
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
    });
  });

  it("prefers PORT over APP_PORT for platform deployments", () => {
    expect(loadSettings({ APP_PORT: "9000", PORT: "8080" }).appPort).toBe(8080);
  });

  it("allows the TypeScript AgentRunner model to be configured explicitly", () => {
    expect(loadSettings({ AGENT_MODEL: "anthropic:claude-3-5-sonnet-latest" }).agentModelId).toBe(
      "anthropic:claude-3-5-sonnet-latest",
    );
  });

  it("requires AGENT_MODEL for Heroku-like runtime configuration", () => {
    expect(() => loadSettings({ APP_ENV: "heroku" })).toThrow(
      "AGENT_MODEL is required for production-like runtimes.",
    );
    expect(() => loadSettings({ DYNO: "web.1" })).toThrow(
      "AGENT_MODEL is required for production-like runtimes.",
    );
  });

  it("requires AGENT_MODEL when NODE_ENV is production", () => {
    expect(() => loadSettings({ NODE_ENV: "production" })).toThrow(
      "AGENT_MODEL is required for production-like runtimes.",
    );
  });

  it("enables static-token Slack ingress with signing secret and bot token", () => {
    const settings = loadSettings({
      SLACK_BOT_TOKEN: "xoxb-token",
      SLACK_SIGNING_SECRET: "secret",
    });

    expect(settings.slackEnabled).toBe(true);
    expect(settings.slackInstallationStoreEnabled).toBe(false);
    expect(settings.slackOAuthInstallEnabled).toBe(false);
  });

  it("reads Redis queue settings for Slack agent worker handoff", () => {
    const settings = loadSettings({
      REDIS_URL: "rediss://redis.example.com:6379",
      SLACK_AGENT_QUEUE_ENABLED: "true",
    });

    expect(settings.redisUrl).toBe("rediss://redis.example.com:6379");
    expect(settings.slackAgentQueueEnabled).toBe(true);
  });

  it("enables database-backed Slack installation storage with client id and database", () => {
    const settings = loadSettings({
      DATABASE_URL: "postgres://localhost/app",
      SLACK_CLIENT_ID: "123.456",
      SLACK_SIGNING_SECRET: "secret",
    });

    expect(settings.slackEnabled).toBe(true);
    expect(settings.slackInstallationStoreEnabled).toBe(true);
    expect(settings.slackOAuthInstallEnabled).toBe(false);
  });

  it("enables Slack OAuth install routes only when OAuth secrets are configured", () => {
    const settings = loadSettings({
      DATABASE_URL: "postgres://localhost/app",
      SLACK_CLIENT_ID: "123.456",
      SLACK_CLIENT_SECRET: "client-secret",
      SLACK_SIGNING_SECRET: "secret",
      SLACK_STATE_SECRET: "state-secret",
      SLACK_USER_SCOPES: "chat:write,users:read",
    });

    expect(settings.slackOAuthInstallEnabled).toBe(true);
    expect(settings.slackUserScopes).toEqual(["chat:write", "users:read"]);
  });

  it("enables Google OAuth routes when all required secrets and database are configured", () => {
    const settings = loadSettings({
      DATABASE_URL: "postgres://localhost/app",
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_CONTEXT_SIGNING_SECRET: "context-secret",
      GOOGLE_OAUTH_REDIRECT_BASE_URL: "https://app.example.com/",
      GOOGLE_TOKEN_ENCRYPTION_KEY: "token-key",
    });

    expect(settings.googleOAuthEnabled).toBe(true);
    expect(settings.googleOAuthCallbackUrl).toBe("https://app.example.com/oauth/google/callback");
  });

  it("enables Salesforce OAuth routes when shared secrets and database are configured", () => {
    const settings = loadSettings({
      DATABASE_URL: "postgres://localhost/app",
      SALESFORCE_OAUTH_CONTEXT_SIGNING_SECRET: "context-secret",
      SALESFORCE_OAUTH_REDIRECT_BASE_URL: "https://app.example.com/base",
      SALESFORCE_TOKEN_ENCRYPTION_KEY: "token-key",
    });

    expect(settings.salesforceOAuthEnabled).toBe(true);
    expect(settings.salesforceOAuthCallbackUrl).toBe(
      "https://app.example.com/base/oauth/salesforce/callback",
    );
  });

  it("reads the Google Maps API key for the TypeScript maps specialist", () => {
    expect(loadSettings({ GOOGLE_MAPS_API_KEY: "maps-key" }).googleMapsApiKey).toBe("maps-key");
  });

  it("reads the Google GenAI API key and media specialist model overrides", () => {
    const settings = loadSettings({
      GEMINI_API_KEY: "gemini-key",
      IMAGE_GENERATION_MODEL: "google:image-model",
      VIDEO_GENERATION_MODEL: "google:video-model",
    });

    expect(settings.googleGenerativeAiApiKey).toBe("gemini-key");
    expect(settings.imageGenerationModelId).toBe("google:image-model");
    expect(settings.videoGenerationModelId).toBe("google:video-model");
  });

  it("reads transcription model and language settings", () => {
    const settings = loadSettings({
      TRANSCRIPTION_ALTERNATIVE_LANGUAGE_CODES: "en-US,fr-FR",
      TRANSCRIPTION_LANGUAGE_CODE: "ja-JP",
      TRANSCRIPTION_MODEL: "google:speech-to-text-latest-long",
    });

    expect(settings.transcriptionAlternativeLanguageCodes).toEqual(["en-US", "fr-FR"]);
    expect(settings.transcriptionLanguageCode).toBe("ja-JP");
    expect(settings.transcriptionModelId).toBe("google:speech-to-text-latest-long");
  });

  it("allows OpenAI image generation models to be configured explicitly", () => {
    const settings = loadSettings({
      IMAGE_GENERATION_MODEL: "openai:gpt-image-1.5",
    });

    expect(settings.imageGenerationModelId).toBe("openai:gpt-image-1.5");
  });

  it("reads the workspace LLM API key encryption key", () => {
    expect(loadSettings({ LLM_API_KEY_ENCRYPTION_KEY: "fernet-key" }).llmApiKeyEncryptionKey).toBe(
      "fernet-key",
    );
  });
});

describe("parsePort", () => {
  it("rejects invalid port values", () => {
    expect(() => parsePort("70000", 8000)).toThrow(
      "APP_PORT or PORT must be an integer between 1 and 65535.",
    );
  });

  it("rejects Slack route paths without a leading slash", () => {
    expect(() => loadSettings({ SLACK_EVENTS_PATH: "slack/events" })).toThrow(
      "Slack route paths must start with '/'.",
    );
  });
});
