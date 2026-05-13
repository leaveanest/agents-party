import { describe, expect, it } from "vite-plus/test";

import {
  QuotePdfWorkflow,
  type QuotePdfWorkflowSalesforceGateway,
} from "../../../src/agents/salesforcePdf/index.js";
import type { PdfRenderResult } from "../../../src/integrations/pdf/index.js";
import {
  PdfGenerationError,
  createDefaultQuotePdfTemplate,
} from "../../../src/integrations/pdf/index.js";
import { OAuthFlowError } from "../../../src/integrations/oauth/coordinators.js";
import { SalesforceApiError } from "../../../src/integrations/salesforce/index.js";
import type {
  SalesforceApiContext,
  SalesforceContentVersionResult,
  SalesforceQueryResult,
  SalesforceRecord,
} from "../../../src/integrations/salesforce/index.js";
import type { SalesforcePdfWorkflowSettings } from "../../../src/domain/salesforcePdfWorkflows.js";

describe("QuotePdfWorkflow", () => {
  it("generates a Quote PDF preview from Salesforce Quote data", async () => {
    const gateway = new FakeSalesforceGateway([
      queryResult([quoteRecord()]),
      queryResult([
        {
          Id: "0QL000000000001AAA",
          Product2: { Name: "Product A" },
          Quantity: 2,
          TotalPrice: 200,
        },
      ]),
    ]);
    const renderer = new RecordingPdfRenderer();
    const workflow = workflowWith({ gateway, renderer });

    const result = await workflow.run({
      quoteNumber: "Q-001",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({
      mode: "preview",
      ok: true,
      quote: {
        accountName: "Acme",
        id: "0Q0000000000001AAA",
        opportunityName: "Expansion",
        quoteNumber: "Q-001",
        status: "Approved",
        totalAmount: "300",
      },
    });
    expect(gateway.queries[0]).toContain("FROM Quote WHERE QuoteNumber = 'Q-001' LIMIT 2");
    expect(renderer.calls[0]).toEqual({
      input: {
        accountName: "Acme",
        generatedAt: "2026-05-13T00:00:00.000Z",
        lineItems: [["Product A", "2", "200"]],
        opportunityName: "Expansion",
        quoteName: "Acme Quote",
        quoteNumber: "Q-001",
        sourceRecordId: "0Q0000000000001AAA",
        totalAmount: "300",
      },
      templateId: "quote_v1",
    });
  });

  it("does not run when Quote PDF is disabled for the org", async () => {
    const gateway = new FakeSalesforceGateway([]);
    const workflow = workflowWith({ gateway, settings: settings({ enabled: false }) });

    const result = await workflow.run({
      quoteNumber: "Q-001",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({ code: "disabled", ok: false });
    expect(gateway.queries).toEqual([]);
  });

  it("returns a reconnect instruction when the Salesforce connection is missing", async () => {
    const gateway = new FakeSalesforceGateway([
      new OAuthFlowError("Salesforce connection was not found.", {
        code: "missing_salesforce_connection",
        statusCode: 404,
      }),
    ]);
    const workflow = workflowWith({ gateway });

    const result = await workflow.run({
      quoteNumber: "Q-001",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({
      code: "missing_salesforce_connection",
      ok: false,
      reconnectRequired: true,
    });
  });

  it("rejects unknown workflow modes instead of attaching", async () => {
    const gateway = new FakeSalesforceGateway([]);
    const workflow = workflowWith({ gateway });

    const result = await workflow.run({
      mode: "attach" as never,
      quoteNumber: "Q-001",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({ code: "invalid_request", ok: false });
    expect(gateway.contentVersions).toEqual([]);
  });

  it("rejects ambiguous Quote number matches", async () => {
    const gateway = new FakeSalesforceGateway([
      queryResult([quoteRecord(), quoteRecord({ Id: "0Q0000000000002AAA" })]),
    ]);
    const workflow = workflowWith({ gateway });

    const result = await workflow.run({
      quoteNumber: "Q-001",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({ code: "ambiguous_quote", ok: false });
  });

  it("blocks disallowed Quote statuses", async () => {
    const gateway = new FakeSalesforceGateway([queryResult([quoteRecord({ Status: "Draft" })])]);
    const workflow = workflowWith({
      gateway,
      settings: settings({ allowed_statuses: ["Approved"] }),
    });

    const result = await workflow.run({
      quoteNumber: "Q-001",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({ code: "disallowed_status", ok: false });
  });

  it("blocks disallowed related Opportunity stages", async () => {
    const gateway = new FakeSalesforceGateway([
      queryResult([
        quoteRecord({
          Opportunity: { Account: { Name: "Acme" }, Name: "Expansion", StageName: "Prospecting" },
        }),
      ]),
    ]);
    const workflow = workflowWith({
      gateway,
      settings: settings({ allowed_stages: ["Proposal"] }),
    });

    const result = await workflow.run({
      quoteNumber: "Q-001",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({ code: "disallowed_stage", ok: false });
  });

  it("lists missing required Salesforce fields", async () => {
    const gateway = new FakeSalesforceGateway([
      queryResult([
        quoteRecord({
          Opportunity: { Account: { Name: "" }, Name: "Expansion", StageName: "Proposal" },
        }),
      ]),
    ]);
    const workflow = workflowWith({
      gateway,
      settings: settings({ required_fields: ["Opportunity.Account.Name"] }),
    });

    const result = await workflow.run({
      quoteNumber: "Q-001",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({
      code: "missing_required_fields",
      missingFields: ["Opportunity.Account.Name"],
      ok: false,
    });
  });

  it("returns render failures without attaching to Salesforce", async () => {
    const gateway = new FakeSalesforceGateway([queryResult([quoteRecord()]), queryResult([])]);
    const renderer = new RecordingPdfRenderer(
      new PdfGenerationError("render failed", { code: "render_failed" }),
    );
    const workflow = workflowWith({ gateway, renderer });

    const result = await workflow.run({
      quoteNumber: "Q-001",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({ code: "render_failed", ok: false });
    expect(gateway.contentVersions).toEqual([]);
  });

  it("returns a controlled failure when Quote line items exceed the template limit", async () => {
    const gateway = new FakeSalesforceGateway([
      queryResult([quoteRecord()]),
      queryResult(
        Array.from({ length: 51 }, (_, index) => ({
          Id: `0QL000000000${String(index).padStart(4, "0")}AAA`,
          Product2: { Name: `Product ${index}` },
          Quantity: 1,
          TotalPrice: 100,
        })),
      ),
    ]);
    const workflow = workflowWith({ gateway });

    const result = await workflow.run({
      quoteNumber: "Q-001",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({ code: "too_many_line_items", ok: false });
    expect(gateway.queries[1]).toContain("LIMIT 51");
  });

  it("attaches confirmed Quote PDFs to Salesforce Files and related Opportunity", async () => {
    const gateway = new FakeSalesforceGateway([queryResult([quoteRecord()]), queryResult([])]);
    const workflow = workflowWith({
      gateway,
      settings: settings({ attach_to: "both", require_confirmation_before_attach: true }),
    });

    const result = await workflow.run({
      mode: "attach_confirmed",
      quoteId: "0Q0000000000001AAA",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({
      attachment: {
        contentDocumentId: "069000000000001AAA",
        contentVersionId: "068000000000001AAA",
        targetRecordIds: ["0Q0000000000001AAA", "006000000000001AAA"],
      },
      ok: true,
    });
    expect(gateway.contentVersions[0]).toMatchObject({
      firstPublishLocationId: "0Q0000000000001AAA",
      pathOnClient: "Quote-Q-001.pdf",
      title: "Quote-Q-001",
    });
    expect(gateway.contentDocumentLinks[0]).toMatchObject({
      linkedEntityId: "006000000000001AAA",
    });
  });

  it("re-checks Salesforce state on confirmed attach", async () => {
    const gateway = new FakeSalesforceGateway([
      queryResult([quoteRecord()]),
      queryResult([]),
      queryResult([quoteRecord({ Status: "Draft" })]),
    ]);
    const workflow = workflowWith({
      gateway,
      settings: settings({ allowed_statuses: ["Approved"] }),
    });

    await expect(
      workflow.run({
        quoteNumber: "Q-001",
        salesforceOrgId: "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      workflow.run({
        mode: "attach_confirmed",
        quoteNumber: "Q-001",
        salesforceOrgId: "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      }),
    ).resolves.toMatchObject({ code: "disallowed_status", ok: false });
    expect(gateway.contentVersions).toEqual([]);
  });

  it("returns attach failures after successful generation", async () => {
    const gateway = new FakeSalesforceGateway(
      [queryResult([quoteRecord()]), queryResult([])],
      new SalesforceApiError("upload failed", { code: "UPLOAD_FAILED", statusCode: 500 }),
    );
    const workflow = workflowWith({ gateway });

    const result = await workflow.run({
      mode: "attach_confirmed",
      quoteNumber: "Q-001",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({ code: "attach_failed", ok: false });
  });

  it("reports partial success when an additional Salesforce Files link fails", async () => {
    const gateway = new FakeSalesforceGateway(
      [queryResult([quoteRecord()]), queryResult([])],
      undefined,
      new SalesforceApiError("link failed", { code: "LINK_FAILED", statusCode: 500 }),
    );
    const workflow = workflowWith({
      gateway,
      settings: settings({ attach_to: "both" }),
    });

    const result = await workflow.run({
      mode: "attach_confirmed",
      quoteNumber: "Q-001",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({
      attachment: {
        contentVersionId: "068000000000001AAA",
        targetRecordIds: ["0Q0000000000001AAA"],
      },
      code: "attach_failed",
      ok: false,
      partialSuccess: true,
    });
  });
});

function workflowWith(input: {
  gateway: FakeSalesforceGateway;
  renderer?: RecordingPdfRenderer;
  settings?: SalesforcePdfWorkflowSettings;
}) {
  return new QuotePdfWorkflow({
    clock: () => new Date("2026-05-13T00:00:00Z"),
    pdfRenderer: input.renderer ?? new RecordingPdfRenderer(),
    salesforce: input.gateway,
    settingsRepository: {
      async findSalesforcePdfWorkflowSetting() {
        return input.settings ?? settings();
      },
    },
  });
}

function settings(
  input: Partial<SalesforcePdfWorkflowSettings> = {},
): SalesforcePdfWorkflowSettings {
  const now = new Date("2026-05-13T00:00:00Z");
  return {
    action: "quote_pdf",
    allowed_record_type_ids: [],
    allowed_record_type_names: [],
    allowed_stages: [],
    allowed_statuses: [],
    attach_to: "source_record",
    created_at: now,
    enabled: true,
    enabled_at: now,
    enabled_by_slack_user_id: "UADMIN",
    field_mapping: {},
    record_type_field: null,
    required_fields: [],
    require_confirmation_before_attach: true,
    salesforce_org_id: "00D000000000001AAA",
    slack_channel_allowlist: [],
    slack_user_group_allowlist: [],
    status_field: null,
    stage_field: null,
    team_id: "T1",
    template_id: "quote_v1",
    updated_at: now,
    updated_by_slack_user_id: "UADMIN",
    ...input,
  };
}

function quoteRecord(input: Partial<SalesforceRecord> = {}): SalesforceRecord {
  return {
    GrandTotal: 300,
    Id: "0Q0000000000001AAA",
    Name: "Acme Quote",
    Opportunity: {
      Account: { Name: "Acme" },
      Name: "Expansion",
      StageName: "Proposal",
    },
    OpportunityId: "006000000000001AAA",
    QuoteNumber: "Q-001",
    RecordType: { Name: "Standard" },
    RecordTypeId: "012000000000001AAA",
    Status: "Approved",
    ...input,
  };
}

function queryResult(records: SalesforceRecord[]): SalesforceQueryResult {
  return {
    done: true,
    records,
    totalSize: records.length,
  };
}

class RecordingPdfRenderer {
  readonly calls: Array<{ input: Record<string, unknown>; templateId: string }> = [];
  private readonly error?: Error;

  constructor(error?: Error) {
    this.error = error;
  }

  async render(input: {
    input: Record<string, unknown>;
    templateId: string;
  }): Promise<PdfRenderResult> {
    this.calls.push(input);
    if (this.error !== undefined) {
      throw this.error;
    }
    return {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      template: createDefaultQuotePdfTemplate(),
    };
  }
}

class FakeSalesforceGateway implements QuotePdfWorkflowSalesforceGateway {
  readonly contentDocumentLinks: Array<{
    contentDocumentId: string;
    linkedEntityId: string;
  }> = [];
  readonly contentVersions: Array<{
    firstPublishLocationId?: string;
    pathOnClient: string;
    pdfBytes: Uint8Array;
    title: string;
  }> = [];
  readonly queries: string[] = [];
  private readonly attachError?: Error;
  private readonly linkError?: Error;
  private readonly queryResponses: Array<Error | SalesforceQueryResult>;

  constructor(
    queryResponses: Array<Error | SalesforceQueryResult>,
    attachError?: Error,
    linkError?: Error,
  ) {
    this.attachError = attachError;
    this.linkError = linkError;
    this.queryResponses = queryResponses;
  }

  async query<TRecord extends SalesforceRecord = SalesforceRecord>(
    _context: SalesforceApiContext,
    soql: string,
  ): Promise<SalesforceQueryResult<TRecord>> {
    this.queries.push(soql);
    const response = this.queryResponses.shift();
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      throw new Error("Unexpected Salesforce query.");
    }
    return response as SalesforceQueryResult<TRecord>;
  }

  async createContentVersion(
    _context: SalesforceApiContext,
    input: {
      firstPublishLocationId?: string;
      pathOnClient: string;
      pdfBytes: Uint8Array;
      title: string;
    },
  ): Promise<SalesforceContentVersionResult> {
    if (this.attachError !== undefined) {
      throw this.attachError;
    }
    this.contentVersions.push(input);
    return {
      contentDocumentId: "069000000000001AAA",
      contentVersionId: "068000000000001AAA",
    };
  }

  async createContentDocumentLink(
    _context: SalesforceApiContext,
    input: { contentDocumentId: string; linkedEntityId: string },
  ): Promise<{ contentDocumentLinkId: string }> {
    if (this.linkError !== undefined) {
      throw this.linkError;
    }
    this.contentDocumentLinks.push(input);
    return { contentDocumentLinkId: "06A000000000001AAA" };
  }
}
