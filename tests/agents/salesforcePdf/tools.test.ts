import { describe, expect, it } from "vite-plus/test";

import {
  createSalesforcePdfAgentTools,
  type DealReviewPackWorkflowInput,
  type DealReviewPackResult,
  type QuotePdfWorkflowInput,
  type QuotePdfWorkflowResult,
} from "../../../src/agents/salesforcePdf/index.js";
import { AgentToolRegistry } from "../../../src/agents/toolContracts.js";

describe("Salesforce PDF agent tools", () => {
  it("exposes typed tool definitions for the AI SDK path", () => {
    const registry = registryWith();

    expect(registry.definitions()).toEqual([
      expect.objectContaining({ name: "create_quote_pdf" }),
      expect.objectContaining({ name: "create_deal_review_pack" }),
    ]);
  });

  it("rejects invalid Quote PDF tool inputs through the registry", async () => {
    const registry = registryWith();

    await expect(
      registry.execute({
        input: { salesforceOrgId: "00D000000000001AAA" },
        toolCallId: "call-1",
        toolName: "create_quote_pdf",
      }),
    ).rejects.toThrow("Invalid input for agent tool 'create_quote_pdf'");
  });

  it("asks for Salesforce org clarification before running workflows", async () => {
    const quoteWorkflow = new FakeQuoteWorkflow(successQuotePreview());
    const registry = registryWith({ quoteWorkflow, salesforceOrgId: undefined });

    await expect(
      registry.execute({
        input: { quoteIdentifier: "Q-001" },
        toolCallId: "call-1",
        toolName: "create_quote_pdf",
      }),
    ).resolves.toMatchObject({
      output: {
        code: "missing_salesforce_org",
        ok: false,
        workflow: "quote_pdf",
      },
    });
    expect(quoteWorkflow.calls).toEqual([]);
  });

  it("returns disabled workflow responses without bypassing workflow gates", async () => {
    const quoteWorkflow = new FakeQuoteWorkflow({
      code: "disabled",
      ok: false,
      slackMessage: "Quote PDF is disabled for this Salesforce org.",
    });
    const registry = registryWith({ quoteWorkflow });

    await expect(
      registry.execute({
        input: { quoteIdentifier: "Q-001" },
        toolCallId: "call-1",
        toolName: "create_quote_pdf",
      }),
    ).resolves.toMatchObject({
      output: {
        code: "disabled",
        message: "Quote PDF is disabled for this Salesforce org.",
        ok: false,
        workflow: "quote_pdf",
      },
    });
  });

  it("returns successful generation responses with confirmation required", async () => {
    const quoteWorkflow = new FakeQuoteWorkflow(successQuotePreview());
    const registry = registryWith({ quoteWorkflow });

    await expect(
      registry.execute({
        input: { quoteIdentifier: "Q-001" },
        toolCallId: "call-1",
        toolName: "create_quote_pdf",
      }),
    ).resolves.toMatchObject({
      output: {
        confirmationRequired: true,
        ok: true,
        workflow: "quote_pdf",
      },
    });
    expect(quoteWorkflow.calls[0]).toMatchObject({
      mode: "preview",
      quoteNumber: "Q-001",
      salesforceOrgId: "00D000000000001AAA",
      slackUserId: "U1",
      teamId: "T1",
    });
  });

  it("does not let tool input trigger confirmed Salesforce attachment mode", async () => {
    const quoteWorkflow = new FakeQuoteWorkflow(successQuoteAttachment());
    const registry = registryWith({ quoteWorkflow });

    await registry.execute({
      input: { attachToSalesforce: true, quoteIdentifier: "0Q0000000000001AAA" },
      toolCallId: "call-1",
      toolName: "create_quote_pdf",
    });

    expect(quoteWorkflow.calls[0]).toMatchObject({
      mode: "preview",
      quoteId: "0Q0000000000001AAA",
    });
  });

  it("maps Deal Review Pack tool input into the workflow", async () => {
    const dealWorkflow = new FakeDealWorkflow(successDealPreview());
    const registry = registryWith({ dealWorkflow });

    await expect(
      registry.execute({
        input: { opportunityIdentifier: "Expansion" },
        toolCallId: "call-1",
        toolName: "create_deal_review_pack",
      }),
    ).resolves.toMatchObject({
      output: {
        confirmationRequired: true,
        ok: true,
        workflow: "deal_review_pack",
      },
    });
    expect(dealWorkflow.calls[0]).toMatchObject({
      mode: "preview",
      opportunityName: "Expansion",
    });
  });
});

