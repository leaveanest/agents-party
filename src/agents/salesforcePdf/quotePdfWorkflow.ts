import { PdfGenerationError, type PdfRenderResult } from "../../integrations/pdf/index.js";
import { OAuthFlowError } from "../../integrations/oauth/coordinators.js";
import {
  SalesforceApiError,
  type SalesforceApiContext,
  type SalesforceContentVersionResult,
  type SalesforceQueryResult,
  type SalesforceRecord,
} from "../../integrations/salesforce/index.js";
import {
  evaluateSalesforcePdfWorkflowGate,
  type SalesforcePdfWorkflowSettings,
} from "../../domain/salesforcePdfWorkflows.js";
import { z } from "zod";

const quotePdfAction = "quote_pdf" as const;
const quoteObjectName = "Quote";
const quoteLineItemObjectName = "QuoteLineItem";
const defaultTemplateId = "quote_v1";
const defaultStatusField = "Status";
const defaultStageField = "Opportunity.StageName";
const defaultRecordTypeIdField = "RecordTypeId";
const defaultRecordTypeNameField = "RecordType.Name";
const quoteLineItemRenderLimit = 50;

const defaultQuoteFieldMapping = {
  accountName: "Opportunity.Account.Name",
  opportunityName: "Opportunity.Name",
  quoteName: "Name",
  quoteNumber: "QuoteNumber",
  sourceRecordId: "Id",
  totalAmount: "GrandTotal",
} as const;

const defaultQuoteLineItemMapping = {
  amount: "TotalPrice",
  product: "Product2.Name",
  quantity: "Quantity",
} as const;

class SalesforcePdfWorkflowConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesforcePdfWorkflowConfigurationError";
  }
}

class SalesforcePdfAttachmentPartialError extends Error {
  readonly attachment: QuotePdfWorkflowAttachment;

  constructor(message: string, input: { attachment: QuotePdfWorkflowAttachment; cause?: unknown }) {
    super(message);
    this.name = "SalesforcePdfAttachmentPartialError";
    this.attachment = input.attachment;
    this.cause = input.cause;
  }
}

export const quotePdfWorkflowInputSchema = z
  .object({
    mode: z.enum(["attach_confirmed", "preview"]).default("preview"),
    quoteId: z.string().trim().optional(),
    quoteNumber: z.string().trim().optional(),
    salesforceOrgId: z.string().trim().min(1),
    slackUserId: z.string().trim().min(1),
    teamId: z.string().trim().min(1),
  })
  .superRefine((input, context) => {
    const hasQuoteId = input.quoteId !== undefined && input.quoteId !== "";
    const hasQuoteNumber = input.quoteNumber !== undefined && input.quoteNumber !== "";
    if (!hasQuoteId && !hasQuoteNumber) {
      context.addIssue({
        code: "custom",
        message: "A Quote record id or Quote number is required.",
        path: ["quoteNumber"],
      });
    }
    if (hasQuoteId && hasQuoteNumber) {
      context.addIssue({
        code: "custom",
        message: "Provide either a Quote record id or Quote number, not both.",
        path: ["quoteNumber"],
      });
    }
    if (hasQuoteId && !isSalesforceRecordId(input.quoteId ?? "")) {
      context.addIssue({
        code: "custom",
        message: "The Quote record id is invalid.",
        path: ["quoteId"],
      });
    }
  });

export type QuotePdfWorkflowSettingsRepository = {
  findSalesforcePdfWorkflowSetting(
    teamId: string,
    salesforceOrgId: string,
    action: typeof quotePdfAction,
  ): Promise<unknown>;
};

export type QuotePdfWorkflowSalesforceGateway = {
  createContentDocumentLink(
    context: SalesforceApiContext,
    input: {
      contentDocumentId: string;
      linkedEntityId: string;
      shareType?: "C" | "I" | "V";
      visibility?: "AllUsers" | "InternalUsers" | "SharedUsers";
    },
  ): Promise<{ contentDocumentLinkId: string }>;
  createContentVersion(
    context: SalesforceApiContext,
    input: {
      firstPublishLocationId?: string;
      pathOnClient: string;
      pdfBytes: Uint8Array;
      title: string;
    },
  ): Promise<SalesforceContentVersionResult>;
  query<TRecord extends SalesforceRecord = SalesforceRecord>(
    context: SalesforceApiContext,
    soql: string,
  ): Promise<SalesforceQueryResult<TRecord>>;
};

