import type {
  GoogleAuthConnectionDocument as StoredGoogleConnectionDocument,
  OAuthStateDocument as StoredOAuthStateDocument,
  SalesforceConnectionDocument as StoredSalesforceConnectionDocument,
  SalesforceOAuthStateDocument as StoredSalesforceOAuthStateDocument,
} from "../../infrastructure/postgres/appRepositories.js";
import type { JsonObject } from "../../infrastructure/postgres/jsonDocumentRepository.js";
import {
  GOOGLE_OAUTH_SCOPES,
  SALESFORCE_OAUTH_SCOPES,
  buildPkceCodeChallenge,
  createPkceCodeVerifier,
  createStateId,
  googleAuthConnectionSchema,
  googleOAuthStartContextSchema,
  googleOAuthStateSchema,
  googleOAuthStateTokenSchema,
  normalizeRedirectAfterConnect,
  salesforceAuthConfigSchema,
  salesforceConnectionSchema,
  salesforceOAuthStartContextSchema,
  salesforceOAuthStateSchema,
  salesforceOAuthStateTokenSchema,
  toIso,
  toJsonObject,
  type GoogleAuthConnection,
  type GoogleOAuthState,
  type SalesforceAuthConfig,
  type SalesforceConnection,
  type SalesforceOAuthState,
} from "./domain.js";
import { OAuthContextError, OAuthContextSigner } from "./contextSigner.js";
import type { FernetTextCipher } from "./fernet.js";
import {
  OAuthGatewayError,
  type GoogleOAuthGateway,
  type SalesforceOAuthGateway,
} from "./gateways.js";

export type OAuthRepository = {
  consumeGoogleOAuthState(teamId: string, stateId: string): Promise<JsonObject | undefined>;
  consumeSalesforceOAuthState(teamId: string, stateId: string): Promise<JsonObject | undefined>;
  findGoogleConnection(
    teamId: string,
    slackUserId: string,
    googleAccountSubject: string,
  ): Promise<JsonObject | undefined>;
  findSalesforceAuthConfig(
    teamId: string,
    salesforceOrgId: string,
  ): Promise<JsonObject | undefined>;
  findSalesforceConnection(
    teamId: string,
    slackUserId: string,
    salesforceOrgId: string,
  ): Promise<JsonObject | undefined>;
  saveGoogleConnection(document: StoredGoogleConnectionDocument): Promise<void>;
  saveGoogleOAuthState(document: StoredOAuthStateDocument): Promise<void>;
  saveSalesforceConnection(document: StoredSalesforceConnectionDocument): Promise<void>;
  saveSalesforceOAuthState(document: StoredSalesforceOAuthStateDocument): Promise<void>;
};

export class OAuthFlowError extends Error {
  readonly code: string;
  readonly redirectAfterConnect: string | null;
  readonly statusCode: number;

  constructor(
    message: string,
    input: { code: string; redirectAfterConnect?: string | null; statusCode: number },
  ) {
    super(message);
    this.name = "OAuthFlowError";
    this.code = input.code;
    this.statusCode = input.statusCode;
    this.redirectAfterConnect = input.redirectAfterConnect ?? null;
  }
}

export function issueSalesforceOAuthStartContext(input: {
  contextSigningSecret: string;
  redirectAfterConnect?: string | null;
  salesforceOrgId: string;
  slackUserId: string;
  teamId: string;
  ttlMs?: number;
}): string {
  return issueSalesforceOAuthContext({ ...input, contextAction: "start" });
}

export function issueSalesforceOAuthDisconnectContext(input: {
  contextSigningSecret: string;
  redirectAfterConnect?: string | null;
  salesforceOrgId: string;
  slackUserId: string;
  teamId: string;
  ttlMs?: number;
}): string {
  return issueSalesforceOAuthContext({ ...input, contextAction: "disconnect" });
}

