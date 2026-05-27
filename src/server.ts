import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { AppSettings } from "./config.js";
import { buildHealthPayload } from "./http/health.js";
import type { OAuthHttpGateway } from "./integrations/oauth/http.js";
import type { SlackGateway } from "./slack/app.js";

export type AppServerDependencies = {
  oauthGateway?: OAuthHttpGateway;
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
    void handleRequest(request, response, settings, dependencies);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  settings: AppSettings,
  dependencies: AppServerDependencies,
): Promise<void> {
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

  if (isOAuthRoute(url.pathname, settings)) {
    if (dependencies.oauthGateway === undefined) {
      sendJson(response, 503, {
        error: "oauth_not_configured",
        message: "OAuth routes are not configured for this process.",
      });
      return;
    }
    await dependencies.oauthGateway.handle(request, response, url);
    return;
  }

  if (isSlackRoute(url.pathname, settings)) {
    logSlackIngress(request, url.pathname);
    if (url.pathname === settings.slackRoutes.eventsPath && method !== "POST") {
      sendJson(response, 405, {
        error: "method_not_allowed",
        message: "Slack events endpoint only accepts POST requests.",
      });
      return;
    }
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

function isOAuthRoute(pathname: string, settings: AppSettings): boolean {
  return (
    pathname === settings.googleOAuthStartPath ||
    pathname === settings.googleOAuthCallbackPath ||
    pathname === settings.salesforceOAuthStartPath ||
    pathname === settings.salesforceOAuthCallbackPath ||
    pathname === settings.salesforceOAuthDisconnectPath
  );
}

function isSlackRoute(pathname: string, settings: AppSettings): boolean {
  const { slackRoutes } = settings;
  return (
    pathname === slackRoutes.eventsPath ||
    pathname === slackRoutes.installPath ||
    pathname === slackRoutes.oauthRedirectPath
  );
}

function parseRequestUrl(rawUrl: string | undefined): URL | undefined {
  try {
    return new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
}

function logSlackIngress(request: IncomingMessage, pathname: string): void {
  console.info("Slack HTTP ingress received.", {
    contentLength: request.headers["content-length"],
    contentType: request.headers["content-type"],
    method: request.method ?? "GET",
    pathname,
    userAgent: request.headers["user-agent"],
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
}