export type QuotePdfRenderer = {
  render(input: { input: Record<string, unknown>; templateId: string }): Promise<PdfRenderResult>;
};

export type QuotePdfWorkflowMode = "attach_confirmed" | "preview";

export type QuotePdfWorkflowInput = z.input<typeof quotePdfWorkflowInputSchema>;

export type QuotePdfWorkflowFailureCode =
  | "ambiguous_quote"
  | "attach_failed"
  | "disabled"
  | "disallowed_record_type"
  | "disallowed_stage"
  | "disallowed_status"
  | "invalid_request"
  | "invalid_settings"
  | "missing_required_fields"
  | "missing_salesforce_connection"
  | "missing_settings"
  | "quote_not_found"
  | "render_failed"
  | "salesforce_error"
  | "too_many_line_items";

export type QuotePdfWorkflowAttachment = {
  contentDocumentId?: string;
  contentVersionId: string;
  links: Array<{ contentDocumentLinkId: string; linkedEntityId: string }>;
  targetRecordIds: string[];
};

export type QuotePdfWorkflowSuccess = {
  attachment?: QuotePdfWorkflowAttachment;
  confirmationRequired: boolean;
  mode: QuotePdfWorkflowMode;
  ok: true;
  pdf: {
    bytes: Uint8Array;
    pathOnClient: string;
    templateId: string;
    title: string;
  };
  quote: QuotePdfWorkflowQuoteSummary;
  slackMessage: string;
};

export type QuotePdfWorkflowFailure = {
  attachment?: QuotePdfWorkflowAttachment;
  code: QuotePdfWorkflowFailureCode;
  missingFields?: string[];
  ok: false;
  partialSuccess?: boolean;
  reconnectRequired?: boolean;
  slackMessage: string;
};

export type QuotePdfWorkflowResult = QuotePdfWorkflowFailure | QuotePdfWorkflowSuccess;

export type QuotePdfWorkflowQuoteSummary = {
  accountName: string;
  id: string;
  opportunityId?: string;
  opportunityName: string;
  quoteName: string;
  quoteNumber: string;
  status?: string;
  stageName?: string;
  totalAmount: string;
};

export class QuotePdfWorkflow {
  private readonly clock: () => Date;
  private readonly pdfRenderer: QuotePdfRenderer;
  private readonly salesforce: QuotePdfWorkflowSalesforceGateway;
  private readonly settingsRepository: QuotePdfWorkflowSettingsRepository;

  constructor(input: {
    clock?: () => Date;
    pdfRenderer: QuotePdfRenderer;
    salesforce: QuotePdfWorkflowSalesforceGateway;
    settingsRepository: QuotePdfWorkflowSettingsRepository;
  }) {
    this.clock = input.clock ?? (() => new Date());
    this.pdfRenderer = input.pdfRenderer;
    this.salesforce = input.salesforce;
    this.settingsRepository = input.settingsRepository;
  }

  async run(input: QuotePdfWorkflowInput): Promise<QuotePdfWorkflowResult> {
    const parsedInput = parseWorkflowInput(input);
    if (!parsedInput.ok) {
      return parsedInput;
    }
    const request = normalizeRequest(parsedInput.input);
    const context: SalesforceApiContext = {
      salesforceOrgId: parsedInput.input.salesforceOrgId,
      slackUserId: parsedInput.input.slackUserId,
      teamId: parsedInput.input.teamId,
    };
    const gate = await this.loadSettings(
      parsedInput.input.teamId,
      parsedInput.input.salesforceOrgId,
    );
    if (!gate.ok) {
      return gate;
    }
    const settings = gate.settings;
    let prepared: PreparedQuotePdf | QuotePdfWorkflowFailure;
    try {
      prepared = await this.prepareQuotePdf(context, request, settings);
    } catch (error) {
      return workflowFailureFromUnknown(error);
    }
    if (!prepared.ok) {
      return prepared;
    }
    switch (parsedInput.input.mode) {
      case "preview":
        return {
          confirmationRequired: settings.require_confirmation_before_attach,
          mode: parsedInput.input.mode,
          ok: true,
          pdf: prepared.pdf,
          quote: prepared.quote,
          slackMessage: `Quote PDF generated for ${prepared.quote.quoteNumber}.`,
        };
      case "attach_confirmed": {
        const attachTargets = resolveAttachTargets(settings, prepared.quote);
        if (!attachTargets.ok) {
          return attachTargets;
        }
        try {
          const attachment = await this.attachPdf(
            context,
            prepared.pdf,
            attachTargets.targetRecordIds,
          );
          return {
            attachment,
            confirmationRequired: false,
            mode: parsedInput.input.mode,
            ok: true,
            pdf: prepared.pdf,
            quote: prepared.quote,
            slackMessage: `Quote PDF attached to Salesforce for ${prepared.quote.quoteNumber}.`,
          };
        } catch (error) {
          if (error instanceof SalesforcePdfAttachmentPartialError) {
            return {
              attachment: error.attachment,
              code: "attach_failed",
              ok: false,
              partialSuccess: true,
              slackMessage: `Salesforce Files attachment partially succeeded: ${error.message}`,
            };
          }
          return {
            code: "attach_failed",
            ok: false,
            slackMessage:
              error instanceof Error
                ? `Salesforce Files attachment failed: ${error.message}`
                : "Salesforce Files attachment failed.",
          };
        }
      }
    }
  }

