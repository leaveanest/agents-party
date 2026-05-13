import { describe, expect, it } from "vite-plus/test";

import { FernetTextCipher } from "../../../src/integrations/oauth/fernet.js";
import { SalesforceRestGateway } from "../../../src/integrations/salesforce/gateway.js";

const cipher = new FernetTextCipher("TogY-XNU4lqwqpU3n8ugin31axgCOj0bvbxNnWb9f0w=");

describe("SalesforceRestGateway", () => {
  it("refreshes the Salesforce connection and runs SOQL queries with the access token", async () => {
    const requests: CapturedRequest[] = [];
    const gateway = new SalesforceRestGateway({
      connectionResolver: resolver(),
      fetchFn: recordingFetch(requests, [
        jsonResponse({
          done: true,
          records: [{ Id: "001000000000001AAA", Name: "Acme" }],
          totalSize: 1,
        }),
      ]),
      tokenCipher: cipher,
    });

    const result = await gateway.query(context(), "select Id, Name from Account");

    expect(result.records).toEqual([{ Id: "001000000000001AAA", Name: "Acme" }]);
    expect(requests[0]?.url).toBe(
      "https://example.my.salesforce.com/services/data/v61.0/query?q=select+Id%2C+Name+from+Account",
    );
    expect(requests[0]?.authorization).toBe("Bearer salesforce-access");
  });

  it("retrieves records with validated object names, ids, and field paths", async () => {
    const requests: CapturedRequest[] = [];
    const gateway = new SalesforceRestGateway({
      connectionResolver: resolver(),
      fetchFn: recordingFetch(requests, [
        jsonResponse({ Account: { Name: "Acme" }, Id: "0Q0000000000001AAA" }),
      ]),
      tokenCipher: cipher,
    });

    await expect(
      gateway.retrieveRecord(context(), {
        fields: ["Id", "Account.Name", "Custom__r.Value__c"],
        objectApiName: "Quote",
        recordId: "0Q0000000000001AAA",
      }),
    ).resolves.toMatchObject({ Id: "0Q0000000000001AAA" });

    expect(requests[0]?.url).toBe(
      "https://example.my.salesforce.com/services/data/v61.0/sobjects/Quote/0Q0000000000001AAA?fields=Id%2CAccount.Name%2CCustom__r.Value__c",
    );
  });

  it("creates ContentVersion records and resolves the ContentDocumentId", async () => {
    const requests: CapturedRequest[] = [];
    let refreshes = 0;
    const gateway = new SalesforceRestGateway({
      connectionResolver: {
        async refreshConnection() {
          refreshes += 1;
          return connection() as never;
        },
      },
      fetchFn: recordingFetch(requests, [
        jsonResponse({ id: "068000000000001AAA", success: true }),
        jsonResponse({ ContentDocumentId: "069000000000001AAA" }),
      ]),
      tokenCipher: cipher,
    });

    await expect(
      gateway.createContentVersion(context(), {
        firstPublishLocationId: "0Q0000000000001AAA",
        pathOnClient: "quote.pdf",
        pdfBytes: new Uint8Array([37, 80, 68, 70]),
        title: "Quote",
      }),
    ).resolves.toEqual({
      contentDocumentId: "069000000000001AAA",
      contentVersionId: "068000000000001AAA",
    });

    expect(requests[0]?.url).toBe(
      "https://example.my.salesforce.com/services/data/v61.0/sobjects/ContentVersion",
    );
    expect(requests[1]?.url).toBe(
      "https://example.my.salesforce.com/services/data/v61.0/sobjects/ContentVersion/068000000000001AAA?fields=ContentDocumentId",
    );
    expect(refreshes).toBe(1);
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      FirstPublishLocationId: "0Q0000000000001AAA",
      PathOnClient: "quote.pdf",
      Title: "Quote",
      VersionData: "JVBERg==",
    });
  });

  it("creates ContentDocumentLink records for additional Salesforce record links", async () => {
    const requests: CapturedRequest[] = [];
    const gateway = new SalesforceRestGateway({
      connectionResolver: resolver(),
      fetchFn: recordingFetch(requests, [
        jsonResponse({ id: "06A000000000001AAA", success: true }),
      ]),
      tokenCipher: cipher,
    });

    await expect(
      gateway.createContentDocumentLink(context(), {
        contentDocumentId: "069000000000001AAA",
        linkedEntityId: "006000000000001AAA",
      }),
    ).resolves.toEqual({ contentDocumentLinkId: "06A000000000001AAA" });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      ContentDocumentId: "069000000000001AAA",
      LinkedEntityId: "006000000000001AAA",
      ShareType: "V",
      Visibility: "AllUsers",
    });
  });

  it("rejects untrusted Salesforce instance URLs before making API requests", async () => {
    const gateway = new SalesforceRestGateway({
      connectionResolver: resolver({ salesforce_instance_url: "https://attacker.example.com" }),
      fetchFn: async () => {
        throw new Error("fetch should not be called");
      },
      tokenCipher: cipher,
    });

    await expect(gateway.query(context(), "select Id from Account")).rejects.toMatchObject({
      code: "invalid_instance_url",
    });
  });

  it("rejects Salesforce instance URLs with embedded credentials", async () => {
    const gateway = new SalesforceRestGateway({
      connectionResolver: resolver({
        salesforce_instance_url: "https://user:pass@example.my.salesforce.com",
      }),
      fetchFn: async () => {
        throw new Error("fetch should not be called");
      },
      tokenCipher: cipher,
    });

    await expect(gateway.query(context(), "select Id from Account")).rejects.toMatchObject({
      code: "invalid_instance_url",
    });
  });

  it("surfaces Salesforce API error codes without leaking tokens", async () => {
    const gateway = new SalesforceRestGateway({
      connectionResolver: resolver(),
      fetchFn: recordingFetch(
        [],
        [jsonResponse([{ errorCode: "INVALID_FIELD", message: "No such field." }], 400)],
      ),
      tokenCipher: cipher,
    });

    await expect(gateway.query(context(), "select Missing__c from Account")).rejects.toMatchObject({
      code: "INVALID_FIELD",
      message: "No such field.",
      statusCode: 400,
    });
  });

  it("wraps network failures in typed retriable Salesforce API errors", async () => {
    const gateway = new SalesforceRestGateway({
      connectionResolver: resolver(),
      fetchFn: async () => {
        throw new TypeError("network failed");
      },
      tokenCipher: cipher,
    });

    await expect(gateway.query(context(), "select Id from Account")).rejects.toMatchObject({
      code: "salesforce_network_error",
      retriable: true,
      statusCode: 502,
    });
  });

  it("wraps invalid JSON success responses in typed Salesforce API errors", async () => {
    const gateway = new SalesforceRestGateway({
      connectionResolver: resolver(),
      fetchFn: recordingFetch(
        [],
        [
          new Response("not json", {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        ],
      ),
      tokenCipher: cipher,
    });

    await expect(gateway.query(context(), "select Id from Account")).rejects.toMatchObject({
      code: "invalid_json_response",
      statusCode: 502,
    });
  });
});

type CapturedRequest = {
  authorization?: string;
  body?: string;
  method?: string;
  url: string;
};

function context() {
  return {
    salesforceOrgId: "00D000000000001AAA",
    slackUserId: "U1",
    teamId: "T1",
  };
}

function resolver(overrides: Record<string, unknown> = {}) {
  return {
    async refreshConnection() {
      return connection(overrides) as never;
    },
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    access_token_encrypted: cipher.encrypt("salesforce-access"),
    connection_status: "active",
    salesforce_instance_url: "https://example.my.salesforce.com",
    ...overrides,
  };
}

function recordingFetch(requests: CapturedRequest[], responses: Response[]): typeof fetch {
  return async (input, init) => {
    requests.push({
      authorization: headerValue(init?.headers, "authorization"),
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url: input.toString(),
    });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error("No response queued.");
    }
    return response;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function headerValue(headers: RequestInit["headers"] | undefined, key: string): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(key) ?? undefined;
  }
  if (Array.isArray(headers)) {
    return headers.find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  }
  const value = headers[key];
  return typeof value === "string" ? value : undefined;
}
