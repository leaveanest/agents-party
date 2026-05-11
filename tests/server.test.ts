import { createConnection, type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { AppSettings } from "../src/config.js";
import { createAppServer } from "../src/server.js";

const settings: AppSettings = {
  agentModelId: "google:gemini-2.5-flash",
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
      service: "agents-party",
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