function issueSalesforceOAuthContext(input: {
  contextAction: "disconnect" | "start";
  contextSigningSecret: string;
  redirectAfterConnect?: string | null;
  salesforceOrgId: string;
  slackUserId: string;
  teamId: string;
  ttlMs?: number;
}): string {
  const signer = new OAuthContextSigner({
    contextSchema: salesforceOAuthStartContextSchema,
    secret: input.contextSigningSecret,
    stateTokenSchema: salesforceOAuthStateTokenSchema,
  });
  return signer.dumps({
    context_action: input.contextAction,
    expires_at: new Date(Date.now() + (input.ttlMs ?? 10 * 60 * 1000)).toISOString(),
    redirect_after_connect: normalizeRedirectAfterConnect(input.redirectAfterConnect),
    salesforce_org_id: input.salesforceOrgId,
    slack_user_id: input.slackUserId,
    team_id: input.teamId,
  });
}

export class GoogleAuthCoordinator {
  private readonly gateway: GoogleOAuthGateway;
  private readonly redirectUri: string;
  private readonly repository: OAuthRepository;
  private readonly scopes: string[];
  private readonly signer: OAuthContextSigner<
    ReturnType<typeof googleOAuthStartContextSchema.parse>,
    ReturnType<typeof googleOAuthStateTokenSchema.parse>
  >;
  private readonly tokenCipher: FernetTextCipher;

  constructor(input: {
    contextSigningSecret: string;
    gateway: GoogleOAuthGateway;
    redirectUri: string;
    repository: OAuthRepository;
    scopes?: string[];
    tokenCipher: FernetTextCipher;
  }) {
    this.gateway = input.gateway;
    this.redirectUri = input.redirectUri;
    this.repository = input.repository;
    this.scopes = input.scopes ?? [...GOOGLE_OAUTH_SCOPES];
    this.signer = new OAuthContextSigner({
      contextSchema: googleOAuthStartContextSchema,
      secret: input.contextSigningSecret,
      stateTokenSchema: googleOAuthStateTokenSchema,
    });
    this.tokenCipher = input.tokenCipher;
  }

  issueStartContext(input: {
    redirectAfterConnect?: string | null;
    slackUserId: string;
    teamId: string;
    ttlMs?: number;
  }): string {
    return this.signer.dumps({
      expires_at: new Date(Date.now() + (input.ttlMs ?? 10 * 60 * 1000)).toISOString(),
      redirect_after_connect: normalizeRedirectAfterConnect(input.redirectAfterConnect),
      slack_user_id: input.slackUserId,
      team_id: input.teamId,
    });
  }

  async beginAuthorization(contextToken: string): Promise<string> {
    const context = this.loadContext(contextToken, "invalid_context");
    const redirectAfterConnect = normalizeRedirectAfterConnect(context.redirect_after_connect);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
    const state: GoogleOAuthState = {
      created_at: now,
      expires_at: expiresAt,
      redirect_after_connect: redirectAfterConnect,
      requested_scopes: this.scopes,
      slack_user_id: context.slack_user_id,
      state_id: createStateId(),
      team_id: context.team_id,
    };
    await this.repository.saveGoogleOAuthState(toStoredGoogleState(state));
    return this.gateway.buildAuthorizationUrl({
      redirectUri: this.redirectUri,
      scopes: state.requested_scopes,
      stateId: this.signer.dumpsStateToken({
        expires_at: expiresAt.toISOString(),
        state_id: state.state_id,
        team_id: state.team_id,
      }),
    });
  }

