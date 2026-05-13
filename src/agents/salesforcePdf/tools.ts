import { z } from "zod";

import type { JsonValue } from "../../domain/messageHistory.js";
import type { AgentToolDefinition } from "../toolContracts.js";
import {
  type DealReviewPackResult,
  type DealReviewPackWorkflow,
  type QuotePdfWorkflow,
  type QuotePdfWorkflowResult,
} from "./index.js";

const salesforceRecordIdSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u);

export const createQuotePdfToolInputSchema = z
  .object({
    attachToSalesforce: z.boolean().default(false).optional(),
    quoteIdentifier: z.string().trim().min(1),
    salesforceOrgId: z.string().trim().min(1).optional(),
  })
  .strict();

export const createDealReviewPackToolInputSchema = z
  .object({
    attachToSalesforce: z.boolean().default(false).optional(),
    opportunityIdentifier: z.string().trim().min(1),
    salesforceOrgId: z.string().trim().min(1).optional(),
  })
  .strict();

const salesforcePdfToolOutputSchema = z
  .object({
    attachment: z
      .object({
        contentDocumentId: z.string().optional(),
        contentVersionId: z.string(),
        targetRecordIds: z.array(z.string()),
      })
      .optional(),
    code: z.string().optional(),
    confirmationRequired: z.boolean().default(false),
    message: z.string(),
    ok: z.boolean(),
    reconnectRequired: z.boolean().optional(),
    salesforceOrgId: z.string().optional(),
    workflow: z.enum(["deal_review_pack", "quote_pdf"]),
  })
  .strict();

export type CreateQuotePdfToolInput = z.infer<typeof createQuotePdfToolInputSchema>;
export type CreateDealReviewPackToolInput = z.infer<typeof createDealReviewPackToolInputSchema>;
export type SalesforcePdfToolOutput = z.infer<typeof salesforcePdfToolOutputSchema>;

export type SalesforcePdfToolContext = {
  salesforceOrgId?: string;
  slackUserId: string;
  teamId: string;
};

export type SalesforcePdfToolOptions = {
  context: SalesforcePdfToolContext;
  dealReviewPackWorkflow: DealReviewPackWorkflow;
  quotePdfWorkflow: QuotePdfWorkflow;
};

export function createSalesforcePdfAgentTools(
  options: SalesforcePdfToolOptions,
): AgentToolDefinition[] {
  return [
    {
      description:
        "Create a Salesforce Quote PDF preview. This tool never attaches to Salesforce; if attachment is needed, use the Slack confirmation flow after preview.",
      execute: async (input) => {
        const parsedInput = input as CreateQuotePdfToolInput;
        const salesforceOrgId = resolveSalesforceOrgIdOrUndefined(
          parsedInput.salesforceOrgId,
          options.context,
        );
        if (salesforceOrgId === undefined) {
          return missingSalesforceOrgOutput("quote_pdf");
        }
        return quoteResultToToolOutput(
          await options.quotePdfWorkflow.run({
            mode: "preview",
            ...quoteIdentifierInput(parsedInput.quoteIdentifier),
            salesforceOrgId,
            slackUserId: options.context.slackUserId,
            teamId: options.context.teamId,
          }),
          salesforceOrgId,
        );
      },
      name: "create_quote_pdf",
      outputSchema: salesforcePdfToolOutputSchema as z.ZodType<JsonValue>,
      parameters: z.toJSONSchema(createQuotePdfToolInputSchema) as JsonValue,
      schema: createQuotePdfToolInputSchema as z.ZodType<JsonValue>,
    },
    {
      description:
        "Create a Salesforce Deal Review Pack PDF preview from an Opportunity. This tool never attaches to Salesforce; if attachment is needed, use the Slack confirmation flow after preview.",
      execute: async (input) => {
        const parsedInput = input as CreateDealReviewPackToolInput;
        const salesforceOrgId = resolveSalesforceOrgIdOrUndefined(
          parsedInput.salesforceOrgId,
          options.context,
        );
        if (salesforceOrgId === undefined) {
          return missingSalesforceOrgOutput("deal_review_pack");
        }
        return dealResultToToolOutput(
          await options.dealReviewPackWorkflow.run({
            mode: "preview",
            ...opportunityIdentifierInput(parsedInput.opportunityIdentifier),
            salesforceOrgId,
            slackUserId: options.context.slackUserId,
            teamId: options.context.teamId,
          }),
          salesforceOrgId,
        );
      },
      name: "create_deal_review_pack",
      outputSchema: salesforcePdfToolOutputSchema as z.ZodType<JsonValue>,
      parameters: z.toJSONSchema(createDealReviewPackToolInputSchema) as JsonValue,
      schema: createDealReviewPackToolInputSchema as z.ZodType<JsonValue>,
    },
  ];
}

