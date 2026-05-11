import { Pool } from "pg";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AppSettings } from "../../config.js";
import { PostgresOAuthRepository } from "../../infrastructure/postgres/appRepositories.js";
import { FernetTextCipher } from "./fernet.js";
import {
  GoogleAuthCoordinator,
  OAuthFlowError,
  SalesforceAuthCoordinator,
} from "./coordinators.js";
import { FetchGoogleOAuthGateway, FetchSalesforceOAuthGateway } from "./gateways.js";

const MAX_JSON_BODY_BYTES = 8192;

export type OAuthHttpGateway = {
  canHandle(pathname: string): boolean;
  close(): Promise<void>;
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void>;
};

export class NodeOAuthHttpGateway implements OAuthHttpGateway {
  private readonly google: GoogleAuthCoordinator | undefined;
  private readonly pool: Pool;
  private readonly salesforce: SalesforceAuthCoordinator | undefined;
  private readonly settings: AppSettings;

  constructor(input: {
    google?: GoogleAuthCoordinator;
    pool: Pool;
    salesforce?: SalesforceAuthCoordinator;
    settings: AppSettings;
  }) {
    this.google = input.google;
    this.pool = input.pool;
    this.salesforce = input.salesforce;
    this.settings = input.settings;
  }

  canHandle(pathname: string): boolean {
    return (
      pathname === this.settings.googleOAuthStartPath ||
      pathname === this.settings.googleOAuthCallbackPath ||
      pathname === this.settings.salesforceOAuthStartPath ||
      pathname === this.settings.salesforceOAuthCallbackPath ||
      pathname === this.settings.salesforceOAuthDisconnectPath
    );
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === this.settings.salesforceOAuthDisconnectPath) {
      if (request.method !== "POST") {
        sendJson(response, 405, {
          error: "method_not_allowed",
          message: "Salesforce disconnect only accepts POST requests.",
        });
        return;
      }
      try {
        await this.handleSalesforceDisconnect(request, response, url);
      } catch (error) {
        sendOAuthError(response, error);
      }
      return;
    }

    if (request.method !== "GET") {
      sendJson(response, 405, {
        error: "method_not_allowed",
        message: "OAuth routes only accept GET requests.",
      });
      return;
    }
    try {
      if (url.pathname === this.settings.googleOAuthStartPath) {
        await this.handleGoogleStart(response, url);
        return;
      }
      if (url.pathname === this.settings.googleOAuthCallbackPath) {
        await this.handleGoogleCallback(response, url);
        return;
      }
      if (url.pathname === this.settings.salesforceOAuthStartPath) {
        await this.handleSalesforceStart(response, url);
        return;
      }
      if (url.pathname === this.settings.salesforceOAuthCallbackPath) {
        await this.handleSalesforceCallback(response, url);
        return;
      }
    } catch (error) {
      sendOAuthError(response, error);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async handleGoogleStart(response: ServerResponse, url: URL): Promise<void> {
    if (this.google === undefined) {
      throw new OAuthFlowError("Google OAuth is not configured.", {
        code: "google_oauth_not_configured",
        statusCode: 503,
      });
    }
    const context = url.searchParams.get("context");
    if (context === null || context === "") {
      throw new OAuthFlowError("Missing Google OAuth context.", {
        code: "missing_context",
        statusCode: 400,
      });
    }
    redirect(response, await this.google.beginAuthorization(context));
  }

  private async handleGoogleCallback(response: ServerResponse, url: URL): Promise<void> {
    if (this.google === undefined) {
      throw new OAuthFlowError("Google OAuth is not configured.", {
        code: "google_oauth_not_configured",
        statusCode: 503,
      });
    }
    const result = await this.google.handleCallback({
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
      errorDescription: url.searchParams.get("error_description"),
      stateId: url.searchParams.get("state"),
    });
    sendSuccessOrRedirect(response, result.redirectAfterConnect);
  }

  private async handleSalesforceStart(response: ServerResponse, url: URL): Promise<void> {
    if (this.salesforce === undefined) {
      throw new OAuthFlowError("Salesforce OAuth is not configured.", {
        code: "salesforce_oauth_not_configured",
        statusCode: 503,
      });
    }
    const context = url.searchParams.get("context");
    if (context === null || context === "") {
      throw new OAuthFlowError("Missing Salesforce OAuth context.", {
        code: "missing_context",
        statusCode: 400,
      });
    }
    redirect(response, await this.salesforce.beginAuthorization(context));
  }

  private async handleSalesforceCallback(response: ServerResponse, url: URL): Promise<void> {
    if (this.salesforce === undefined) {
      throw new OAuthFlowError("Salesforce OAuth is not configured.", {
        code: "salesforce_oauth_not_configured",
        statusCode: 503,
      });
    }
    const result = await this.salesforce.handleCallback({
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
      errorDescription: url.searchParams.get("error_description"),
      stateId: url.searchParams.get("state"),
    });
    sendSuccessOrRedirect(response, result.redirectAfterConnect);
  }

  private async handleSalesforceDisconnect(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (this.salesforce === undefined) {
      throw new OAuthFlowError("Salesforce OAuth is not configured.", {
        code: "salesforce_oauth_not_configured",
        statusCode: 503,
      });
    }
    const context = await readContextToken(request, url);
    if (context === undefined) {
      throw new OAuthFlowError("Missing Salesforce OAuth context.", {
        code: "missing_context",
        statusCode: 400,
      });
    }
    const connection = await this.salesforce.disconnectByContext(context);
    sendJson(response, 200, {
      connectionStatus: connection.connection_status,
      status: "ok",
    });
  }
}

export function createOAuthHttpGateway(settings: AppSettings): OAuthHttpGateway | undefined {
  if (!settings.googleOAuthEnabled && !settings.salesforceOAuthEnabled) {
    return undefined;
  }
  if (settings.databaseUrl === undefined) {
    return undefined;
  }
  const pool = new Pool({ connectionString: settings.databaseUrl });
  const repository = new PostgresOAuthRepository(pool);
  const google =
    settings.googleOAuthEnabled &&
    settings.googleOAuthClientId !== undefined &&
    settings.googleOAuthClientSecret !== undefined &&
    settings.googleOAuthContextSigningSecret !== undefined &&
    settings.googleTokenEncryptionKey !== undefined
      ? new GoogleAuthCoordinator({
          contextSigningSecret: settings.googleOAuthContextSigningSecret,
          gateway: new FetchGoogleOAuthGateway({
            clientId: settings.googleOAuthClientId,
            clientSecret: settings.googleOAuthClientSecret,
          }),
          redirectUri: settings.googleOAuthCallbackUrl,
          repository,
          tokenCipher: new FernetTextCipher(settings.googleTokenEncryptionKey),
        })
      : undefined;
  const salesforce =
    settings.salesforceOAuthEnabled &&
    settings.salesforceOAuthContextSigningSecret !== undefined &&
    settings.salesforceTokenEncryptionKey !== undefined
      ? new SalesforceAuthCoordinator({
          contextSigningSecret: settings.salesforceOAuthContextSigningSecret,
          gateway: new FetchSalesforceOAuthGateway({
            clientSecretCipher: new FernetTextCipher(settings.salesforceTokenEncryptionKey),
          }),
          repository,
          tokenCipher: new FernetTextCipher(settings.salesforceTokenEncryptionKey),
        })
      : undefined;
  return new NodeOAuthHttpGateway({ google, pool, salesforce, settings });
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location });
  response.end();
}

