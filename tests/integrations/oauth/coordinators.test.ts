import { describe, expect, it } from "vite-plus/test";

import {
  GoogleAuthCoordinator,
  SalesforceAuthCoordinator,
} from "../../../src/integrations/oauth/coordinators.js";
import { salesforceAuthConfigSchema } from "../../../src/integrations/oauth/domain.js";
import { FernetTextCipher } from "../../../src/integrations/oauth/fernet.js";
import type {
  GoogleOAuthGateway,
  SalesforceOAuthGateway,
} from "../../../src/integrations/oauth/gateways.js";
import { OAuthGatewayError } from "../../../src/integrations/oauth/gateways.js";
import type {
  GoogleAuthConnectionDocument,
  OAuthStateDocument,
  SalesforceConnectionDocument,
  SalesforceOAuthStateDocument,
} from "../../../src/infrastructure/postgres/appRepositories.js";
import type { JsonObject } from "../../../src/infrastructure/postgres/jsonDocumentRepository.js";

const fernetKey = "TogY-XNU4lqwqpU3n8ugin31axgCOj0bvbxNnWb9f0w=";

describe("GoogleAuthCoordinator", () => {
  it("creates state and persists a repository-backed connection on callback", async () => {
    const repository = new MemoryOAuthRepository();
    const gateway: GoogleOAuthGateway = {
      buildAuthorizationUrl(input) {
        return `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(input.stateId)}`;
      },
      async exchangeCode() {
        return {
          access_token: "google-access",
          expires_at: new Date("2099-01-01T00:00:00.000Z"),
          granted_scopes: ["openid"],
          id_token: "id-token",
          refresh_token: "google-refresh",
        };
      },
      async verifyIdToken() {
        return {
          email: "user@example.com",
          email_verified: true,
          subject: "google-subject",
        };
      },
    };
    const coordinator = new GoogleAuthCoordinator({
      contextSigningSecret: "context-secret",
      gateway,
      redirectUri: "https://app.example.com/oauth/google/callback",
      repository,
      tokenCipher: new FernetTextCipher(fernetKey),
    });

    const authUrl = await coordinator.beginAuthorization(
      coordinator.issueStartContext({
        redirectAfterConnect: "/done",
        slackUserId: "U123",
        teamId: "T123",
      }),
    );
    const state = new URL(authUrl).searchParams.get("state");
    const result = await coordinator.handleCallback({ code: "code", stateId: state });

    expect(result.redirectAfterConnect).toBe("/done");
    expect(repository.googleConnections[0]?.payload).toMatchObject({
      connection_status: "active",
      google_account_subject: "google-subject",
      slack_user_id: "U123",
      team_id: "T123",
    });
  });
});

