import { describe, expect, it } from "vite-plus/test";

import { FetchSalesforceOAuthGateway } from "../../../src/integrations/oauth/gateways.js";
import type { SalesforceAuthConfig } from "../../../src/integrations/oauth/domain.js";

const salesforceConfig: SalesforceAuthConfig = {
  app_type: "external_client_app",
  created_at: new Date("2026-05-01T00:00:00.000Z"),
  default_scopes: ["api", "refresh_token"],
  oauth_client_id: "salesforce-client",
  redirect_uri: "https://app.example.com/oauth/salesforce/callback",
  salesforce_my_domain_host: "example.my.salesforce.com",
  salesforce_org_id: "00DORG",
  salesforce_org_name: null,
  status: "active",
  team_id: "T123",
  updated_at: new Date("2026-05-01T00:00:00.000Z"),
};

describe("FetchSalesforceOAuthGateway", () => {
  it("uses the Salesforce refresh-token grant against the workspace My Domain", async () => {
    let requestedUrl: string | undefined;
    let requestedBody: URLSearchParams | undefined;
    const gateway = new FetchSalesforceOAuthGateway({
      fetchFn: (async (url, init) => {
        requestedUrl = String(url);
        requestedBody = new URLSearchParams(String(init?.body));
        return Response.json({
          access_token: "salesforce-access-refreshed",
          expires_in: 7200,
          instance_url: "https://example.my.salesforce.com",
          scope: "api refresh_token",
        });
      }) as typeof fetch,
    });

    const tokens = await gateway.refreshAccessToken({
      config: salesforceConfig,
      refreshToken: "salesforce-refresh",
    });

    expect(requestedUrl).toBe("https://example.my.salesforce.com/services/oauth2/token");
    expect(requestedBody?.get("client_id")).toBe("salesforce-client");
    expect(requestedBody?.get("grant_type")).toBe("refresh_token");
    expect(requestedBody?.get("refresh_token")).toBe("salesforce-refresh");
    expect(tokens.access_token).toBe("salesforce-access-refreshed");
    expect(tokens.granted_scopes).toEqual(["api", "refresh_token"]);
  });

  it("posts token revocation and accepts Salesforce's empty success response", async () => {
    let requestedUrl: string | undefined;
    let requestedBody: URLSearchParams | undefined;
    const gateway = new FetchSalesforceOAuthGateway({
      fetchFn: (async (url, init) => {
        requestedUrl = String(url);
        requestedBody = new URLSearchParams(String(init?.body));
        return new Response("", { status: 200 });
      }) as typeof fetch,
    });

    await gateway.revokeToken({ config: salesforceConfig, token: "salesforce-refresh" });

    expect(requestedUrl).toBe("https://example.my.salesforce.com/services/oauth2/revoke");
    expect(requestedBody?.get("token")).toBe("salesforce-refresh");
  });
});