  async handleCallback(input: {
    code?: string | null;
    error?: string | null;
    errorDescription?: string | null;
    stateId?: string | null;
  }): Promise<{ connection: GoogleAuthConnection; redirectAfterConnect: string | null }> {
    const state = await this.consumeCallbackState(input.stateId);
    if (state.expires_at.getTime() <= Date.now()) {
      throw new OAuthFlowError("Expired Google OAuth state.", {
        code: "expired_state",
        redirectAfterConnect: state.redirect_after_connect,
        statusCode: 400,
      });
    }
    if (input.error !== undefined && input.error !== null && input.error !== "") {
      throw new OAuthFlowError(input.errorDescription ?? input.error, {
        code: input.error,
        redirectAfterConnect: state.redirect_after_connect,
        statusCode: 400,
      });
    }
    if (input.code === undefined || input.code === null || input.code === "") {
      throw new OAuthFlowError("Missing Google OAuth authorization code.", {
        code: "missing_code",
        redirectAfterConnect: state.redirect_after_connect,
        statusCode: 400,
      });
    }
    try {
      const tokens = await this.gateway.exchangeCode({
        code: input.code,
        redirectUri: this.redirectUri,
      });
      if (tokens.id_token === undefined) {
        throw new OAuthFlowError("Google OAuth token response did not include an ID token.", {
          code: "missing_id_token",
          redirectAfterConnect: state.redirect_after_connect,
          statusCode: 502,
        });
      }
      const claims = await this.gateway.verifyIdToken({ idToken: tokens.id_token });
      const existing = await this.findGoogleConnection(
        state.team_id,
        state.slack_user_id,
        claims.subject,
      );
      const now = new Date();
      const connection: GoogleAuthConnection = {
        access_token_encrypted: this.tokenCipher.encrypt(tokens.access_token),
        connection_status: "active",
        created_at: existing?.created_at ?? now,
        google_account_email: claims.email ?? null,
        google_account_email_verified: claims.email_verified,
        google_account_subject: claims.subject,
        granted_scopes:
          tokens.granted_scopes.length > 0 ? tokens.granted_scopes : state.requested_scopes,
        last_refresh_error_at: null,
        last_refresh_error_code: null,
        last_refreshed_at: existing?.last_refreshed_at ?? null,
        last_successful_access_at: now,
        refresh_token_encrypted:
          tokens.refresh_token === undefined
            ? (existing?.refresh_token_encrypted ?? null)
            : this.tokenCipher.encrypt(tokens.refresh_token),
        refresh_token_expires_at:
          tokens.refresh_token_expires_at ?? existing?.refresh_token_expires_at ?? null,
        slack_user_id: state.slack_user_id,
        team_id: state.team_id,
        token_expires_at: tokens.expires_at ?? null,
        updated_at: now,
      };
      await this.repository.saveGoogleConnection(toStoredGoogleConnection(connection));
      return { connection, redirectAfterConnect: state.redirect_after_connect };
    } catch (error) {
      if (error instanceof OAuthFlowError) {
        throw error;
      }
      throw flowErrorFromUnknown(error, state.redirect_after_connect);
    }
  }

  private loadContext(
    contextToken: string,
    code: string,
  ): ReturnType<typeof googleOAuthStartContextSchema.parse> {
    try {
      return this.signer.loads(contextToken);
    } catch (error) {
      if (error instanceof OAuthContextError) {
        throw new OAuthFlowError(error.message, { code, statusCode: 400 });
      }
      throw error;
    }
  }

  private async consumeCallbackState(
    stateId: string | null | undefined,
  ): Promise<GoogleOAuthState> {
    if (stateId === undefined || stateId === null || stateId === "") {
      throw new OAuthFlowError("Missing Google OAuth state.", {
        code: "missing_state",
        statusCode: 400,
      });
    }
    let stateReference: ReturnType<typeof googleOAuthStateTokenSchema.parse>;
    try {
      stateReference = this.signer.loadsStateToken(stateId);
    } catch {
      throw new OAuthFlowError("Invalid Google OAuth state.", {
        code: "invalid_state",
        statusCode: 400,
      });
    }
    const payload = await this.repository.consumeGoogleOAuthState(
      stateReference.team_id,
      stateReference.state_id,
    );
    if (payload === undefined) {
      throw new OAuthFlowError("Unknown or already consumed Google OAuth state.", {
        code: "invalid_state",
        statusCode: 400,
      });
    }
    return googleOAuthStateSchema.parse(payload);
  }