  private async loadSettings(
    teamId: string,
    salesforceOrgId: string,
  ): Promise<{ ok: true; settings: SalesforcePdfWorkflowSettings } | QuotePdfWorkflowFailure> {
    const payload = await this.settingsRepository.findSalesforcePdfWorkflowSetting(
      teamId,
      salesforceOrgId,
      quotePdfAction,
    );
    const gate = evaluateSalesforcePdfWorkflowGate(payload);
    if (gate.allowed) {
      return { ok: true, settings: gate.settings };
    }
    if (gate.reason === "missing_settings") {
      return {
        code: "missing_settings",
        ok: false,
        slackMessage: "Quote PDF is not configured for this Salesforce org.",
      };
    }
    if (gate.reason === "disabled") {
      return {
        code: "disabled",
        ok: false,
        slackMessage: "Quote PDF is disabled for this Salesforce org.",
      };
    }
    return {
      code: "invalid_settings",
      ok: false,
      slackMessage: "Quote PDF settings are invalid.",
    };
  }

  private async prepareQuotePdf(
    context: SalesforceApiContext,
    request: NormalizedQuoteRequest,
    settings: SalesforcePdfWorkflowSettings,
  ): Promise<PreparedQuotePdf | QuotePdfWorkflowFailure> {
    const quote = await this.fetchQuote(context, request, settings);
    if (!quote.ok) {
      return quote;
    }
    const validation = validateQuoteRules(settings, quote.record);
    if (!validation.ok) {
      return validation;
    }
    const lineItems = await this.fetchQuoteLineItems(context, quote.record.id);
    if (!lineItems.ok) {
      return lineItems;
    }
    const templateInput = buildQuoteTemplateInput(
      settings,
      quote.record,
      lineItems.lineItems,
      this.clock(),
    );
    try {
      const rendered = await this.pdfRenderer.render({
        input: templateInput,
        templateId: settings.template_id || defaultTemplateId,
      });
      const title = buildQuoteFileTitle(quote.record);
      return {
        ok: true,
        pdf: {
          bytes: rendered.bytes,
          pathOnClient: `${title}.pdf`,
          templateId: rendered.template.templateId,
          title,
        },
        quote: quote.record.summary,
      };
    } catch (error) {
      if (error instanceof PdfGenerationError) {
        return {
          code: "render_failed",
          ok: false,
          slackMessage: `Quote PDF rendering failed: ${error.message}`,
        };
      }
      throw error;
    }
  }

  private async fetchQuote(
    context: SalesforceApiContext,
    request: NormalizedQuoteRequest,
    settings: SalesforcePdfWorkflowSettings,
  ): Promise<{ ok: true; record: QuoteRecord } | QuotePdfWorkflowFailure> {
    const fields = quoteQueryFields(settings);
    const where =
      request.quoteId === undefined
        ? `QuoteNumber = '${escapeSoqlString(request.quoteNumber)}'`
        : `Id = '${request.quoteId}'`;
    const result = await this.salesforce.query(
      context,
      buildSoql(quoteObjectName, fields, where, 2),
    );
    if (result.records.length === 0) {
      return {
        code: "quote_not_found",
        ok: false,
        slackMessage: "No Salesforce Quote matched the request.",
      };
    }
    if (result.records.length > 1) {
      return {
        code: "ambiguous_quote",
        ok: false,
        slackMessage: "Multiple Salesforce Quotes matched the request. Use a Quote record id.",
      };
    }
    return { ok: true, record: parseQuoteRecord(settings, result.records[0] ?? {}) };
  }

