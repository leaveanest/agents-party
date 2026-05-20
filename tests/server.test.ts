import { createConnection, type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { AppSettings } from "../src/config.js";
import { createAppServer } from "../src/server.js";

const settings: AppSettings = {
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

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (closeServer !== undefined) {
    await closeServer();
    closeServer = undefined;
  }
});

describe("createAppServer", () => {
  it("serves the health endpoint", async () => {
    const server = createAppServer(settings);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "Agents party",
      status: "ok",
    });
  });

  it("returns JSON for unknown routes", async () => {
    const server = createAppServer(settings);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/missing`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "not_found",
    });
  });

  it("returns JSON for malformed request targets", async () => {
    const server = createAppServer(settings);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

    const address = server.address() as AddressInfo;
    const response = await sendRawHttpRequest(
      address.port,
      "GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );

    expect(response).toContain("HTTP/1.1 400 Bad Request");
    expect(response).toContain('"error":"bad_request"');
  });

  it("delegates Slack events to the configured Slack gateway", async () => {
    let delegatedPath: string | undefined;
    const server = createAppServer(settings, {
      slackGateway: {
        async close() {},
        handle(request, response) {
          delegatedPath = request.url;
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("ok");
        },
      },
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/slack/events`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(delegatedPath).toBe("/slack/events");
  });

  it("does not delegate non-POST Slack event requests", async () => {
    let delegated = false;
    const server = createAppServer(settings, {
      slackGateway: {
        async close() {},
        handle() {
          delegated = true;
        },
      },
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/slack/events`);

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      error: "method_not_allowed",
    });
    expect(delegated).toBe(false);
  });

  it("returns 503 for Slack routes when Slack is not configured", async () => {
    const server = createAppServer(settings);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/slack/install`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "slack_not_configured",
    });
  });

  it("delegates OAuth routes to the configured OAuth gateway", async () => {
    let delegatedPath: string | undefined;
    const server = createAppServer(settings, {
      oauthGateway: {
        async close() {},
        canHandle(pathname) {
          return pathname === "/oauth/google/start";
        },
        async handle(_request, response, url) {
          delegatedPath = url.pathname;
          response.writeHead(302, { location: "https://accounts.google.com/" });
          response.end();
        },
      },
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/oauth/google/start`, {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(delegatedPath).toBe("/oauth/google/start");
  });

  it("delegates the Salesforce disconnect OAuth route to the configured OAuth gateway", async () => {
    let delegatedMethod: string | undefined;
    let delegatedPath: string | undefined;
    const server = createAppServer(settings, {
      oauthGateway: {
        async close() {},
        canHandle(pathname) {
          return pathname === "/oauth/salesforce/disconnect";
        },
        async handle(request, response, url) {
          delegatedMethod = request.method;
          delegatedPath = url.pathname;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "ok" }));
        },
      },
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/oauth/salesforce/disconnect`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(delegatedMethod).toBe("POST");
    expect(delegatedPath).toBe("/oauth/salesforce/disconnect");
  });

  it("returns 503 for OAuth routes when OAuth is not configured", async () => {
    const server = createAppServer(settings);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/oauth/google/start`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "oauth_not_configured",
    });
  });
});

function sendRawHttpRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    socket.on("error", reject);
    socket.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