  private async findGoogleConnection(
    teamId: string,
    slackUserId: string,
    googleAccountSubject: string,
  ): Promise<GoogleAuthConnection | undefined> {
    const payload = await this.repository.findGoogleConnection(
      teamId,
      slackUserId,
      googleAccountSubject,
    );
    return payload === undefined ? undefined : googleAuthConnectionSchema.parse(payload);
  }
}

export class SalesforceAuthCoordinator {
  private readonly contextSigningSecret: string;
  private readonly gateway: SalesforceOAuthGateway;
  private readonly repository: OAuthRepository;
  private readonly signer: OAuthContextSigner<
    ReturnType<typeof salesforceOAuthStartContextSchema.parse>,
    ReturnType<typeof salesforceOAuthStateTokenSchema.parse>
  >;
  private readonly tokenCipher: FernetTextCipher;

  constructor(input: {
    contextSigningSecret: string;
    gateway: SalesforceOAuthGateway;
    repository: OAuthRepository;
    tokenCipher: FernetTextCipher;
  }) {
    this.contextSigningSecret = input.contextSigningSecret;
    this.gateway = input.gateway;
    this.repository = input.repository;
    this.signer = new OAuthContextSigner({
      contextSchema: salesforceOAuthStartContextSchema,
      secret: input.contextSigningSecret,
      stateTokenSchema: salesforceOAuthStateTokenSchema,
    });
    this.tokenCipher = input.tokenCipher;
  }

  issueStartContext(input: {
    redirectAfterConnect?: string | null;
    salesforceOrgId: string;
    slackUserId: string;
    teamId: string;
    ttlMs?: number;
  }): string {
    return issueSalesforceOAuthStartContext({
      contextSigningSecret: this.contextSigningSecret,
      ...input,
    });
  }

  async beginAuthorization(contextToken: string): Promise<string> {
    const context = this.loadStartContext(contextToken);
    const redirectAfterConnect = normalizeRedirectAfterConnect(context.redirect_after_connect);
    const config = await this.requireActiveConfig(context.team_id, context.salesforce_org_id);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
    const verifier = createPkceCodeVerifier();
    const state: SalesforceOAuthState = {
      created_at: now,
      expires_at: expiresAt,
      pkce_code_verifier_encrypted: this.tokenCipher.encrypt(verifier),
      redirect_after_connect: redirectAfterConnect,
      requested_scopes:
        config.default_scopes.length > 0 ? config.default_scopes : [...SALESFORCE_OAUTH_SCOPES],
      salesforce_org_id: context.salesforce_org_id,
      slack_user_id: context.slack_user_id,
      state_id: createStateId(),
      team_id: context.team_id,
    };
    await this.repository.saveSalesforceOAuthState(toStoredSalesforceState(state));
    return this.gateway.buildAuthorizationUrl({
      codeChallenge: buildPkceCodeChallenge(verifier),
      config,
      scopes: state.requested_scopes,
      stateId: this.signer.dumpsStateToken({
        expires_at: expiresAt.toISOString(),
        state_id: state.state_id,
        team_id: state.team_id,
      }),
    });
  }

