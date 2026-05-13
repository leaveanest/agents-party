import type { Template } from "@pdfme/common";
import { z } from "zod";

import type { PdfTemplateDefinition } from "./pdfmeGenerator.js";

const shortTextInput = z.string().trim().min(1).max(200);
const mediumTextInput = z.string().trim().min(1).max(1_000);
const longTextInput = z.string().trim().min(1).max(4_000);
const timestampInput = z.string().trim().min(1).max(80);
const quoteLineItemsInput = z
  .array(z.tuple([shortTextInput, shortTextInput, shortTextInput]))
  .min(1)
  .max(50);

export function createDefaultQuotePdfTemplate(): PdfTemplateDefinition {
  return {
    action: "quote_pdf",
    description: "Default quote PDF template with customer, deal, total, and line item table.",
    displayName: "Quote PDF",
    inputSchema: {
      accountName: shortTextInput,
      generatedAt: timestampInput,
      lineItems: quoteLineItemsInput,
      opportunityName: shortTextInput,
      quoteName: shortTextInput,
      quoteNumber: shortTextInput,
      sourceRecordId: shortTextInput,
      totalAmount: shortTextInput,
    },
    template: quoteTemplate(),
    templateId: "quote_v1",
    version: "1",
  };
}

export function createDefaultDealReviewPackTemplate(): PdfTemplateDefinition {
  return {
    action: "deal_review_pack",
    description: "Default deal review pack template with opportunity, account, and review notes.",
    displayName: "Deal Review Pack",
    inputSchema: {
      accountName: shortTextInput,
      amount: shortTextInput,
      closeDate: shortTextInput,
      generatedAt: timestampInput,
      nextStep: mediumTextInput,
      opportunityName: shortTextInput,
      ownerName: shortTextInput,
      reviewNotes: longTextInput,
      sourceRecordId: shortTextInput,
      stageName: shortTextInput,
    },
    template: dealReviewPackTemplate(),
    templateId: "deal_review_pack_v1",
    version: "1",
  };
}

function quoteTemplate(): Template {
  return {
    basePdf: { height: 297, padding: [15, 15, 15, 15], width: 210 },
    schemas: [
      [
        textSchema("title", "Quote", 15, 15, 180, 12, 22),
        textSchema("quoteNumber", "Quote Number", 15, 35, 80, 8),
        textSchema("quoteName", "Quote Name", 110, 35, 85, 8),
        textSchema("accountName", "Account", 15, 48, 180, 8),
        textSchema("opportunityName", "Opportunity", 15, 61, 180, 8),
        textSchema("totalAmount", "Total", 15, 74, 80, 8),
        textSchema("generatedAt", "Generated", 110, 74, 85, 8),
        textSchema("sourceRecordId", "Source Record", 15, 84, 180, 8),
        {
          bodyStyles: {
            alignment: "left",
            alternateBackgroundColor: "#F9FAFB",
            backgroundColor: "",
            borderColor: "#D0D5DD",
            borderWidth: { bottom: 0.2, left: 0.2, right: 0.2, top: 0.2 },
            characterSpacing: 0,
            fontColor: "#111827",
            fontSize: 9,
            lineHeight: 1,
            padding: { bottom: 2, left: 2, right: 2, top: 2 },
            verticalAlignment: "middle",
          },
          columnStyles: { alignment: {} },
          content: '[["Product","Qty","Amount"]]',
          head: ["Product", "Qty", "Amount"],
          headStyles: {
            alignment: "left",
            backgroundColor: "#1F2937",
            borderColor: "#1F2937",
            borderWidth: { bottom: 0, left: 0, right: 0, top: 0 },
            characterSpacing: 0,
            fontColor: "#FFFFFF",
            fontSize: 9,
            lineHeight: 1,
            padding: { bottom: 2, left: 2, right: 2, top: 2 },
            verticalAlignment: "middle",
          },
          headWidthPercentages: [50, 20, 30],
          height: 90,
          name: "lineItems",
          position: { x: 15, y: 100 },
          showHead: true,
          tableStyles: {
            borderColor: "#D0D5DD",
            borderWidth: 0.2,
          },
          type: "table",
          width: 180,
        },
      ],
    ],
  };
}

function dealReviewPackTemplate(): Template {
  return {
    basePdf: { height: 297, padding: [15, 15, 15, 15], width: 210 },
    schemas: [
      [
        textSchema("title", "Deal Review Pack", 15, 15, 180, 12, 22),
        textSchema("opportunityName", "Opportunity", 15, 35, 180, 8),
        textSchema("accountName", "Account", 15, 48, 180, 8),
        textSchema("stageName", "Stage", 15, 61, 80, 8),
        textSchema("amount", "Amount", 110, 61, 85, 8),
        textSchema("closeDate", "Close Date", 15, 74, 80, 8),
        textSchema("ownerName", "Owner", 110, 74, 85, 8),
        textSchema("nextStep", "Next Step", 15, 92, 180, 18),
        textSchema("reviewNotes", "Review Notes", 15, 120, 180, 70),
        textSchema("sourceRecordId", "Source Record", 15, 198, 180, 8),
        textSchema("generatedAt", "Generated", 15, 211, 180, 8),
      ],
    ],
  };
}

function textSchema(
  name: string,
  content: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSize = 10,
) {
  return {
    content,
    fontSize,
    height,
    name,
    position: { x, y },
    type: "text",
    width,
  };
}