describe("SalesforceAuthCoordinator", () => {
  it("uses workspace config, PKCE state, and persists the connected user", async () => {
    const repository = new MemoryOAuthRepository();
    repository.salesforceConfigs.set("T123:00DORG", {
      default_scopes: ["api", "refresh_token"],
      oauth_client_id: "salesforce-client",
      redirect_uri: "https://app.example.com/oauth/salesforce/callback",
      salesforce_my_domain_host: "example.my.salesforce.com",
      salesforce_org_id: "00DORG",
      status: "active",
      team_id: "T123",
    });
    const gateway: SalesforceOAuthGateway = {
      buildAuthorizationUrl(input) {
        return `https://${input.config.salesforce_my_domain_host}/services/oauth2/authorize?state=${encodeURIComponent(
          input.stateId,
        )}&code_challenge=${input.codeChallenge}`;
      },
      async exchangeCode() {
        return {
          access_token: "salesforce-access",
          granted_scopes: ["api"],
          identity_url: "https://example.my.salesforce.com/id/00DORG/005USER",
          instance_url: "https://example.my.salesforce.com",
          refresh_token: "salesforce-refresh",
        };
      },
      async lookupIdentity() {
        return {
          email: "sf@example.com",
          identity_url: "https://example.my.salesforce.com/id/00DORG/005USER",
          organization_id: "00DORG",
          user_id: "005USER",
          username: "sf@example.com",
        };
      },
      async refreshAccessToken() {
        throw new Error("Unexpected refresh.");
      },
      async revokeToken() {
        throw new Error("Unexpected revoke.");
      },
    };
    const coordinator = new SalesforceAuthCoordinator({
      contextSigningSecret: "context-secret",
      gateway,
      repository,
      tokenCipher: new FernetTextCipher(fernetKey),
    });
    const context = coordinator.issueStartContext({
      redirectAfterConnect: "/done",
      salesforceOrgId: "00DORG",
      slackUserId: "U123",
      teamId: "T123",
    });

    const authUrl = await coordinator.beginAuthorization(context);
    const state = new URL(authUrl).searchParams.get("state");
    const result = await coordinator.handleCallback({ code: "code", stateId: state });

    expect(result.redirectAfterConnect).toBe("/done");
    expect(repository.salesforceConnections[0]?.payload).toMatchObject({
      connection_status: "active",
      salesforce_org_id: "00DORG",
      salesforce_user_id: "005USER",
      slack_user_id: "U123",
      team_id: "T123",
    });
  });

  it("rejects non-Salesforce hosts in workspace config", () => {
    expect(() =>
      salesforceAuthConfigSchema.parse({
        oauth_client_id: "salesforce-client",
        redirect_uri: "https://app.example.com/oauth/salesforce/callback",
        salesforce_my_domain_host: "example.com",
        salesforce_org_id: "00DORG",
        status: "active",
        team_id: "T123",
      }),
    ).toThrow();
  });

  it("refreshes a stored Salesforce connection with its encrypted refresh token", async () => {
    const repository = new MemoryOAuthRepository();
    const tokenCipher = new FernetTextCipher(fernetKey);
    repository.addSalesforceConfig();
    repository.addSalesforceConnection(tokenCipher);
    let receivedRefreshToken: string | undefined;
    const gateway: SalesforceOAuthGateway = {
      buildAuthorizationUrl() {
        throw new Error("Unexpected authorization.");
      },
      async exchangeCode() {
        throw new Error("Unexpected code exchange.");
      },
      async lookupIdentity() {
        throw new Error("Unexpected identity lookup.");
      },
      async refreshAccessToken(input) {
        receivedRefreshToken = input.refreshToken;
        return {
          access_token: "salesforce-access-refreshed",
          expires_at: new Date("2099-02-01T00:00:00.000Z"),
          granted_scopes: ["api", "refresh_token"],
        };
      },
      async revokeToken() {
        throw new Error("Unexpected revoke.");
      },
    };
    const coordinator = new SalesforceAuthCoordinator({
      contextSigningSecret: "context-secret",
      gateway,
      repository,
      tokenCipher,
    });

    const connection = await coordinator.refreshConnection({
      salesforceOrgId: "00DORG",
      slackUserId: "U123",
      teamId: "T123",
    });

    expect(receivedRefreshToken).toBe("salesforce-refresh");
    expect(tokenCipher.decrypt(connection.access_token_encrypted)).toBe(
      "salesforce-access-refreshed",
    );
    expect(connection.connection_status).toBe("active");
    expect(connection.last_refresh_error_code).toBeNull();
    expect(repository.salesforceConnections.at(-1)?.payload).toMatchObject({
      connection_status: "active",
      token_expires_at: "2099-02-01T00:00:00.000Z",
    });
  });

  it("marks a Salesforce connection expired when refresh token is revoked", async () => {
    const repository = new MemoryOAuthRepository();
    const tokenCipher = new FernetTextCipher(fernetKey);
    repository.addSalesforceConfig();
    repository.addSalesforceConnection(tokenCipher);
    const gateway: SalesforceOAuthGateway = {
      buildAuthorizationUrl() {
        throw new Error("Unexpected authorization.");
      },
      async exchangeCode() {
        throw new Error("Unexpected code exchange.");
      },
      async lookupIdentity() {
        throw new Error("Unexpected identity lookup.");
      },
      async refreshAccessToken() {
        throw new OAuthGatewayError("invalid grant", { errorCode: "invalid_grant" });
      },
      async revokeToken() {
        throw new Error("Unexpected revoke.");
      },
    };
    const coordinator = new SalesforceAuthCoordinator({
      contextSigningSecret: "context-secret",
      gateway,
      repository,
      tokenCipher,
    });

    await expect(
      coordinator.refreshConnection({
        salesforceOrgId: "00DORG",
        slackUserId: "U123",
        teamId: "T123",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant", statusCode: 401 });
    expect(repository.salesforceConnections.at(-1)?.payload).toMatchObject({
      connection_status: "expired",
      last_refresh_error_code: "invalid_grant",
    });
  });

  it("revokes the Salesforce refresh token and marks the connection revoked", async () => {
    const repository = new MemoryOAuthRepository();
    const tokenCipher = new FernetTextCipher(fernetKey);
    repository.addSalesforceConfig();
    repository.addSalesforceConnection(tokenCipher);
    let revokedToken: string | undefined;
    const gateway: SalesforceOAuthGateway = {
      buildAuthorizationUrl() {
        throw new Error("Unexpected authorization.");
      },
      async exchangeCode() {
        throw new Error("Unexpected code exchange.");
      },
      async lookupIdentity() {
        throw new Error("Unexpected identity lookup.");
      },
      async refreshAccessToken() {
        throw new Error("Unexpected refresh.");
      },
      async revokeToken(input) {
        revokedToken = input.token;
      },
    };
    const coordinator = new SalesforceAuthCoordinator({
      contextSigningSecret: "context-secret",
      gateway,
      repository,
      tokenCipher,
    });

    const connection = await coordinator.disconnectByContext(
      coordinator.issueDisconnectContext({
        salesforceOrgId: "00DORG",
        slackUserId: "U123",
        teamId: "T123",
      }),
    );

    expect(revokedToken).toBe("salesforce-refresh");
    expect(connection.connection_status).toBe("revoked");
    expect(repository.salesforceConnections.at(-1)?.payload).toMatchObject({
      connection_status: "revoked",
      last_refresh_error_code: null,
    });
  });

  it("does not allow a Salesforce start context to disconnect a connection", async () => {
    const repository = new MemoryOAuthRepository();
    const tokenCipher = new FernetTextCipher(fernetKey);
    repository.addSalesforceConfig();
    repository.addSalesforceConnection(tokenCipher);
    const gateway: SalesforceOAuthGateway = {
      buildAuthorizationUrl() {
        throw new Error("Unexpected authorization.");
      },
      async exchangeCode() {
        throw new Error("Unexpected code exchange.");
      },
      async lookupIdentity() {
        throw new Error("Unexpected identity lookup.");
      },
      async refreshAccessToken() {
        throw new Error("Unexpected refresh.");
      },
      async revokeToken() {
        throw new Error("Unexpected revoke.");
      },
    };
    const coordinator = new SalesforceAuthCoordinator({
      contextSigningSecret: "context-secret",
      gateway,
      repository,
      tokenCipher,
    });

    await expect(
      coordinator.disconnectByContext(
        coordinator.issueStartContext({
          salesforceOrgId: "00DORG",
          slackUserId: "U123",
          teamId: "T123",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_context_action", statusCode: 400 });
  });

  it("keeps a Salesforce disconnect failure visible on the connection", async () => {
    const repository = new MemoryOAuthRepository();
    const tokenCipher = new FernetTextCipher(fernetKey);
    repository.addSalesforceConfig();
    repository.addSalesforceConnection(tokenCipher);
    const gateway: SalesforceOAuthGateway = {
      buildAuthorizationUrl() {
        throw new Error("Unexpected authorization.");
      },
      async exchangeCode() {
        throw new Error("Unexpected code exchange.");
      },
      async lookupIdentity() {
        throw new Error("Unexpected identity lookup.");
      },
      async refreshAccessToken() {
        throw new Error("Unexpected refresh.");
      },
      async revokeToken() {
        throw new OAuthGatewayError("invalid token", { errorCode: "invalid_token" });
      },
    };
    const coordinator = new SalesforceAuthCoordinator({
      contextSigningSecret: "context-secret",
      gateway,
      repository,
      tokenCipher,
    });

    await expect(
      coordinator.disconnectConnection({
        salesforceOrgId: "00DORG",
        slackUserId: "U123",
        teamId: "T123",
      }),
    ).rejects.toMatchObject({ code: "invalid_token", statusCode: 400 });
    expect(repository.salesforceConnections.at(-1)?.payload).toMatchObject({
      connection_status: "error",
      last_refresh_error_code: "invalid_token",
    });
  });
});

class MemoryOAuthRepository {
  readonly googleConnections: GoogleAuthConnectionDocument[] = [];
  readonly googleStates = new Map<string, JsonObject>();
  readonly salesforceConfigs = new Map<string, JsonObject>();
  readonly salesforceConnections: SalesforceConnectionDocument[] = [];
  readonly salesforceStates = new Map<string, JsonObject>();

  addSalesforceConfig(): void {
    this.salesforceConfigs.set("T123:00DORG", {
      default_scopes: ["api", "refresh_token"],
      oauth_client_id: "salesforce-client",
      redirect_uri: "https://app.example.com/oauth/salesforce/callback",
      salesforce_my_domain_host: "example.my.salesforce.com",
      salesforce_org_id: "00DORG",
      status: "active",
      team_id: "T123",
    });
  }

  addSalesforceConnection(tokenCipher: FernetTextCipher): void {
    this.salesforceConnections.push({
      connectionStatus: "active",
      payload: {
        access_token_encrypted: tokenCipher.encrypt("salesforce-access"),
        connection_status: "active",
        created_at: "2026-05-01T00:00:00.000Z",
        granted_scopes: ["api"],
        last_refresh_error_at: null,
        last_refresh_error_code: null,
        last_refreshed_at: null,
        last_successful_access_at: "2026-05-01T00:00:00.000Z",
        refresh_token_encrypted: tokenCipher.encrypt("salesforce-refresh"),
        salesforce_identity_url: "https://example.my.salesforce.com/id/00DORG/005USER",
        salesforce_instance_url: "https://example.my.salesforce.com",
        salesforce_org_id: "00DORG",
        salesforce_user_email: "sf@example.com",
        salesforce_user_id: "005USER",
        salesforce_username: "sf@example.com",
        slack_user_id: "U123",
        team_id: "T123",
        token_expires_at: "2026-05-01T01:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      },
      salesforceOrgId: "00DORG",
      salesforceUserId: "005USER",
      salesforceUsername: "sf@example.com",
      slackUserId: "U123",
      teamId: "T123",
      tokenExpiresAt: new Date("2026-05-01T01:00:00.000Z"),
      updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    });
  }

  async consumeGoogleOAuthState(teamId: string, stateId: string): Promise<JsonObject | undefined> {
    return consume(this.googleStates, `${teamId}:${stateId}`);
  }

  async consumeSalesforceOAuthState(
    teamId: string,
    stateId: string,
  ): Promise<JsonObject | undefined> {
    return consume(this.salesforceStates, `${teamId}:${stateId}`);
  }

  async findGoogleConnection(): Promise<JsonObject | undefined> {
    return undefined;
  }

  async findSalesforceAuthConfig(
    teamId: string,
    salesforceOrgId: string,
  ): Promise<JsonObject | undefined> {
    return this.salesforceConfigs.get(`${teamId}:${salesforceOrgId}`);
  }

  async findSalesforceConnection(
    teamId: string,
    slackUserId: string,
    salesforceOrgId: string,
  ): Promise<JsonObject | undefined> {
    return this.salesforceConnections
      .toReversed()
      .find(
        (connection) =>
          connection.teamId === teamId &&
          connection.slackUserId === slackUserId &&
          connection.salesforceOrgId === salesforceOrgId,
      )?.payload;
  }

  async saveGoogleConnection(document: GoogleAuthConnectionDocument): Promise<void> {
    this.googleConnections.push(document);
  }

  async saveGoogleOAuthState(document: OAuthStateDocument): Promise<void> {
    this.googleStates.set(`${document.teamId}:${document.stateId}`, document.payload);
  }

  async saveSalesforceConnection(document: SalesforceConnectionDocument): Promise<void> {
    this.salesforceConnections.push(document);
  }

  async saveSalesforceOAuthState(document: SalesforceOAuthStateDocument): Promise<void> {
    this.salesforceStates.set(`${document.teamId}:${document.stateId}`, document.payload);
  }
}

function consume(store: Map<string, JsonObject>, key: string): JsonObject | undefined {
  const value = store.get(key);
  store.delete(key);
  return value;
}
