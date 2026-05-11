import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { AppSettings } from "./config.js";
import { buildHealthPayload } from "./http/health.js";
import type { SlackGateway } from "./slack/app.js";

export type AppServerDependencies = {
  slackGateway?: SlackGateway;
};

/**
 * Create the HTTP server for the TypeScript application runtime.
 *
 * @param settings - Runtime settings used by request handlers.
 * @returns Node HTTP server exposing the initial app endpoints.
 */
export function createAppServer(
  settings: AppSettings,
  dependencies: AppServerDependencies = {},
): Server {
  return createServer((request, response) => {
    handleRequest(request, response, settings, dependencies);
  });
}

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  settings: AppSettings,
  dependencies: AppServerDependencies,
): void {
  const method = request.method ?? "GET";
  const url = parseRequestUrl(request.url);
  if (url === undefined) {
    sendJson(response, 400, {
      error: "bad_request",
      message: "Malformed request URL.",
    });
    return;
  }

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, buildHealthPayload(settings));
    return;
  }

  if (isSlackRoute(url.pathname, settings)) {
    if (dependencies.slackGateway === undefined) {
      sendJson(response, 503, {
        error: "slack_not_configured",
        message: "Slack ingress is not configured for this process.",
      });
      return;
    }
    dependencies.slackGateway.handle(request, response);
    return;
  }

  sendJson(response, 404, {
    error: "not_found",
    message: "Route not found.",
  });
}

function isSlackRoute(pathname: string, settings: AppSettings): boolean {
  return (
    pathname === settings.slackEventsPath ||
    pathname === settings.slackInstallPath ||
    pathname === settings.slackOAuthRedirectPath
  );
}

function parseRequestUrl(rawUrl: string | undefined): URL | undefined {
  try {
    return new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
}
