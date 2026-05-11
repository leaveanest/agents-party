import { describe, expect, it } from "vite-plus/test";

import type { AppSettings } from "../../src/config.js";
import { createSlackApp } from "../../src/slack/app.js";

const baseSettings: AppSettings = {
  appEnv: "test",
  appHost: "127.0.0.1",
  appName: "agents-party",
  appPort: 0,
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
  slackScopes: [],
  slackSigningSecret: undefined,
  slackStateSecret: undefined,
  slackUserScopes: [],
};

describe("createSlackApp", () => {
  it("rejects missing Slack configuration", () => {
    expect(() => createSlackApp(baseSettings)).toThrow("Slack is not configured");
  });

  it("constructs a Bolt app in static token mode", () => {
    const result = createSlackApp({
      ...baseSettings,
      slackBotToken: "xoxb-token",
      slackEnabled: true,
      slackSigningSecret: "secret",
    });

    expect(result.app).toBeDefined();
    expect(result.receiver).toBeDefined();
    expect(result.installationStore).toBeUndefined();
  });
});
