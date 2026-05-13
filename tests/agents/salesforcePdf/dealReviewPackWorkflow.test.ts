import { describe, expect, it } from "vite-plus/test";

import {
  DealReviewPackWorkflow,
  type DealReviewPackNarrativeGenerator,
  type DealReviewPackSalesforceGateway,
} from "../../../src/agents/salesforcePdf/index.js";
import type { SalesforcePdfWorkflowSettings } from "../../../src/domain/salesforcePdfWorkflows.js";
import { OAuthFlowError } from "../../../src/integrations/oauth/coordinators.js";
import {
  PdfGenerationError,
  createDefaultDealReviewPackTemplate,
  type PdfRenderResult,
} from "../../../src/integrations/pdf/index.js";
import { SalesforceApiError } from "../../../src/integrations/salesforce/index.js";
import type {
  SalesforceApiContext,
  SalesforceContentVersionResult,
  SalesforceQueryResult,
  SalesforceRecord,
} from "../../../src/integrations/salesforce/index.js";

describe("DealReviewPackWorkflow", () => {
  it("generates a Deal Review Pack without AI summary by default", async () => {
    const gateway = new FakeSalesforceGateway([queryResult([opportunityRecord()])]);
    const renderer = new RecordingPdfRenderer();
    const narrative = new RecordingNarrativeGenerator();
    const workflow = workflowWith({ gateway, narrative, renderer });

    const result = await workflow.run({
      opportunityName: "Expansion",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });

    expect(result).toMatchObject({
      mode: "preview",
      ok: true,
      summary: {
        accountName: "Acme",
        id: "006000000000001AAA",
        opportunityName: "Expansion",
        reviewNotes: "Discount requires approval.",
      },
    });
    expect(narrative.calls).toEqual([]);
    expect(renderer.calls[0]).toEqual({
      input: {
        accountName: "Acme",
        amount: "300",
        closeDate: "2026-06-30",
        generatedAt: "2026-05-13T00:00:00.000Z",
        nextStep: "Confirm legal review.",
        opportunityName: "Expansion",
        ownerName: "Sales Owner",
        reviewNotes: "Discount requires approval.",
        sourceRecordId: "006000000000001AAA",
        stageName: "Proposal",
      },
      templateId: "deal_review_pack_v1",
    });
  });

  it("uses AI summary only for narrative notes when enabled", async () => {
    const gateway = new FakeSalesforceGateway([queryResult([opportunityRecord()])]);
    const renderer = new RecordingPdfRenderer();
    const narrative = new RecordingNarrativeGenerator("AI risk summary.");
    const workflow = workflowWith({
      gateway,
      narrative,
      renderer,
      settings: settings({ include_ai_summary: true }),
    });

    await expect(
      workflow.run({
        opportunityId: "006000000000001AAA",
        salesforceOrgId: "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(renderer.calls[0]?.input).toMatchObject({
      opportunityName: "Expansion",
      reviewNotes: "AI risk summary.",
      stageName: "Proposal",
    });
    expect(narrative.calls[0]?.opportunity).toMatchObject({
      opportunityName: "Expansion",
      stageName: "Proposal",
    });
  });

  it("does not run when Deal Review Pack is disabled for the org", async () => {
    const gateway = new FakeSalesforceGateway([]);
    const workflow = workflowWith({ gateway, settings: settings({ enabled: false }) });

    const result = await workflow.run({
      opportunityName: "Expansion",
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

    await expect(
      workflow.run({
        opportunityName: "Expansion",
        salesforceOrgId: "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      }),
    ).resolves.toMatchObject({
      code: "missing_salesforce_connection",
      ok: false,
      reconnectRequired: true,
    });
  });

  it("rejects ambiguous Opportunity name matches", async () => {
    const gateway = new FakeSalesforceGateway([
      queryResult([opportunityRecord(), opportunityRecord({ Id: "006000000000002AAA" })]),
    ]);
    const workflow = workflowWith({ gateway });

    await expect(
      workflow.run({
        opportunityName: "Expansion",
        salesforceOrgId: "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      }),
    ).resolves.toMatchObject({ code: "ambiguous_opportunity", ok: false });
  });

  it("blocks disallowed Opportunity stages", async () => {
    const gateway = new FakeSalesforceGateway([
      queryResult([opportunityRecord({ StageName: "Prospecting" })]),
    ]);
    const workflow = workflowWith({
      gateway,
      settings: settings({ allowed_stages: ["Proposal"] }),
    });

    await expect(
      workflow.run({
        opportunityName: "Expansion",
        salesforceOrgId: "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      }),
    ).resolves.toMatchObject({ code: "disallowed_stage", ok: false });
  });

  it("blocks approval statuses that are not configured as allowed", async () => {
    const gateway = new FakeSalesforceGateway([
      queryResult([opportunityRecord({ Approval_Status__c: "Pending" })]),
    ]);
    const workflow = workflowWith({
      gateway,
      settings: settings({
        allowed_approval_statuses: ["Approved"],
        approval_status_field: "Approval_Status__c",
      }),
    });

    await expect(
      workflow.run({
        opportunityName: "Expansion",
        salesforceOrgId: "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      }),
    ).resolves.toMatchObject({ code: "approval_not_satisfied", ok: false });
  });

  it("lists missing required Salesforce fields", async () => {
    const gateway = new FakeSalesforceGateway([
      queryResult([opportunityRecord({ Account: { Name: "" } })]),
    ]);
    const workflow = workflowWith({
      gateway,
      settings: settings({ required_fields: ["Account.Name"] }),
    });

    await expect(
      workflow.run({
        opportunityName: "Expansion",
        salesforceOrgId: "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      }),
    ).resolves.toMatchObject({
      code: "missing_required_fields",
      missingFields: ["Account.Name"],
      ok: false,
    });
  });

  it("returns render failures without attaching to Salesforce", async () => {
    const gateway = new FakeSalesforceGateway([queryResult([opportunityRecord()])]);
    const renderer = new RecordingPdfRenderer(
      new PdfGenerationError("render failed", { code: "render_failed" }),
    );
    const workflow = workflowWith({ gateway, renderer });

    await expect(
      workflow.run({
        opportunityName: "Expansion",
        salesforceOrgId: "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      }),
    ).resolves.toMatchObject({ code: "render_failed", ok: false });
    expect(gateway.contentVersions).toEqual([]);
  });

  it("re-checks Salesforce state and attaches confirmed packs", async () => {
    const gateway = new FakeSalesforceGateway([
      queryResult([opportunityRecord()]),
      queryResult([opportunityRecord()]),
    ]);
    const workflow = workflowWith({
      gateway,
      settings: settings({ allowed_stages: ["Proposal"] }),
    });

    await expect(
      workflow.run({
        opportunityName: "Expansion",
        salesforceOrgId: "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      workflow.run({
        mode: "attach_confirmed",
        opportunityName: "Expansion",
        salesforceOrgId: "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      }),
    ).resolves.toMatchObject({
      attachment: {
        contentVersionId: "068000000000001AAA",
        targetRecordIds: ["006000000000001AAA"],
      },
      ok: true,
    });
  });

  it("returns attach failures after successful generation", async () => {
    const gateway = new FakeSalesforceGateway(
      [queryResult([opportunityRecord()])],
      new SalesforceApiError("upload failed", { code: "UPLOAD_FAILED", statusCode: 500 }),
    );
    const workflow = workflowWith({ gateway });

    await expect(
      workflow.run({
        mode: "attach_confirmed",
        opportunityName: "Expansion",
        salesforceOrgId: "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      }),
    ).resolves.toMatchObject({ code: "attach_failed", ok: false });
  });

  it("rejects unsupported Deal Review Pack attachment targets", async () => {
    const gateway = new FakeSalesforceGateway([queryResult([opportunityRecord()])]);
    const workflow = workflowWith({ gateway, settings: settings({ attach_to: "quote" }) });

    await expect(
      workflow.run({
        mode: "attach_confirmed",
        opportunityName: "Expansion",
        salesforceOrgId: "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      }),
    ).resolves.toMatchObject({ code: "invalid_attach_target", ok: false });
    expect(gateway.contentVersions).toEqual([]);
  });
});

function workflowWith(input: {
  gateway: FakeSalesforceGateway;
  narrative?: RecordingNarrativeGenerator;
  renderer?: RecordingPdfRenderer;
  settings?: SalesforcePdfWorkflowSettings;
}) {
  return new DealReviewPackWorkflow({
    clock: () => new Date("2026-05-13T00:00:00Z"),
    narrativeGenerator: input.narrative,
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
    action: "deal_review_pack",
    allowed_approval_statuses: [],
    allowed_record_type_ids: [],
    allowed_record_type_names: [],
    allowed_stages: [],
    allowed_statuses: [],
    approval_status_field: null,
    attach_to: "opportunity",
    created_at: now,
    enabled: true,
    enabled_at: now,
    enabled_by_slack_user_id: "UADMIN",
    field_mapping: {},
    include_ai_summary: false,
    record_type_field: null,
    required_fields: [],
    require_confirmation_before_attach: true,
    salesforce_org_id: "00D000000000001AAA",
    slack_channel_allowlist: [],
    slack_user_group_allowlist: [],
    status_field: null,
    stage_field: null,
    team_id: "T1",
    template_id: "deal_review_pack_v1",
    updated_at: now,
    updated_by_slack_user_id: "UADMIN",
    ...input,
  };
}

function opportunityRecord(input: Partial<SalesforceRecord> = {}): SalesforceRecord {
  return {
    Account: { Name: "Acme" },
    Amount: 300,
    CloseDate: "2026-06-30",
    Description: "Discount requires approval.",
    Id: "006000000000001AAA",
    Name: "Expansion",
    NextStep: "Confirm legal review.",
    Owner: { Name: "Sales Owner" },
    RecordType: { Name: "Standard" },
    RecordTypeId: "012000000000001AAA",
    StageName: "Proposal",
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
      template: createDefaultDealReviewPackTemplate(),
    };
  }
}

class RecordingNarrativeGenerator implements DealReviewPackNarrativeGenerator {
  readonly calls: Array<Parameters<DealReviewPackNarrativeGenerator["generate"]>[0]> = [];
  private readonly reviewNotes: string;

  constructor(reviewNotes = "AI summary") {
    this.reviewNotes = reviewNotes;
  }

  async generate(
    input: Parameters<DealReviewPackNarrativeGenerator["generate"]>[0],
  ): Promise<{ reviewNotes: string }> {
    this.calls.push(input);
    return { reviewNotes: this.reviewNotes };
  }
}

class FakeSalesforceGateway implements DealReviewPackSalesforceGateway {
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
  private readonly queryResponses: Array<Error | SalesforceQueryResult>;

  constructor(queryResponses: Array<Error | SalesforceQueryResult>, attachError?: Error) {
    this.attachError = attachError;
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
    this.contentDocumentLinks.push(input);
    return { contentDocumentLinkId: "06A000000000001AAA" };
  }
}