  private async fetchQuoteLineItems(
    context: SalesforceApiContext,
    quoteId: string,
  ): Promise<{ lineItems: QuoteLineItem[]; ok: true } | QuotePdfWorkflowFailure> {
    const fields = [
      "Id",
      defaultQuoteLineItemMapping.product,
      defaultQuoteLineItemMapping.quantity,
      defaultQuoteLineItemMapping.amount,
    ];
    const result = await this.salesforce.query(
      context,
      buildSoql(
        quoteLineItemObjectName,
        fields,
        `QuoteId = '${quoteId}'`,
        quoteLineItemRenderLimit + 1,
        {
          orderBy: "SortOrder ASC, CreatedDate ASC",
        },
      ),
    );
    if (result.records.length > quoteLineItemRenderLimit) {
      return {
        code: "too_many_line_items",
        ok: false,
        slackMessage: `Quote has more than ${quoteLineItemRenderLimit} line items. Narrow the Quote or use an official quote-generation system.`,
      };
    }
    return {
      lineItems: result.records.map((record) => ({
        amount: stringifyField(readField(record, defaultQuoteLineItemMapping.amount)),
        product: stringifyField(readField(record, defaultQuoteLineItemMapping.product)),
        quantity: stringifyField(readField(record, defaultQuoteLineItemMapping.quantity)),
      })),
      ok: true,
    };
  }

  private async attachPdf(
    context: SalesforceApiContext,
    pdf: QuotePdfWorkflowSuccess["pdf"],
    targetRecordIds: string[],
  ): Promise<QuotePdfWorkflowAttachment> {
    const [primaryTarget, ...additionalTargets] = targetRecordIds;
    const contentVersion = await this.salesforce.createContentVersion(context, {
      firstPublishLocationId: primaryTarget,
      pathOnClient: pdf.pathOnClient,
      pdfBytes: pdf.bytes,
      title: pdf.title,
    });
    const attachment: QuotePdfWorkflowAttachment = {
      contentDocumentId: contentVersion.contentDocumentId,
      contentVersionId: contentVersion.contentVersionId,
      links: [],
      targetRecordIds: [primaryTarget],
    };
    if (contentVersion.contentDocumentId !== undefined) {
      for (const linkedEntityId of additionalTargets) {
        try {
          const link = await this.salesforce.createContentDocumentLink(context, {
            contentDocumentId: contentVersion.contentDocumentId,
            linkedEntityId,
          });
          attachment.links.push({
            contentDocumentLinkId: link.contentDocumentLinkId,
            linkedEntityId,
          });
          attachment.targetRecordIds.push(linkedEntityId);
        } catch (error) {
          throw new SalesforcePdfAttachmentPartialError(
            `PDF file was attached to ${attachment.targetRecordIds.length} of ${targetRecordIds.length} Salesforce records.`,
            { attachment, cause: error },
          );
        }
      }
    } else if (additionalTargets.length > 0) {
      throw new Error("Salesforce did not return a ContentDocumentId for additional links.");
    }
    return attachment;
  }
}

type NormalizedQuoteRequest = {
  ok: true;
  quoteId?: string;
  quoteNumber: string;
};

type PreparedQuotePdf = {
  ok: true;
  pdf: QuotePdfWorkflowSuccess["pdf"];
  quote: QuotePdfWorkflowQuoteSummary;
};

type QuoteRecord = {
  id: string;
  raw: SalesforceRecord;
  summary: QuotePdfWorkflowQuoteSummary;
};

type QuoteLineItem = {
  amount: string;
  product: string;
  quantity: string;
};

function parseWorkflowInput(
  input: QuotePdfWorkflowInput,
): { input: z.output<typeof quotePdfWorkflowInputSchema>; ok: true } | QuotePdfWorkflowFailure {
  const parsed = quotePdfWorkflowInputSchema.safeParse(input);
  if (parsed.success) {
    return { input: parsed.data, ok: true };
  }
  return {
    code: "invalid_request",
    ok: false,
    slackMessage: parsed.error.issues[0]?.message ?? "Quote PDF request is invalid.",
  };
}

function normalizeRequest(
  input: z.output<typeof quotePdfWorkflowInputSchema>,
): NormalizedQuoteRequest {
  const quoteId = input.quoteId?.trim();
  const quoteNumber = input.quoteNumber?.trim();
  return {
    ok: true,
    quoteId: quoteId === "" ? undefined : quoteId,
    quoteNumber: quoteNumber === undefined || quoteNumber === "" ? (quoteId ?? "") : quoteNumber,
  };
}

