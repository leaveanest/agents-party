import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { AppSettings } from "../../../src/config.js";
import { NodeOAuthHttpGateway } from "../../../src/integrations/oauth/http.js";
import type { SalesforceAuthCoordinator } from "../../../src/integrations/oauth/coordinators.js";
import type { Pool } from "pg";

const settings: AppSettings = {
  agentModelId: "google:gemini-2.5-flash",
  appEnv: "test",
  appHost: "127.0.0.1",
  appName: "agents-party",
  appPort: 0,
  databaseUrl: undefined,
  imageGenerationModelId: "google:gemini-2.5-flash-image",
  llmApiKeyEncryptionKey: undefined,
  googleGenerativeAiApiKey: undefined,
  googleMapsApiKey: undefined,
  transcriptionAlternativeLanguageCodes: ["en-US"],
  transcriptionLanguageCode: "ja-JP",
  transcriptionModelId: "google:speech-to-text-latest-long",
  googleOAuthCallbackPath: "/oauth/google/callback",
  googleOAuthCallbackUrl: "/oauth/google/callback",
  googleOAuthClientId: undefined,
  googleOAuthClientSecret: undefined,
  googleOAuthContextSigningSecret: undefined,
  googleOAuthEnabled: false,
  googleOAuthRedirectBaseUrl: undefined,
  googleOAuthStartPath: "/oauth/google/start",
  googleTokenEncryptionKey: undefined,
  salesforceOAuthCallbackPath: "/oauth/salesforce/callback",
  salesforceOAuthCallbackUrl: "/oauth/salesforce/callback",
  salesforceOAuthContextSigningSecret: "context-secret",
  salesforceOAuthDisconnectPath: "/oauth/salesforce/disconnect",
  salesforceOAuthEnabled: true,
  salesforceOAuthRedirectBaseUrl: "https://app.example.com",
  salesforceOAuthStartPath: "/oauth/salesforce/start",
  salesforceTokenEncryptionKey: "token-key",
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
  videoGenerationModelId: "google:veo-3.1-fast-generate-001",
};

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    server = undefined;
  }
});

describe("NodeOAuthHttpGateway", () => {
  it("accepts Salesforce disconnect context from a JSON POST body", async () => {
    let receivedContext: string | undefined;
    const gateway = new NodeOAuthHttpGateway({
      pool: { end: async () => {} } as Pool,
      salesforce: {
        async disconnectByContext(contextToken: string) {
          receivedContext = contextToken;
          return { connection_status: "revoked" };
        },
      } as unknown as SalesforceAuthCoordinator,
      settings,
    });
    server = createServer((request, response) => {
      void gateway.handle(request, response, new URL(request.url ?? "/", "http://localhost"));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/oauth/salesforce/disconnect`, {
      body: JSON.stringify({ context: "signed-context" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connectionStatus: "revoked",
      status: "ok",
    });
    expect(receivedContext).toBe("signed-context");
  });

  it("rejects oversized Salesforce disconnect JSON bodies before invoking coordinator", async () => {
    let disconnectCalled = false;
    const gateway = new NodeOAuthHttpGateway({
      pool: { end: async () => {} } as Pool,
      salesforce: {
        async disconnectByContext() {
          disconnectCalled = true;
          return { connection_status: "revoked" };
        },
      } as unknown as SalesforceAuthCoordinator,
      settings,
    });
    server = createServer((request, response) => {
      void gateway.handle(request, response, new URL(request.url ?? "/", "http://localhost"));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/oauth/salesforce/disconnect`, {
      body: JSON.stringify({ context: "x".repeat(9000) }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: "request_body_too_large",
    });
    expect(disconnectCalled).toBe(false);
  });
});
