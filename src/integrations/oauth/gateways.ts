import {
  calculateExpiration,
  type GoogleIdentityClaims,
  type GoogleOAuthTokens,
  type SalesforceAuthConfig,
  type SalesforceIdentity,
  type SalesforceOAuthTokens,
  isSalesforceHost,
} from "./domain.js";
import type { FernetTextCipher } from "./fernet.js";

export class OAuthGatewayError extends Error {
  readonly errorCode: string | undefined;
  readonly retriable: boolean;

  constructor(message: string, options: { errorCode?: string; retriable?: boolean } = {}) {
    super(message);
    this.name = "OAuthGatewayError";
    this.errorCode = options.errorCode;
    this.retriable = options.retriable ?? false;
  }
}

export type GoogleOAuthGateway = {
  buildAuthorizationUrl(input: { redirectUri: string; scopes: string[]; stateId: string }): string;
  exchangeCode(input: { code: string; redirectUri: string }): Promise<GoogleOAuthTokens>;
  verifyIdToken(input: { idToken: string }): Promise<GoogleIdentityClaims>;
  close?(): Promise<void>;
};

export type SalesforceOAuthGateway = {
  buildAuthorizationUrl(input: {
    codeChallenge: string;
    config: SalesforceAuthConfig;
    scopes: string[];
    stateId: string;
  }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    config: SalesforceAuthConfig;
  }): Promise<SalesforceOAuthTokens>;
  lookupIdentity(input: { accessToken: string; identityUrl: string }): Promise<SalesforceIdentity>;
  refreshAccessToken(input: {
    config: SalesforceAuthConfig;
    refreshToken: string;
  }): Promise<SalesforceOAuthTokens>;
  revokeToken(input: { config: SalesforceAuthConfig; token: string }): Promise<void>;
  close?(): Promise<void>;
};

export class FetchGoogleOAuthGateway implements GoogleOAuthGateway {
  private static readonly authorizeUrl = "https://accounts.google.com/o/oauth2/v2/auth";
  private static readonly tokenUrl = "https://oauth2.googleapis.com/token";
  private static readonly tokenInfoUrl = "https://oauth2.googleapis.com/tokeninfo";

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchFn: typeof fetch;

  constructor(input: { clientId: string; clientSecret: string; fetchFn?: typeof fetch }) {
    this.clientId = input.clientId;
    this.clientSecret = input.clientSecret;
    this.fetchFn = input.fetchFn ?? fetch;
  }