function quoteQueryFields(settings: SalesforcePdfWorkflowSettings): string[] {
  return dedupeFields([
    "Id",
    "OpportunityId",
    ...Object.values(defaultQuoteFieldMapping),
    ...Object.values(settings.field_mapping),
    settings.status_field ?? defaultStatusField,
    settings.stage_field ?? defaultStageField,
    settings.record_type_field ?? defaultRecordTypeIdField,
    defaultRecordTypeNameField,
    ...settings.required_fields,
  ]);
}

function dedupeFields(fields: readonly string[]): string[] {
  const deduped = [...new Set(fields.map((field) => field.trim()).filter(Boolean))];
  for (const field of deduped) {
    validateFieldPath(field);
  }
  return deduped;
}

function buildSoql(
  objectApiName: string,
  fields: readonly string[],
  whereClause: string,
  limit: number,
  options: { orderBy?: string } = {},
): string {
  validateObjectApiName(objectApiName);
  return `SELECT ${fields.join(", ")} FROM ${objectApiName} WHERE ${whereClause}${
    options.orderBy === undefined ? "" : ` ORDER BY ${options.orderBy}`
  } LIMIT ${limit}`;
}

function parseQuoteRecord(
  settings: SalesforcePdfWorkflowSettings,
  record: SalesforceRecord,
): QuoteRecord {
  const id = stringifyField(readField(record, "Id"));
  const opportunityId = optionalString(readField(record, "OpportunityId"));
  const summary: QuotePdfWorkflowQuoteSummary = {
    accountName: stringifyField(readMappedField(settings, record, "accountName")),
    id,
    opportunityId,
    opportunityName: stringifyField(readMappedField(settings, record, "opportunityName")),
    quoteName: stringifyField(readMappedField(settings, record, "quoteName")),
    quoteNumber: stringifyField(readMappedField(settings, record, "quoteNumber")),
    status: optionalString(readField(record, settings.status_field ?? defaultStatusField)),
    stageName: optionalString(readField(record, settings.stage_field ?? defaultStageField)),
    totalAmount: stringifyField(readMappedField(settings, record, "totalAmount")),
  };
  return { id, raw: record, summary };
}

function validateQuoteRules(
  settings: SalesforcePdfWorkflowSettings,
  quote: QuoteRecord,
): { ok: true } | QuotePdfWorkflowFailure {
  const required = settings.required_fields.filter((field) => isBlank(readField(quote.raw, field)));
  if (required.length > 0) {
    return {
      code: "missing_required_fields",
      missingFields: required,
      ok: false,
      slackMessage: `Quote is missing required Salesforce fields: ${required.join(", ")}.`,
    };
  }
  if (settings.allowed_statuses.length > 0) {
    const status = stringifyField(
      readField(quote.raw, settings.status_field ?? defaultStatusField),
    );
    if (!settings.allowed_statuses.includes(status)) {
      return {
        code: "disallowed_status",
        ok: false,
        slackMessage: `Quote status '${status || "(blank)"}' is not allowed for Quote PDF.`,
      };
    }
  }
  if (settings.allowed_stages.length > 0) {
    const stage = stringifyField(readField(quote.raw, settings.stage_field ?? defaultStageField));
    if (!settings.allowed_stages.includes(stage)) {
      return {
        code: "disallowed_stage",
        ok: false,
        slackMessage: `Opportunity stage '${stage || "(blank)"}' is not allowed for Quote PDF.`,
      };
    }
  }
  const recordType = stringifyField(
    readField(quote.raw, settings.record_type_field ?? defaultRecordTypeIdField),
  );
  if (
    settings.allowed_record_type_ids.length > 0 &&
    !settings.allowed_record_type_ids.includes(recordType)
  ) {
    return {
      code: "disallowed_record_type",
      ok: false,
      slackMessage: "Quote record type is not allowed for Quote PDF.",
    };
  }
  const recordTypeName = stringifyField(readField(quote.raw, defaultRecordTypeNameField));
  if (
    settings.allowed_record_type_names.length > 0 &&
    !settings.allowed_record_type_names.includes(recordTypeName)
  ) {
    return {
      code: "disallowed_record_type",
      ok: false,
      slackMessage: "Quote record type is not allowed for Quote PDF.",
    };
  }
  return { ok: true };
}