function resolveSalesforceOrgIdOrUndefined(
  inputSalesforceOrgId: string | undefined,
  context: SalesforcePdfToolContext,
): string | undefined {
  const salesforceOrgId = inputSalesforceOrgId ?? context.salesforceOrgId;
  if (salesforceOrgId === undefined || salesforceOrgId.trim() === "") {
    return undefined;
  }
  return salesforceOrgId.trim();
}

function missingSalesforceOrgOutput(
  workflow: SalesforcePdfToolOutput["workflow"],
): SalesforcePdfToolOutput {
  return {
    code: "missing_salesforce_org",
    confirmationRequired: false,
    message: "Choose a Salesforce org before running this PDF workflow.",
    ok: false,
    workflow,
  };
}

function quoteIdentifierInput(identifier: string): { quoteId?: string; quoteNumber?: string } {
  const value = identifier.trim();
  return salesforceRecordIdSchema.safeParse(value).success
    ? { quoteId: value }
    : { quoteNumber: value };
}

function opportunityIdentifierInput(identifier: string): {
  opportunityId?: string;
  opportunityName?: string;
  opportunityUrl?: string;
} {
  const value = identifier.trim();
  if (salesforceRecordIdSchema.safeParse(value).success) {
    return { opportunityId: value };
  }
  if (/^https:\/\//iu.test(value)) {
    return { opportunityUrl: value };
  }
  return { opportunityName: value };
}

function quoteResultToToolOutput(
  result: QuotePdfWorkflowResult,
  salesforceOrgId: string,
): SalesforcePdfToolOutput {
  if (!result.ok) {
    return compactOutput({
      code: result.code,
      confirmationRequired: false,
      message: result.slackMessage,
      ok: false,
      reconnectRequired: result.reconnectRequired,
      salesforceOrgId,
      workflow: "quote_pdf",
    });
  }
  return compactOutput({
    attachment: attachmentOutput(result.attachment),
    confirmationRequired:
      result.mode === "preview" && result.confirmationRequired && result.attachment === undefined,
    message: result.slackMessage,
    ok: true,
    salesforceOrgId,
    workflow: "quote_pdf",
  });
}

function dealResultToToolOutput(
  result: DealReviewPackResult,
  salesforceOrgId: string,
): SalesforcePdfToolOutput {
  if (!result.ok) {
    return compactOutput({
      code: result.code,
      confirmationRequired: false,
      message: result.slackMessage,
      ok: false,
      reconnectRequired: result.reconnectRequired,
      salesforceOrgId,
      workflow: "deal_review_pack",
    });
  }
  return compactOutput({
    attachment: attachmentOutput(result.attachment),
    confirmationRequired:
      result.mode === "preview" && result.confirmationRequired && result.attachment === undefined,
    message: result.slackMessage,
    ok: true,
    salesforceOrgId,
    workflow: "deal_review_pack",
  });
}

function attachmentOutput(
  attachment:
    | {
        contentDocumentId?: string;
        contentVersionId: string;
        targetRecordIds: string[];
      }
    | undefined,
): SalesforcePdfToolOutput["attachment"] {
  return attachment === undefined
    ? undefined
    : compactAttachment({
        contentDocumentId: attachment.contentDocumentId,
        contentVersionId: attachment.contentVersionId,
        targetRecordIds: attachment.targetRecordIds,
      });
}

function compactOutput(output: SalesforcePdfToolOutput): SalesforcePdfToolOutput {
  return Object.fromEntries(
    Object.entries(output).filter(([, value]) => value !== undefined),
  ) as SalesforcePdfToolOutput;
}

function compactAttachment(
  attachment: NonNullable<SalesforcePdfToolOutput["attachment"]>,
): NonNullable<SalesforcePdfToolOutput["attachment"]> {
  return Object.fromEntries(
    Object.entries(attachment).filter(([, value]) => value !== undefined),
  ) as NonNullable<SalesforcePdfToolOutput["attachment"]>;
}