function sendSuccessOrRedirect(
  response: ServerResponse,
  redirectAfterConnect: string | null,
): void {
  if (redirectAfterConnect !== null) {
    redirect(response, redirectAfterConnect);
    return;
  }
  sendJson(response, 200, { status: "ok" });
}

function sendOAuthError(response: ServerResponse, error: unknown): void {
  if (error instanceof OAuthFlowError) {
    if (error.redirectAfterConnect !== null) {
      const redirectUrl = new URL(error.redirectAfterConnect, "https://agents-party.local");
      redirectUrl.searchParams.set("oauth_status", "error");
      redirectUrl.searchParams.set("oauth_error", error.code);
      redirect(response, `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`);
      return;
    }
    sendJson(response, error.statusCode, {
      error: error.code,
      message: error.message,
    });
    return;
  }
  sendJson(response, 500, {
    error: "oauth_failed",
    message: "OAuth request failed.",
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

async function readContextToken(request: IncomingMessage, url: URL): Promise<string | undefined> {
  const queryContext = url.searchParams.get("context");
  if (queryContext !== null && queryContext !== "") {
    return queryContext;
  }
  const payload = await readJsonBody(request);
  if (
    payload !== undefined &&
    typeof payload === "object" &&
    payload !== null &&
    "context" in payload &&
    typeof payload.context === "string" &&
    payload.context !== ""
  ) {
    return payload.context;
  }
  return undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown | undefined> {
  const contentLength = readContentLength(request.headers["content-length"]);
  if (contentLength !== undefined && contentLength > MAX_JSON_BODY_BYTES) {
    throw new OAuthFlowError("Request body is too large.", {
      code: "request_body_too_large",
      statusCode: 413,
    });
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_JSON_BODY_BYTES) {
      throw new OAuthFlowError("Request body is too large.", {
        code: "request_body_too_large",
        statusCode: 413,
      });
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OAuthFlowError("Invalid JSON request body.", {
      code: "invalid_json",
      statusCode: 400,
    });
  }
}

function readContentLength(value: string | string[] | undefined): number | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
