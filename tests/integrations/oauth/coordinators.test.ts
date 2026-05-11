import { describe, expect, it } from "vite-plus/test";

import { OAuthContextSigner } from "../../../src/integrations/oauth/contextSigner.js";
import {
  GoogleAuthCoordinator,
  SalesforceAuthCoordinator,
} from "../../../src/integrations/oauth/coordinators.js";
import {
  salesforceOAuthStartContextSchema,
  salesforceOAuthStateTokenSchema,
} from "../../../src/integrations/oauth/domain.js";
import { FernetTextCipher } from "../../../src/integrations/oauth/fernet.js";
import type {
  GoogleOAuthGateway,
  SalesforceOAuthGateway,
} from "../../../src/integrations/oauth/gateways.js";
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
    };
    const coordinator = new SalesforceAuthCoordinator({
      contextSigningSecret: "context-secret",
      gateway,
      repository,
      tokenCipher: new FernetTextCipher(fernetKey),
    });
    const contextSigner = new OAuthContextSigner({
      contextSchema: salesforceOAuthStartContextSchema,
      secret: "context-secret",
      stateTokenSchema: salesforceOAuthStateTokenSchema,
    });
    const context = contextSigner.dumps({
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      redirect_after_connect: "/done",
      salesforce_org_id: "00DORG",
      slack_user_id: "U123",
      team_id: "T123",
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
});

class MemoryOAuthRepository {
  readonly googleConnections: GoogleAuthConnectionDocument[] = [];
  readonly googleStates = new Map<string, JsonObject>();
  readonly salesforceConfigs = new Map<string, JsonObject>();
  readonly salesforceConnections: SalesforceConnectionDocument[] = [];
  readonly salesforceStates = new Map<string, JsonObject>();

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

  async findSalesforceConnection(): Promise<JsonObject | undefined> {
    return undefined;
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