  async handleCallback(input: {
    code?: string | null;
    error?: string | null;
    errorDescription?: string | null;
    stateId?: string | null;
  }): Promise<{ connection: SalesforceConnection; redirectAfterConnect: string | null }> {
    const state = await this.consumeCallbackState(input.stateId);
    if (state.expires_at.getTime() <= Date.now()) {
      throw new OAuthFlowError("Expired Salesforce OAuth state.", {
        code: "expired_state",
        redirectAfterConnect: state.redirect_after_connect,
        statusCode: 400,
      });
    }
    if (input.error !== undefined && input.error !== null && input.error !== "") {
      throw new OAuthFlowError(input.errorDescription ?? input.error, {
        code: input.error,
        redirectAfterConnect: state.redirect_after_connect,
        statusCode: 400,
      });
    }
    if (input.code === undefined || input.code === null || input.code === "") {
      throw new OAuthFlowError("Missing Salesforce OAuth authorization code.", {
        code: "missing_code",
        redirectAfterConnect: state.redirect_after_connect,
        statusCode: 400,
      });
    }
    const config = await this.requireActiveConfig(
      state.team_id,
      state.salesforce_org_id,
      state.redirect_after_connect,
    );
    try {
      const codeVerifier = this.tokenCipher.decrypt(state.pkce_code_verifier_encrypted);
      const tokens = await this.gateway.exchangeCode({
        code: input.code,
        codeVerifier,
        config,
      });
      if (tokens.identity_url === undefined) {
        throw new OAuthFlowError(
          "Salesforce OAuth token response did not include an identity URL.",
          {
            code: "missing_identity_url",
            redirectAfterConnect: state.redirect_after_connect,
            statusCode: 502,
          },
        );
      }
      const identity = await this.gateway.lookupIdentity({
        accessToken: tokens.access_token,
        identityUrl: tokens.identity_url,
      });
      if (identity.organization_id !== state.salesforce_org_id) {
        throw new OAuthFlowError("Salesforce OAuth identity did not match the requested org.", {
          code: "org_mismatch",
          redirectAfterConnect: state.redirect_after_connect,
          statusCode: 400,
        });
      }
      const existing = await this.findSalesforceConnection(
        state.team_id,
        state.slack_user_id,
        state.salesforce_org_id,
      );
      const now = new Date();
      const connection: SalesforceConnection = {
        access_token_encrypted: this.tokenCipher.encrypt(tokens.access_token),
        connection_status: "active",
        created_at: existing?.created_at ?? now,
        granted_scopes:
          tokens.granted_scopes.length > 0 ? tokens.granted_scopes : state.requested_scopes,
        last_refresh_error_at: null,
        last_refresh_error_code: null,
        last_refreshed_at: existing?.last_refreshed_at ?? null,
        last_successful_access_at: now,
        refresh_token_encrypted:
          tokens.refresh_token === undefined
            ? (existing?.refresh_token_encrypted ?? null)
            : this.tokenCipher.encrypt(tokens.refresh_token),
        salesforce_identity_url: identity.identity_url ?? tokens.identity_url,
        salesforce_instance_url: tokens.instance_url,
        salesforce_org_id: state.salesforce_org_id,
        salesforce_user_email: identity.email ?? null,
        salesforce_user_id: identity.user_id,
        salesforce_username: identity.username ?? null,
        slack_user_id: state.slack_user_id,
        team_id: state.team_id,
        token_expires_at: tokens.expires_at ?? null,
        updated_at: now,
      };
      await this.repository.saveSalesforceConnection(toStoredSalesforceConnection(connection));
      return { connection, redirectAfterConnect: state.redirect_after_connect };
    } catch (error) {
      if (error instanceof OAuthFlowError) {
        throw error;
      }
      throw flowErrorFromUnknown(error, state.redirect_after_connect);
    }
  }