function buildQuoteTemplateInput(
  settings: SalesforcePdfWorkflowSettings,
  quote: QuoteRecord,
  lineItems: readonly QuoteLineItem[],
  generatedAt: Date,
): Record<string, unknown> {
  return {
    accountName: stringifyField(readMappedField(settings, quote.raw, "accountName")),
    generatedAt: generatedAt.toISOString(),
    lineItems: lineItems.map((item) => [item.product, item.quantity, item.amount]),
    opportunityName: stringifyField(readMappedField(settings, quote.raw, "opportunityName")),
    quoteName: stringifyField(readMappedField(settings, quote.raw, "quoteName")),
    quoteNumber: stringifyField(readMappedField(settings, quote.raw, "quoteNumber")),
    sourceRecordId: quote.id,
    totalAmount: stringifyField(readMappedField(settings, quote.raw, "totalAmount")),
  };
}

function resolveAttachTargets(
  settings: SalesforcePdfWorkflowSettings,
  quote: QuotePdfWorkflowQuoteSummary,
): { ok: true; targetRecordIds: string[] } | QuotePdfWorkflowFailure {
  const targets =
    settings.attach_to === "both"
      ? [quote.id, quote.opportunityId]
      : settings.attach_to === "opportunity"
        ? [quote.opportunityId]
        : [quote.id];
  const targetRecordIds = [
    ...new Set(targets.filter((target): target is string => target !== undefined)),
  ];
  if (targetRecordIds.length === 0) {
    return {
      code: "missing_required_fields",
      missingFields: ["OpportunityId"],
      ok: false,
      slackMessage: "Quote is missing the Salesforce record required for attachment.",
    };
  }
  return { ok: true, targetRecordIds };
}

function readMappedField(
  settings: SalesforcePdfWorkflowSettings,
  record: SalesforceRecord,
  templateField: keyof typeof defaultQuoteFieldMapping,
): unknown {
  return readField(
    record,
    settings.field_mapping[templateField] ?? defaultQuoteFieldMapping[templateField],
  );
}

function readField(record: SalesforceRecord, fieldPath: string): unknown {
  return fieldPath.split(".").reduce<unknown>((value, segment) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    return (value as Record<string, unknown>)[segment];
  }, record);
}

function stringifyField(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return "";
}

function optionalString(value: unknown): string | undefined {
  const stringValue = stringifyField(value);
  return stringValue === "" ? undefined : stringValue;
}

function isBlank(value: unknown): boolean {
  return stringifyField(value) === "";
}

function buildQuoteFileTitle(quote: QuoteRecord): string {
  const quoteNumber = quote.summary.quoteNumber || quote.id;
  return sanitizeFilename(`Quote-${quoteNumber}`);
}

function sanitizeFilename(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 120) || "Quote"
  );
}

function escapeSoqlString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");
}

function workflowFailureFromUnknown(error: unknown): QuotePdfWorkflowFailure {
  if (error instanceof SalesforcePdfWorkflowConfigurationError) {
    return {
      code: "invalid_settings",
      ok: false,
      slackMessage: error.message,
    };
  }
  if (error instanceof OAuthFlowError) {
    if (
      error.code === "missing_salesforce_connection" ||
      error.code === "salesforce_reconnect_required"
    ) {
      return {
        code: "missing_salesforce_connection",
        ok: false,
        reconnectRequired: true,
        slackMessage: "Connect or reconnect Salesforce for this org before generating Quote PDFs.",
      };
    }
    return {
      code: "salesforce_error",
      ok: false,
      slackMessage: error.message,
    };
  }
  if (error instanceof SalesforceApiError) {
    return {
      code: "salesforce_error",
      ok: false,
      slackMessage: `Salesforce request failed: ${error.message}`,
    };
  }
  if (error instanceof Error) {
    return {
      code: "salesforce_error",
      ok: false,
      slackMessage: error.message,
    };
  }
  return {
    code: "salesforce_error",
    ok: false,
    slackMessage: "Salesforce request failed.",
  };
}

function validateObjectApiName(value: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:__c)?$/u.test(value)) {
    throw new SalesforcePdfWorkflowConfigurationError("Salesforce object API name is invalid.");
  }
}

function validateFieldPath(value: string): void {
  if (
    !/^[A-Za-z][A-Za-z0-9_]*(?:__(?:c|r))?(?:\.[A-Za-z][A-Za-z0-9_]*(?:__(?:c|r))?)*$/u.test(value)
  ) {
    throw new SalesforcePdfWorkflowConfigurationError("Salesforce field path is invalid.");
  }
}

function isSalesforceRecordId(value: string): boolean {
  return /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u.test(value);
}
