import { BLANK_PDF, type Template } from "@pdfme/common";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  InMemoryPdfTemplateRegistry,
  PdfmeGenerationService,
  createDefaultDealReviewPackTemplate,
  createDefaultQuotePdfTemplate,
  normalizePdfTemplateInput,
  validatePdfTemplateInput,
} from "../../../src/integrations/pdf/index.js";

describe("PdfmeGenerationService", () => {
  it("renders the default Quote PDF template", async () => {
    const service = new PdfmeGenerationService({
      registry: new InMemoryPdfTemplateRegistry([createDefaultQuotePdfTemplate()]),
    });

    const result = await service.render({
      input: {
        accountName: "Acme",
        generatedAt: "2026-05-13T00:00:00Z",
        lineItems: [
          ["Product A", "2", "$200"],
          ["Product B", "1", "$100"],
        ],
        opportunityName: "Expansion",
        quoteName: "Acme Quote",
        quoteNumber: "Q-001",
        sourceRecordId: "0Q0000000000001AAA",
        totalAmount: "$300",
      },
      templateId: "quote_v1",
    });

    expect(result.template.templateId).toBe("quote_v1");
    expect(result.bytes[0]).toBe(0x25);
    expect(Buffer.from(result.bytes.subarray(0, 4)).toString("utf8")).toBe("%PDF");
  });

  it("renders the default Deal Review Pack template", async () => {
    const service = new PdfmeGenerationService({
      registry: new InMemoryPdfTemplateRegistry([createDefaultDealReviewPackTemplate()]),
    });

    const result = await service.render({
      input: {
        accountName: "Acme",
        amount: "$300",
        closeDate: "2026-06-30",
        generatedAt: "2026-05-13T00:00:00Z",
        nextStep: "Confirm legal review.",
        opportunityName: "Expansion",
        ownerName: "Sales Owner",
        reviewNotes: "Discount requires approval before final quote.",
        sourceRecordId: "006000000000001AAA",
        stageName: "Proposal",
      },
      templateId: "deal_review_pack_v1",
    });

    expect(Buffer.from(result.bytes.subarray(0, 4)).toString("utf8")).toBe("%PDF");
  });

  it("rejects missing templates", async () => {
    const service = new PdfmeGenerationService({
      registry: new InMemoryPdfTemplateRegistry([]),
    });

    await expect(service.render({ input: {}, templateId: "missing" })).rejects.toMatchObject({
      code: "missing_template",
    });
  });

  it("validates template input before rendering", async () => {
    const service = new PdfmeGenerationService({
      registry: new InMemoryPdfTemplateRegistry([
        {
          action: "quote_pdf",
          displayName: "Minimal",
          inputSchema: { customerName: z.string() },
          template: minimalTextTemplate(),
          templateId: "minimal",
          version: "1",
        },
      ]),
    });

    await expect(
      service.render({ input: { customerName: 123 }, templateId: "minimal" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects non-object template input before rendering", async () => {
    const service = new PdfmeGenerationService({
      registry: new InMemoryPdfTemplateRegistry([createDefaultDealReviewPackTemplate()]),
    });

    await expect(
      service.render({ input: null as never, templateId: "deal_review_pack_v1" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("validates default quote line item column counts", async () => {
    const service = new PdfmeGenerationService({
      registry: new InMemoryPdfTemplateRegistry([createDefaultQuotePdfTemplate()]),
    });

    await expect(
      service.render({
        input: {
          accountName: "Acme",
          generatedAt: "2026-05-13T00:00:00Z",
          lineItems: [["Product A", "2"]],
          opportunityName: "Expansion",
          quoteName: "Acme Quote",
          quoteNumber: "Q-001",
          sourceRecordId: "0Q0000000000001AAA",
          totalAmount: "$300",
        },
        templateId: "quote_v1",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects unsupported schema types before rendering", async () => {
    const service = new PdfmeGenerationService({
      registry: new InMemoryPdfTemplateRegistry([
        {
          action: "quote_pdf",
          displayName: "Unsupported",
          template: {
            basePdf: BLANK_PDF,
            schemas: [
              [
                {
                  height: 10,
                  name: "custom",
                  position: { x: 0, y: 0 },
                  type: "customWidget",
                  width: 10,
                },
              ],
            ],
          } as Template,
          templateId: "unsupported",
          version: "1",
        },
      ]),
    });

    await expect(service.render({ input: {}, templateId: "unsupported" })).rejects.toMatchObject({
      code: "unsupported_schema",
    });
  });

  it("classifies malformed pdfme templates as invalid templates", async () => {
    const service = new PdfmeGenerationService({
      registry: new InMemoryPdfTemplateRegistry([
        {
          action: "quote_pdf",
          displayName: "Malformed",
          template: { basePdf: BLANK_PDF } as Template,
          templateId: "malformed",
          version: "1",
        },
      ]),
    });

    await expect(service.render({ input: {}, templateId: "malformed" })).rejects.toMatchObject({
      code: "invalid_template",
    });
  });

  it("classifies malformed input schema metadata as invalid templates", async () => {
    const service = new PdfmeGenerationService({
      registry: new InMemoryPdfTemplateRegistry([
        {
          action: "quote_pdf",
          displayName: "Malformed metadata",
          inputSchema: { customerName: "not-zod" } as never,
          template: minimalTextTemplate(),
          templateId: "malformed_metadata",
          version: "1",
        },
      ]),
    });

    await expect(
      service.render({ input: { customerName: "Acme" }, templateId: "malformed_metadata" }),
    ).rejects.toMatchObject({
      code: "invalid_template",
    });
  });

  it("rejects input schema metadata that only imitates Zod", async () => {
    const service = new PdfmeGenerationService({
      registry: new InMemoryPdfTemplateRegistry([
        {
          action: "quote_pdf",
          displayName: "Fake metadata",
          inputSchema: { customerName: { safeParse: () => ({ success: true }) } } as never,
          template: minimalTextTemplate(),
          templateId: "fake_metadata",
          version: "1",
        },
      ]),
    });

    await expect(
      service.render({ input: { customerName: "Acme" }, templateId: "fake_metadata" }),
    ).rejects.toMatchObject({
      code: "invalid_template",
    });
  });

  it("rejects unsupported static schema types before rendering", async () => {
    const service = new PdfmeGenerationService({
      registry: new InMemoryPdfTemplateRegistry([
        {
          action: "quote_pdf",
          displayName: "Unsupported static",
          template: {
            basePdf: {
              height: 297,
              padding: [0, 0, 0, 0],
              staticSchema: [
                {
                  height: 10,
                  name: "staticCustom",
                  position: { x: 0, y: 0 },
                  type: "customWidget",
                  width: 10,
                },
              ],
              width: 210,
            },
            schemas: [[]],
          } as Template,
          templateId: "unsupported_static",
          version: "1",
        },
      ]),
    });

    await expect(
      service.render({ input: {}, templateId: "unsupported_static" }),
    ).rejects.toMatchObject({
      code: "unsupported_schema",
    });
  });

  it("preserves validated input fields that are not dynamic pdfme schema names", () => {
    expect(
      normalizePdfTemplateInput(minimalTextTemplate(), {
        customerName: "Acme",
        generatedAt: "2026-05-13T00:00:00Z",
      }),
    ).toMatchObject({
      customerName: "Acme",
      generatedAt: "2026-05-13T00:00:00Z",
    });
  });

  it("normalizes validated input instead of raw input", () => {
    expect(
      validatePdfTemplateInput(
        {
          action: "quote_pdf",
          displayName: "Validated",
          inputSchema: {
            customerName: z.string().transform((value) => value.trim()),
            generatedAt: z.string().default("2026-05-13T00:00:00Z"),
          },
          template: minimalTextTemplate(),
          templateId: "validated",
          version: "1",
        },
        {
          customerName: "  Acme  ",
          untrusted: "should not render",
        },
      ),
    ).toEqual({
      customerName: "Acme",
      generatedAt: "2026-05-13T00:00:00Z",
    });
  });

  it("rejects oversized default quote line item arrays", async () => {
    const service = new PdfmeGenerationService({
      registry: new InMemoryPdfTemplateRegistry([createDefaultQuotePdfTemplate()]),
    });

    await expect(
      service.render({
        input: {
          accountName: "Acme",
          generatedAt: "2026-05-13T00:00:00Z",
          lineItems: Array.from({ length: 51 }, (_, index) => [`Product ${index}`, "1", "$100"]),
          opportunityName: "Expansion",
          quoteName: "Acme Quote",
          quoteNumber: "Q-001",
          sourceRecordId: "0Q0000000000001AAA",
          totalAmount: "$5100",
        },
        templateId: "quote_v1",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects oversized default deal review text fields", async () => {
    const service = new PdfmeGenerationService({
      registry: new InMemoryPdfTemplateRegistry([createDefaultDealReviewPackTemplate()]),
    });

    await expect(
      service.render({
        input: {
          accountName: "Acme",
          amount: "$300",
          closeDate: "2026-06-30",
          generatedAt: "2026-05-13T00:00:00Z",
          nextStep: "Confirm legal review.",
          opportunityName: "Expansion",
          ownerName: "Sales Owner",
          reviewNotes: "x".repeat(4_001),
          sourceRecordId: "006000000000001AAA",
          stageName: "Proposal",
        },
        templateId: "deal_review_pack_v1",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

function minimalTextTemplate(): Template {
  return {
    basePdf: BLANK_PDF,
    schemas: [
      [
        {
          height: 10,
          name: "customerName",
          position: { x: 0, y: 0 },
          type: "text",
          width: 50,
        },
      ],
    ],
  };
}
