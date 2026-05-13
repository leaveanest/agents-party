import type { JsonValue } from "../../domain/messageHistory.js";
import type { SalesforceConnection } from "../oauth/domain.js";
import { isSalesforceHost } from "../oauth/domain.js";
import type { FernetTextCipher } from "../oauth/fernet.js";

const DEFAULT_API_VERSION = "v61.0";

export type SalesforceApiConnectionResolver = {
  refreshConnection(input: {
    salesforceOrgId: string;
    slackUserId: string;
    teamId: string;
  }): Promise<SalesforceConnection>;
};

export type SalesforceApiContext = {
  salesforceOrgId: string;
  slackUserId: string;
  teamId: string;
};

export type SalesforceRecord = {
  [key: string]: JsonValue;
};

export type SalesforceQueryResult<TRecord extends SalesforceRecord = SalesforceRecord> = {
  done: boolean;
  nextRecordsUrl?: string;
  records: TRecord[];
  totalSize: number;
};

export type SalesforceContentVersionResult = {
  contentDocumentId?: string;
  contentVersionId: string;
};

export class SalesforceApiError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly statusCode: number;

  constructor(
    message: string,
    options: { code: string; retriable?: boolean; statusCode?: number },
  ) {
    super(message);
    this.name = "SalesforceApiError";
    this.code = options.code;
    this.retriable = options.retriable ?? false;
    this.statusCode = options.statusCode ?? 500;
  }
}

export class SalesforceRestGateway {
  private readonly apiVersion: string;
  private readonly connectionResolver: SalesforceApiConnectionResolver;
  private readonly fetchFn: typeof fetch;
  private readonly tokenCipher: FernetTextCipher;

  constructor(input: {
    apiVersion?: string;
    connectionResolver: SalesforceApiConnectionResolver;
    fetchFn?: typeof fetch;
    tokenCipher: FernetTextCipher;
  }) {
    this.apiVersion = input.apiVersion ?? DEFAULT_API_VERSION;
    this.connectionResolver = input.connectionResolver;
    this.fetchFn = input.fetchFn ?? fetch;
    this.tokenCipher = input.tokenCipher;
  }

  async query<TRecord extends SalesforceRecord = SalesforceRecord>(
    context: SalesforceApiContext,
    soql: string,
  ): Promise<SalesforceQueryResult<TRecord>> {
    const normalizedSoql = soql.trim();
    if (normalizedSoql === "") {
      throw new SalesforceApiError("SOQL query is required.", {
        code: "invalid_soql",
        statusCode: 400,
      });
    }
    const client = await this.resolveClient(context);
    const url = client.url(`/query`);
    url.searchParams.set("q", normalizedSoql);
    const payload = await this.requestJson(client, url, { method: "GET" });
    return parseQueryResult<TRecord>(payload);
  }

  async retrieveRecord<TRecord extends SalesforceRecord = SalesforceRecord>(
    context: SalesforceApiContext,
    input: {
      fields?: readonly string[];
      objectApiName: string;
      recordId: string;
    },
  ): Promise<TRecord> {
    validateObjectApiName(input.objectApiName);
    validateSalesforceRecordId(input.recordId);
    for (const field of input.fields ?? []) {
      validateFieldPath(field);
    }
    const client = await this.resolveClient(context);
    const url = client.url(`/sobjects/${input.objectApiName}/${input.recordId}`);
    if (input.fields !== undefined && input.fields.length > 0) {
      url.searchParams.set("fields", input.fields.join(","));
    }
    const payload = await this.requestJson(client, url, { method: "GET" });
    return parseRecord<TRecord>(payload);
  }