  async refreshConnection(input: {
    salesforceOrgId: string;
    slackUserId: string;
    teamId: string;
  }): Promise<SalesforceConnection> {
    const config = await this.requireActiveConfig(input.teamId, input.salesforceOrgId);
    const connection = await this.requireSalesforceConnection(
      input.teamId,
      input.slackUserId,
      input.salesforceOrgId,
    );
    if (
      connection.refresh_token_encrypted === undefined ||
      connection.refresh_token_encrypted === null
    ) {
      await this.saveSalesforceConnectionWithRefreshError(connection, {
        code: "missing_refresh_token",
        status: "expired",
      });
      throw new OAuthFlowError("Salesforce connection requires reconnect.", {
        code: "salesforce_reconnect_required",
        statusCode: 401,
      });
    }

    let refreshToken: string;
    try {
      refreshToken = this.tokenCipher.decrypt(connection.refresh_token_encrypted);
    } catch {
      await this.saveSalesforceConnectionWithRefreshError(connection, {
        code: "refresh_token_decrypt_failed",
        status: "error",
      });
      throw new OAuthFlowError("Salesforce refresh token could not be decrypted.", {
        code: "refresh_token_decrypt_failed",
        statusCode: 500,
      });
    }

    try {
      const tokens = await this.gateway.refreshAccessToken({ config, refreshToken });
      const now = new Date();
      const refreshed: SalesforceConnection = {
        ...connection,
        access_token_encrypted: this.tokenCipher.encrypt(tokens.access_token),
        connection_status: "active",
        granted_scopes:
          tokens.granted_scopes.length > 0 ? tokens.granted_scopes : connection.granted_scopes,
        last_refresh_error_at: null,
        last_refresh_error_code: null,
        last_refreshed_at: now,
        last_successful_access_at: now,
        refresh_token_encrypted:
          tokens.refresh_token === undefined
            ? (connection.refresh_token_encrypted ?? null)
            : this.tokenCipher.encrypt(tokens.refresh_token),
        salesforce_instance_url: tokens.instance_url ?? connection.salesforce_instance_url,
        token_expires_at: tokens.expires_at ?? null,
        updated_at: now,
      };
      await this.repository.saveSalesforceConnection(toStoredSalesforceConnection(refreshed));
      return refreshed;
    } catch (error) {
      if (error instanceof OAuthGatewayError && isRevokedRefreshTokenError(error)) {
        await this.saveSalesforceConnectionWithRefreshError(connection, {
          code: error.errorCode ?? "invalid_grant",
          status: "expired",
        });
        throw new OAuthFlowError("Salesforce connection requires reconnect.", {
          code: error.errorCode ?? "invalid_grant",
          statusCode: 401,
        });
      }
      throw flowErrorFromUnknown(error, null);
    }
  }

  async disconnectByContext(contextToken: string): Promise<SalesforceConnection> {
    const context = this.loadContext(contextToken, "disconnect");
    return this.disconnectConnection({
      salesforceOrgId: context.salesforce_org_id,
      slackUserId: context.slack_user_id,
      teamId: context.team_id,
    });
  }

  async disconnectConnection(input: {
    salesforceOrgId: string;
    slackUserId: string;
    teamId: string;
  }): Promise<SalesforceConnection> {
    const config = await this.requireActiveConfig(input.teamId, input.salesforceOrgId);
    const connection = await this.requireSalesforceConnection(
      input.teamId,
      input.slackUserId,
      input.salesforceOrgId,
    );
    let tokenToRevoke: string | undefined;
    try {
      const encryptedToken =
        connection.refresh_token_encrypted === undefined ||
        connection.refresh_token_encrypted === null
          ? connection.access_token_encrypted
          : connection.refresh_token_encrypted;
      tokenToRevoke = this.tokenCipher.decrypt(encryptedToken);
    } catch {
      return this.saveDisconnectedConnection(connection, {
        code: "token_decrypt_failed",
        status: "error",
      });
    }

    try {
      await this.gateway.revokeToken({ config, token: tokenToRevoke });
      return this.saveDisconnectedConnection(connection, { code: null, status: "revoked" });
    } catch (error) {
      const code =
        error instanceof OAuthGatewayError ? (error.errorCode ?? "revoke_failed") : "revoke_failed";
      await this.saveDisconnectedConnection(connection, { code, status: "error" });
      if (error instanceof OAuthGatewayError) {
        throw new OAuthFlowError(error.message, {
          code,
          statusCode: error.retriable ? 502 : 400,
        });
      }
      throw new OAuthFlowError("Salesforce disconnect failed.", {
        code,
        statusCode: 500,
      });
    }
  }