  buildAuthorizationUrl(input: { redirectUri: string; scopes: string[]; stateId: string }): string {
    const params = new URLSearchParams({
      access_type: "offline",
      client_id: this.clientId,
      include_granted_scopes: "true",
      prompt: "consent",
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: input.scopes.join(" "),
      state: input.stateId,
    });
    return `${FetchGoogleOAuthGateway.authorizeUrl}?${params.toString()}`;
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<GoogleOAuthTokens> {
    const payload = await this.postForm(FetchGoogleOAuthGateway.tokenUrl, {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    });
    return buildGoogleTokens(payload);
  }

  async verifyIdToken(input: { idToken: string }): Promise<GoogleIdentityClaims> {
    const url = new URL(FetchGoogleOAuthGateway.tokenInfoUrl);
    url.searchParams.set("id_token", input.idToken);
    const response = await this.fetchFn(url);
    const payload = await parseJsonResponse(response, "Google ID token verification failed");
    const audience = textValue(payload.aud);
    if (audience !== this.clientId) {
      throw new OAuthGatewayError("Google ID token audience did not match the OAuth client.", {
        errorCode: "invalid_id_token",
      });
    }
    const subject = textValue(payload.sub);
    if (subject === undefined) {
      throw new OAuthGatewayError("Google ID token response did not include a subject.", {
        errorCode: "invalid_id_token",
      });
    }
    return {
      email: textValue(payload.email) ?? null,
      email_verified: payload.email_verified === true || payload.email_verified === "true",
      subject,
    };
  }

  private async postForm(
    url: string,
    data: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchFn(url, {
      body: new URLSearchParams(data),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    return parseJsonResponse(response, "Google OAuth request failed");
  }
}

export class FetchSalesforceOAuthGateway implements SalesforceOAuthGateway {
  private readonly clientSecretCipher: FernetTextCipher | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(input: { clientSecretCipher?: FernetTextCipher; fetchFn?: typeof fetch } = {}) {
    this.clientSecretCipher = input.clientSecretCipher;
    this.fetchFn = input.fetchFn ?? fetch;
  }

  buildAuthorizationUrl(input: {
    codeChallenge: string;
    config: SalesforceAuthConfig;
    scopes: string[];
    stateId: string;
  }): string {
    const params = new URLSearchParams({
      client_id: input.config.oauth_client_id,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: input.config.redirect_uri,
      response_type: "code",
      scope: input.scopes.join(" "),
      state: input.stateId,
    });
    return `${oauthBaseUrl(input.config)}/authorize?${params.toString()}`;
  }

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    config: SalesforceAuthConfig;
  }): Promise<SalesforceOAuthTokens> {
    const payload = await this.postForm(`${oauthBaseUrl(input.config)}/token`, {
      ...this.baseTokenData(input.config),
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.config.redirect_uri,
    });
    return buildSalesforceTokens(payload);
  }

  async lookupIdentity(input: {
    accessToken: string;
    identityUrl: string;
  }): Promise<SalesforceIdentity> {
    const identityUrl = validateSalesforceUrl(input.identityUrl, "invalid_identity_url");
    const response = await this.fetchFn(identityUrl, {
      headers: { authorization: `Bearer ${input.accessToken}` },
    });
    const payload = await parseJsonResponse(response, "Salesforce OAuth identity lookup failed");
    const organizationId = textValue(payload.organization_id);
    const userId = textValue(payload.user_id);
    if (organizationId === undefined || userId === undefined) {
      throw new OAuthGatewayError("Salesforce identity response missed stable identity fields.", {
        errorCode: "invalid_identity_response",
      });
    }
    return {
      email: textValue(payload.email) ?? null,
      identity_url: textValue(payload.id) ?? identityUrl,
      organization_id: organizationId,
      user_id: userId,
      username: textValue(payload.username) ?? null,
    };
  }

  async refreshAccessToken(input: {
    config: SalesforceAuthConfig;
    refreshToken: string;
  }): Promise<SalesforceOAuthTokens> {
    const payload = await this.postForm(`${oauthBaseUrl(input.config)}/token`, {
      ...this.baseTokenData(input.config),
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    });
    return buildSalesforceTokens(payload);
  }

  async revokeToken(input: { config: SalesforceAuthConfig; token: string }): Promise<void> {
    await this.postFormWithoutJson(`${oauthBaseUrl(input.config)}/revoke`, {
      token: input.token,
    });
  }

  private baseTokenData(config: SalesforceAuthConfig): Record<string, string> {
    const data: Record<string, string> = { client_id: config.oauth_client_id };
    if (
      config.oauth_client_secret_encrypted === undefined ||
      config.oauth_client_secret_encrypted === null
    ) {
      return data;
    }
    if (this.clientSecretCipher === undefined) {
      throw new OAuthGatewayError("Salesforce OAuth client secret cannot be decrypted.", {
        errorCode: "client_secret_unavailable",
      });
    }
    data.client_secret = this.clientSecretCipher.decrypt(config.oauth_client_secret_encrypted);
    return data;
  }

  private async postForm(
    url: string,
    data: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchFn(url, {
      body: new URLSearchParams(data),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    return parseJsonResponse(response, "Salesforce OAuth request failed");
  }

  private async postFormWithoutJson(url: string, data: Record<string, string>): Promise<void> {
    const response = await this.fetchFn(url, {
      body: new URLSearchParams(data),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    if (response.ok) {
      return;
    }
    const payload = await safeJson(response);
    throw new OAuthGatewayError(errorDescription(payload) ?? "Salesforce OAuth request failed", {
      errorCode: textValue(payload.error),
      retriable: response.status >= 500,
    });
  }
}

function buildGoogleTokens(payload: Record<string, unknown>): GoogleOAuthTokens {
  const accessToken = textValue(payload.access_token);
  if (accessToken === undefined) {
    throw new OAuthGatewayError("Google OAuth token response did not include an access token.", {
      errorCode: "invalid_token_response",
    });
  }
  return {
    access_token: accessToken,
    expires_at: calculateExpiration(numberValue(payload.expires_in)),
    granted_scopes: splitScopes(payload.scope),
    id_token: textValue(payload.id_token),
    refresh_token: textValue(payload.refresh_token),
    refresh_token_expires_at: calculateExpiration(numberValue(payload.refresh_token_expires_in)),
  };
}

function buildSalesforceTokens(payload: Record<string, unknown>): SalesforceOAuthTokens {
  const accessToken = textValue(payload.access_token);
  if (accessToken === undefined) {
    throw new OAuthGatewayError(
      "Salesforce OAuth token response did not include an access token.",
      {
        errorCode: "invalid_token_response",
      },
    );
  }
  return {
    access_token: accessToken,
    expires_at: calculateExpiration(numberValue(payload.expires_in)),
    granted_scopes: splitScopes(payload.scope),
    identity_url: optionalSalesforceUrl(payload.id),
    instance_url: optionalSalesforceUrl(payload.instance_url),
    refresh_token: textValue(payload.refresh_token),
  };
}

async function parseJsonResponse(
  response: Response,
  fallbackMessage: string,
): Promise<Record<string, unknown>> {
  const payload = await safeJson(response);
  if (response.ok) {
    return payload;
  }
  throw new OAuthGatewayError(errorDescription(payload) ?? fallbackMessage, {
    errorCode: textValue(payload.error),
    retriable: response.status >= 500,
  });
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload = (await response.json()) as unknown;
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function errorDescription(payload: Record<string, unknown>): string | undefined {
  return textValue(payload.error_description) ?? textValue(payload.error);
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function splitScopes(value: unknown): string[] {
  return typeof value === "string" ? value.split(/\s+/).filter((scope) => scope.length > 0) : [];
}

function oauthBaseUrl(config: SalesforceAuthConfig): string {
  return `https://${config.salesforce_my_domain_host}/services/oauth2`;
}

function optionalSalesforceUrl(value: unknown): string | undefined {
  const text = textValue(value);
  return text === undefined ? undefined : validateSalesforceUrl(text, "invalid_salesforce_url");
}

function validateSalesforceUrl(value: string, errorCode: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname === "" ||
    !isSalesforceHost(parsed.hostname)
  ) {
    throw new OAuthGatewayError("Salesforce OAuth response included an unsafe Salesforce URL.", {
      errorCode,
    });
  }
  return value;
}