  async createContentVersion(
    context: SalesforceApiContext,
    input: {
      firstPublishLocationId?: string;
      pathOnClient: string;
      pdfBytes: Uint8Array;
      title: string;
    },
  ): Promise<SalesforceContentVersionResult> {
    const title = input.title.trim();
    const pathOnClient = input.pathOnClient.trim();
    if (title === "" || pathOnClient === "") {
      throw new SalesforceApiError("PDF title and path are required.", {
        code: "invalid_file_metadata",
        statusCode: 400,
      });
    }
    if (!pathOnClient.toLocaleLowerCase().endsWith(".pdf")) {
      throw new SalesforceApiError("Salesforce PDF uploads require a .pdf path.", {
        code: "invalid_file_path",
        statusCode: 400,
      });
    }
    if (input.firstPublishLocationId !== undefined) {
      validateSalesforceRecordId(input.firstPublishLocationId);
    }
    const client = await this.resolveClient(context);
    const payload = await this.requestJson(client, client.url("/sobjects/ContentVersion"), {
      body: JSON.stringify({
        ...(input.firstPublishLocationId === undefined
          ? {}
          : { FirstPublishLocationId: input.firstPublishLocationId }),
        PathOnClient: pathOnClient,
        Title: title,
        VersionData: Buffer.from(input.pdfBytes).toString("base64"),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const contentVersionId = parseCreatedId(payload, "ContentVersion");
    const contentVersionUrl = client.url(`/sobjects/ContentVersion/${contentVersionId}`);
    contentVersionUrl.searchParams.set("fields", "ContentDocumentId");
    const contentVersion = parseRecord<{ ContentDocumentId?: JsonValue }>(
      await this.requestJson(client, contentVersionUrl, { method: "GET" }),
    );
    const contentDocumentId = contentVersion.ContentDocumentId;
    return {
      contentDocumentId: typeof contentDocumentId === "string" ? contentDocumentId : undefined,
      contentVersionId,
    };
  }

  async createContentDocumentLink(
    context: SalesforceApiContext,
    input: {
      contentDocumentId: string;
      linkedEntityId: string;
      shareType?: "C" | "I" | "V";
      visibility?: "AllUsers" | "InternalUsers" | "SharedUsers";
    },
  ): Promise<{ contentDocumentLinkId: string }> {
    validateSalesforceRecordId(input.contentDocumentId);
    validateSalesforceRecordId(input.linkedEntityId);
    const client = await this.resolveClient(context);
    const payload = await this.requestJson(client, client.url("/sobjects/ContentDocumentLink"), {
      body: JSON.stringify({
        ContentDocumentId: input.contentDocumentId,
        LinkedEntityId: input.linkedEntityId,
        ShareType: input.shareType ?? "V",
        Visibility: input.visibility ?? "AllUsers",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return { contentDocumentLinkId: parseCreatedId(payload, "ContentDocumentLink") };
  }

  private async resolveClient(context: SalesforceApiContext): Promise<SalesforceApiClient> {
    const connection = await this.connectionResolver.refreshConnection(context);
    const instanceUrl = normalizeSalesforceInstanceUrl(connection.salesforce_instance_url);
    let accessToken: string;
    try {
      accessToken = this.tokenCipher.decrypt(connection.access_token_encrypted);
    } catch {
      throw new SalesforceApiError("Salesforce access token could not be decrypted.", {
        code: "access_token_decrypt_failed",
        statusCode: 500,
      });
    }
    return new SalesforceApiClient({
      accessToken,
      apiVersion: this.apiVersion,
      instanceUrl,
    });
  }

  private async requestJson(
    client: SalesforceApiClient,
    url: URL,
    init: RequestInit,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        ...init,
        headers: {
          authorization: `Bearer ${client.accessToken}`,
          ...init.headers,
        },
      });
    } catch {
      throw new SalesforceApiError("Salesforce API request failed before receiving a response.", {
        code: "salesforce_network_error",
        retriable: true,
        statusCode: 502,
      });
    }
    if (!response.ok) {
      throw await apiErrorFromResponse(response);
    }
    if (response.status === 204) {
      return {};
    }
    try {
      return await response.json();
    } catch {
      throw new SalesforceApiError("Salesforce API response was not valid JSON.", {
        code: "invalid_json_response",
        statusCode: 502,
      });
    }
  }
}

class SalesforceApiClient {
  readonly accessToken: string;
  private readonly apiBaseUrl: URL;

  constructor(input: { accessToken: string; apiVersion: string; instanceUrl: URL }) {
    this.accessToken = input.accessToken;
    this.apiBaseUrl = new URL(`/services/data/${input.apiVersion}`, input.instanceUrl);
  }

  url(path: string): URL {
    return new URL(`${this.apiBaseUrl.pathname}${path}`, this.apiBaseUrl);
  }
}

function normalizeSalesforceInstanceUrl(value: string | undefined): URL {
  if (value === undefined) {
    throw new SalesforceApiError("Salesforce connection does not include an instance URL.", {
      code: "missing_instance_url",
      statusCode: 400,
    });
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !isSalesforceHost(url.hostname)
  ) {
    throw new SalesforceApiError("Salesforce instance URL is not trusted.", {
      code: "invalid_instance_url",
      statusCode: 400,
    });
  }
  return url;
}

function parseQueryResult<TRecord extends SalesforceRecord>(
  payload: unknown,
): SalesforceQueryResult<TRecord> {
  if (!isRecord(payload) || !Array.isArray(payload.records)) {
    throw new SalesforceApiError("Salesforce query response was invalid.", {
      code: "invalid_query_response",
      statusCode: 502,
    });
  }
  return {
    done: payload.done === true,
    nextRecordsUrl: typeof payload.nextRecordsUrl === "string" ? payload.nextRecordsUrl : undefined,
    records: payload.records.map(parseRecord<TRecord>),
    totalSize: typeof payload.totalSize === "number" ? payload.totalSize : payload.records.length,
  };
}

function parseRecord<TRecord extends SalesforceRecord>(payload: unknown): TRecord {
  if (!isRecord(payload)) {
    throw new SalesforceApiError("Salesforce record response was invalid.", {
      code: "invalid_record_response",
      statusCode: 502,
    });
  }
  return payload as TRecord;
}

function parseCreatedId(payload: unknown, objectName: string): string {
  if (!isRecord(payload) || payload.success !== true || typeof payload.id !== "string") {
    throw new SalesforceApiError(`${objectName} create response was invalid.`, {
      code: "invalid_create_response",
      statusCode: 502,
    });
  }
  validateSalesforceRecordId(payload.id);
  return payload.id;
}

async function apiErrorFromResponse(response: Response): Promise<SalesforceApiError> {
  let errorCode: string | undefined;
  let message = `Salesforce API request failed with status ${response.status}.`;
  try {
    const payload = (await response.json()) as unknown;
    const firstError = Array.isArray(payload) ? payload[0] : payload;
    if (isRecord(firstError)) {
      if (typeof firstError.errorCode === "string") {
        errorCode = firstError.errorCode;
      }
      if (typeof firstError.message === "string") {
        message = firstError.message;
      }
    }
  } catch {
    // Keep the generic status-based message when Salesforce did not return JSON.
  }
  return new SalesforceApiError(message, {
    code: errorCode ?? "salesforce_api_error",
    retriable: response.status >= 500 || response.status === 429,
    statusCode: response.status,
  });
}

function validateObjectApiName(value: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:__c)?$/u.test(value)) {
    throw new SalesforceApiError("Salesforce object API name is invalid.", {
      code: "invalid_object_api_name",
      statusCode: 400,
    });
  }
}

function validateFieldPath(value: string): void {
  if (
    !/^[A-Za-z][A-Za-z0-9_]*(?:__(?:c|r))?(?:\.[A-Za-z][A-Za-z0-9_]*(?:__(?:c|r))?)*$/u.test(value)
  ) {
    throw new SalesforceApiError("Salesforce field path is invalid.", {
      code: "invalid_field_path",
      statusCode: 400,
    });
  }
}

function validateSalesforceRecordId(value: string): void {
  if (!/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u.test(value)) {
    throw new SalesforceApiError("Salesforce record id is invalid.", {
      code: "invalid_record_id",
      statusCode: 400,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