  issueDisconnectContext(input: {
    redirectAfterConnect?: string | null;
    salesforceOrgId: string;
    slackUserId: string;
    teamId: string;
    ttlMs?: number;
  }): string {
    return issueSalesforceOAuthDisconnectContext({
      contextSigningSecret: this.contextSigningSecret,
      ...input,
    });
  }

  private loadStartContext(
    contextToken: string,
  ): ReturnType<typeof salesforceOAuthStartContextSchema.parse> {
    return this.loadContext(contextToken, "start");
  }

  private loadContext(
    contextToken: string,
    expectedAction: "disconnect" | "start",
  ): ReturnType<typeof salesforceOAuthStartContextSchema.parse> {
    try {
      const context = this.signer.loads(contextToken);
      if (context.context_action !== expectedAction) {
        throw new OAuthFlowError("Invalid Salesforce OAuth context action.", {
          code: "invalid_context_action",
          statusCode: 400,
        });
      }
      return context;
    } catch (error) {
      if (error instanceof OAuthFlowError) {
        throw error;
      }
      throw new OAuthFlowError("Invalid Salesforce OAuth context.", {
        code: "invalid_context",
        statusCode: 400,
      });
    }
  }

  private async requireActiveConfig(
    teamId: string,
    salesforceOrgId: string,
    redirectAfterConnect: string | null = null,
  ): Promise<SalesforceAuthConfig> {
    const payload = await this.repository.findSalesforceAuthConfig(teamId, salesforceOrgId);
    if (payload === undefined) {
      throw new OAuthFlowError("Salesforce OAuth config was not found.", {
        code: "missing_salesforce_config",
        redirectAfterConnect,
        statusCode: 404,
      });
    }
    const config = salesforceAuthConfigSchema.parse(payload);
    if (config.status !== "active") {
      throw new OAuthFlowError("Salesforce OAuth config is not active.", {
        code: "inactive_salesforce_config",
        redirectAfterConnect,
        statusCode: 400,
      });
    }
    return config;
  }

  private async consumeCallbackState(
    stateId: string | null | undefined,
  ): Promise<SalesforceOAuthState> {
    if (stateId === undefined || stateId === null || stateId === "") {
      throw new OAuthFlowError("Missing Salesforce OAuth state.", {
        code: "missing_state",
        statusCode: 400,
      });
    }
    let stateReference: ReturnType<typeof salesforceOAuthStateTokenSchema.parse>;
    try {
      stateReference = this.signer.loadsStateToken(stateId);
    } catch {
      throw new OAuthFlowError("Invalid Salesforce OAuth state.", {
        code: "invalid_state",
        statusCode: 400,
      });
    }
    const payload = await this.repository.consumeSalesforceOAuthState(
      stateReference.team_id,
      stateReference.state_id,
    );
    if (payload === undefined) {
      throw new OAuthFlowError("Unknown or already consumed Salesforce OAuth state.", {
        code: "invalid_state",
        statusCode: 400,
      });
    }
    return salesforceOAuthStateSchema.parse(payload);
  }

  private async findSalesforceConnection(
    teamId: string,
    slackUserId: string,
    salesforceOrgId: string,
  ): Promise<SalesforceConnection | undefined> {
    const payload = await this.repository.findSalesforceConnection(
      teamId,
      slackUserId,
      salesforceOrgId,
    );
    return payload === undefined ? undefined : salesforceConnectionSchema.parse(payload);
  }

  private async requireSalesforceConnection(
    teamId: string,
    slackUserId: string,
    salesforceOrgId: string,
  ): Promise<SalesforceConnection> {
    const connection = await this.findSalesforceConnection(teamId, slackUserId, salesforceOrgId);
    if (connection === undefined) {
      throw new OAuthFlowError("Salesforce connection was not found.", {
        code: "missing_salesforce_connection",
        statusCode: 404,
      });
    }
    return connection;
  }

