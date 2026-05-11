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
      slackBotToken: undefined,
      slackClientId: undefined,
      slackClientSecret: undefined,
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

  it("enables static-token Slack ingress with signing secret and bot token", () => {
    const settings = loadSettings({
      SLACK_BOT_TOKEN: "xoxb-token",
      SLACK_SIGNING_SECRET: "secret",
    });

    expect(settings.slackEnabled).toBe(true);
    expect(settings.slackInstallationStoreEnabled).toBe(false);
    expect(settings.slackOAuthInstallEnabled).toBe(false);
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