function registryWith(
  input: {
    dealWorkflow?: FakeDealWorkflow;
    quoteWorkflow?: FakeQuoteWorkflow;
    salesforceOrgId?: string;
  } = {},
) {
  return new AgentToolRegistry(
    createSalesforcePdfAgentTools({
      context: {
        salesforceOrgId: "salesforceOrgId" in input ? input.salesforceOrgId : "00D000000000001AAA",
        slackUserId: "U1",
        teamId: "T1",
      },
      dealReviewPackWorkflow: (input.dealWorkflow ??
        new FakeDealWorkflow(successDealPreview())) as never,
      quotePdfWorkflow: (input.quoteWorkflow ??
        new FakeQuoteWorkflow(successQuotePreview())) as never,
    }),
  );
}

function successQuotePreview(): QuotePdfWorkflowResult {
  return {
    confirmationRequired: true,
    mode: "preview",
    ok: true,
    pdf: {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      pathOnClient: "Quote-Q-001.pdf",
      templateId: "quote_v1",
      title: "Quote-Q-001",
    },
    quote: {
      accountName: "Acme",
      id: "0Q0000000000001AAA",
      opportunityName: "Expansion",
      quoteName: "Acme Quote",
      quoteNumber: "Q-001",
      totalAmount: "300",
    },
    slackMessage: "Quote PDF generated for Q-001.",
  };
}

function successQuoteAttachment(): QuotePdfWorkflowResult {
  const preview = successQuotePreview();
  if (!preview.ok) {
    throw new Error("Expected quote preview success.");
  }
  return {
    ...preview,
    attachment: {
      contentDocumentId: "069000000000001AAA",
      contentVersionId: "068000000000001AAA",
      links: [],
      targetRecordIds: ["0Q0000000000001AAA"],
    },
    confirmationRequired: false,
    mode: "attach_confirmed",
  };
}

function successDealPreview(): DealReviewPackResult {
  return {
    confirmationRequired: true,
    mode: "preview",
    ok: true,
    pdf: {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      pathOnClient: "Deal-Review-Expansion.pdf",
      templateId: "deal_review_pack_v1",
      title: "Deal-Review-Expansion",
    },
    slackMessage: "Deal Review Pack generated for Expansion.",
    summary: {
      accountName: "Acme",
      amount: "300",
      closeDate: "2026-06-30",
      id: "006000000000001AAA",
      nextStep: "Confirm legal review.",
      opportunityName: "Expansion",
      ownerName: "Sales Owner",
      reviewNotes: "Review notes.",
      stageName: "Proposal",
    },
  };
}

class FakeQuoteWorkflow {
  readonly calls: QuotePdfWorkflowInput[] = [];

  constructor(private readonly result: QuotePdfWorkflowResult) {}

  async run(input: QuotePdfWorkflowInput): Promise<QuotePdfWorkflowResult> {
    this.calls.push(input);
    return this.result;
  }
}

class FakeDealWorkflow {
  readonly calls: DealReviewPackWorkflowInput[] = [];

  constructor(private readonly result: DealReviewPackResult) {}

  async run(input: DealReviewPackWorkflowInput): Promise<DealReviewPackResult> {
    this.calls.push(input);
    return this.result;
  }
}