  private async saveSalesforceConnectionWithRefreshError(
    connection: SalesforceConnection,
    input: { code: string; status: string },
  ): Promise<SalesforceConnection> {
    const updated: SalesforceConnection = {
      ...connection,
      connection_status: input.status,
      last_refresh_error_at: new Date(),
      last_refresh_error_code: input.code,
      updated_at: new Date(),
    };
    await this.repository.saveSalesforceConnection(toStoredSalesforceConnection(updated));
    return updated;
  }

  private async saveDisconnectedConnection(
    connection: SalesforceConnection,
    input: { code: string | null; status: string },
  ): Promise<SalesforceConnection> {
    const updated: SalesforceConnection = {
      ...connection,
      connection_status: input.status,
      last_refresh_error_at: input.code === null ? null : new Date(),
      last_refresh_error_code: input.code,
      updated_at: new Date(),
    };
    await this.repository.saveSalesforceConnection(toStoredSalesforceConnection(updated));
    return updated;
  }
}

function flowErrorFromUnknown(error: unknown, redirectAfterConnect: string | null): OAuthFlowError {
  if (error instanceof OAuthGatewayError) {
    return new OAuthFlowError(error.message, {
      code: error.errorCode ?? "oauth_callback_failed",
      redirectAfterConnect,
      statusCode: error.retriable ? 502 : 400,
    });
  }
  return new OAuthFlowError("OAuth callback failed.", {
    code: "oauth_callback_failed",
    redirectAfterConnect,
    statusCode: 500,
  });
}

function isRevokedRefreshTokenError(error: OAuthGatewayError): boolean {
  return error.errorCode === "invalid_grant" || error.errorCode === "invalid_token";
}

function toStoredGoogleState(state: GoogleOAuthState): StoredOAuthStateDocument {
  const payload = toJsonObject({
    ...state,
    created_at: toIso(state.created_at),
    expires_at: toIso(state.expires_at),
  });
  return {
    createdAt: state.created_at ?? new Date(),
    expiresAt: state.expires_at,
    payload,
    slackUserId: state.slack_user_id,
    stateId: state.state_id,
    teamId: state.team_id,
  };
}

function toStoredSalesforceState(state: SalesforceOAuthState): StoredSalesforceOAuthStateDocument {
  const payload = toJsonObject({
    ...state,
    created_at: toIso(state.created_at),
    expires_at: toIso(state.expires_at),
  });
  return {
    createdAt: state.created_at ?? new Date(),
    expiresAt: state.expires_at,
    payload,
    salesforceOrgId: state.salesforce_org_id,
    slackUserId: state.slack_user_id,
    stateId: state.state_id,
    teamId: state.team_id,
  };
}

function toStoredGoogleConnection(
  connection: GoogleAuthConnection,
): StoredGoogleConnectionDocument {
  const payload = toJsonObject(serializeDates(connection));
  return {
    connectionStatus: connection.connection_status,
    googleAccountEmail: connection.google_account_email ?? undefined,
    googleAccountSubject: connection.google_account_subject,
    payload,
    refreshTokenExpiresAt: connection.refresh_token_expires_at ?? undefined,
    slackUserId: connection.slack_user_id,
    teamId: connection.team_id,
    tokenExpiresAt: connection.token_expires_at ?? undefined,
    updatedAt: connection.updated_at,
  };
}

function toStoredSalesforceConnection(
  connection: SalesforceConnection,
): StoredSalesforceConnectionDocument {
  const payload = toJsonObject(serializeDates(connection));
  return {
    connectionStatus: connection.connection_status,
    payload,
    salesforceOrgId: connection.salesforce_org_id,
    salesforceUserId: connection.salesforce_user_id,
    salesforceUsername: connection.salesforce_username ?? undefined,
    slackUserId: connection.slack_user_id,
    teamId: connection.team_id,
    tokenExpiresAt: connection.token_expires_at ?? undefined,
    updatedAt: connection.updated_at,
  };
}

function serializeDates<T>(value: T): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeDates(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeDates(item)]),
    );
  }
  return value;
}
