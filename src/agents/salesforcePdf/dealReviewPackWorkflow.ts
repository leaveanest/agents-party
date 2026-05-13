import { z } from "zod";

import {
  evaluateSalesforcePdfWorkflowGate,
  type SalesforcePdfWorkflowSettings,
} from "../../domain/salesforcePdfWorkflows.js";
import { OAuthFlowError } from "../../integrations/oauth/coordinators.js";
import { PdfGenerationError, type PdfRenderResult } from "../../integrations/pdf/index.js";
import {
  SalesforceApiError,
  type SalesforceApiContext,
  type SalesforceContentVersionResult,
  type SalesforceQueryResult,
  type SalesforceRecord,
} from "../../integrations/salesforce/index.js";

const dealReviewPackAction = "deal_review_pack" as const;
const opportunityObjectName = "Opportunity";
const defaultTemplateId = "deal_review_pack_v1";
const defaultStageField = "StageName";
const defaultRecordTypeIdField = "RecordTypeId";
const defaultRecordTypeNameField = "RecordType.Name";

const defaultOpportunityFieldMapping = {
  accountName: "Account.Name",
  amount: "Amount",
  closeDate: "CloseDate",
  nextStep: "NextStep",
  opportunityName: "Name",
  ownerName: "Owner.Name",
  reviewNotes: "Description",
  sourceRecordId: "Id",
  stageName: "StageName",
} as const;

class DealReviewPackConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DealReviewPackConfigurationError";
  }
}

class DealReviewPackAttachmentPartialError extends Error {
  readonly attachment: DealReviewPackAttachment;

  constructor(message: string, input: { attachment: DealReviewPackAttachment; cause?: unknown }) {
    super(message);
    this.name = "DealReviewPackAttachmentPartialError";
    this.attachment = input.attachment;
    this.cause = input.cause;
  }
}

export const dealReviewPackWorkflowInputSchema = z
  .object({
    mode: z.enum(["attach_confirmed", "preview"]).default("preview"),
    opportunityId: z.string().trim().optional(),
    opportunityName: z.string().trim().optional(),
    opportunityUrl: z.string().trim().optional(),
    salesforceOrgId: z.string().trim().min(1),
    slackUserId: z.string().trim().min(1),
    teamId: z.string().trim().min(1),
  })
  .superRefine((input, context) => {
    const selectors = [input.opportunityId, input.opportunityName, input.opportunityUrl].filter(
      (value) => value !== undefined && value !== "",
    );
    if (selectors.length === 0) {
      context.addIssue({
        code: "custom",
        message: "An Opportunity record id, name, or URL is required.",
        path: ["opportunityName"],
      });
    }
    if (selectors.length > 1) {
      context.addIssue({
        code: "custom",
        message: "Provide only one Opportunity selector.",
        path: ["opportunityName"],
      });
    }
    if (
      input.opportunityId !== undefined &&
      input.opportunityId !== "" &&
      !isSalesforceRecordId(input.opportunityId)
    ) {
      context.addIssue({
        code: "custom",
        message: "The Opportunity record id is invalid.",
        path: ["opportunityId"],
      });
    }
    if (input.opportunityUrl !== undefined && input.opportunityUrl !== "") {
      const id = extractSalesforceRecordId(input.opportunityUrl);
      if (id === undefined) {
        context.addIssue({
          code: "custom",
          message: "The Opportunity URL does not include a Salesforce record id.",
          path: ["opportunityUrl"],
        });
      }
    }
  });

export type DealReviewPackWorkflowSettingsRepository = {
  findSalesforcePdfWorkflowSetting(
    teamId: string,
    salesforceOrgId: string,
    action: typeof dealReviewPackAction,
  ): Promise<unknown>;
};

export type DealReviewPackSalesforceGateway = {
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

export type DealReviewPackRenderer = {
  render(input: { input: Record<string, unknown>; templateId: string }): Promise<PdfRenderResult>;
};

export type DealReviewPackNarrativeGenerator = {
  generate(input: {
    opportunity: DealReviewPackOpportunitySummary;
    salesforceFields: Record<string, string>;
  }): Promise<{ reviewNotes: string }>;
};

export type DealReviewPackWorkflowInput = z.input<typeof dealReviewPackWorkflowInputSchema>;
export type DealReviewPackWorkflowMode = "attach_confirmed" | "preview";

export type DealReviewPackFailureCode =
  | "ambiguous_opportunity"
  | "approval_not_satisfied"
  | "attach_failed"
  | "disabled"
  | "disallowed_record_type"
  | "disallowed_stage"
  | "invalid_attach_target"
  | "invalid_request"
  | "invalid_settings"
  | "missing_required_fields"
  | "missing_salesforce_connection"
  | "missing_settings"
  | "opportunity_not_found"
  | "render_failed"
  | "salesforce_error";

export type DealReviewPackAttachment = {
  contentDocumentId?: string;
  contentVersionId: string;
  links: Array<{ contentDocumentLinkId: string; linkedEntityId: string }>;
  targetRecordIds: string[];
};

export type DealReviewPackSuccess = {
  attachment?: DealReviewPackAttachment;
  confirmationRequired: boolean;
  mode: DealReviewPackWorkflowMode;
  ok: true;
  pdf: {
    bytes: Uint8Array;
    pathOnClient: string;
    templateId: string;
    title: string;
  };
  slackMessage: string;
  summary: DealReviewPackOpportunitySummary;
};

export type DealReviewPackFailure = {
  attachment?: DealReviewPackAttachment;
  code: DealReviewPackFailureCode;
  missingFields?: string[];
  ok: false;
  partialSuccess?: boolean;
  reconnectRequired?: boolean;
  slackMessage: string;
};

export type DealReviewPackResult = DealReviewPackFailure | DealReviewPackSuccess;

export type DealReviewPackOpportunitySummary = {
  accountName: string;
  amount: string;
  closeDate: string;
  id: string;
  nextStep: string;
  opportunityName: string;
  ownerName: string;
  reviewNotes: string;
  stageName: string;
};

export class DealReviewPackWorkflow {
  private readonly clock: () => Date;
  private readonly narrativeGenerator?: DealReviewPackNarrativeGenerator;
  private readonly pdfRenderer: DealReviewPackRenderer;
  private readonly salesforce: DealReviewPackSalesforceGateway;
  private readonly settingsRepository: DealReviewPackWorkflowSettingsRepository;

  constructor(input: {
    clock?: () => Date;
    narrativeGenerator?: DealReviewPackNarrativeGenerator;
    pdfRenderer: DealReviewPackRenderer;
    salesforce: DealReviewPackSalesforceGateway;
    settingsRepository: DealReviewPackWorkflowSettingsRepository;
  }) {
    this.clock = input.clock ?? (() => new Date());
    this.narrativeGenerator = input.narrativeGenerator;
    this.pdfRenderer = input.pdfRenderer;
    this.salesforce = input.salesforce;
    this.settingsRepository = input.settingsRepository;
  }

  async run(input: DealReviewPackWorkflowInput): Promise<DealReviewPackResult> {
    const parsedInput = parseWorkflowInput(input);
    if (!parsedInput.ok) {
      return parsedInput;
    }
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
    let prepared: DealReviewPackPrepared | DealReviewPackFailure;
    try {
      prepared = await this.prepareDealReviewPack(
        context,
        normalizeRequest(parsedInput.input),
        gate.settings,
      );
    } catch (error) {
      return workflowFailureFromUnknown(error);
    }
    if (!prepared.ok) {
      return prepared;
    }
    switch (parsedInput.input.mode) {
      case "preview":
        return {
          confirmationRequired: gate.settings.require_confirmation_before_attach,
          mode: parsedInput.input.mode,
          ok: true,
          pdf: prepared.pdf,
          slackMessage: `Deal Review Pack generated for ${prepared.summary.opportunityName}.`,
          summary: prepared.summary,
        };
      case "attach_confirmed": {
        const targetRecordIds = resolveAttachTargets(gate.settings, prepared.summary);
        if (!targetRecordIds.ok) {
          return targetRecordIds;
        }
        try {
          const attachment = await this.attachPdf(
            context,
            prepared.pdf,
            targetRecordIds.targetRecordIds,
          );
          return {
            attachment,
            confirmationRequired: false,
            mode: parsedInput.input.mode,
            ok: true,
            pdf: prepared.pdf,
            slackMessage: `Deal Review Pack attached to Salesforce for ${prepared.summary.opportunityName}.`,
            summary: prepared.summary,
          };
        } catch (error) {
          if (error instanceof DealReviewPackAttachmentPartialError) {
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
  ): Promise<{ ok: true; settings: SalesforcePdfWorkflowSettings } | DealReviewPackFailure> {
    const payload = await this.settingsRepository.findSalesforcePdfWorkflowSetting(
      teamId,
      salesforceOrgId,
      dealReviewPackAction,
    );
    const gate = evaluateSalesforcePdfWorkflowGate(payload);
    if (gate.allowed) {
      return { ok: true, settings: gate.settings };
    }
    if (gate.reason === "missing_settings") {
      return {
        code: "missing_settings",
        ok: false,
        slackMessage: "Deal Review Pack is not configured for this Salesforce org.",
      };
    }
    if (gate.reason === "disabled") {
      return {
        code: "disabled",
        ok: false,
        slackMessage: "Deal Review Pack is disabled for this Salesforce org.",
      };
    }
    return {
      code: "invalid_settings",
      ok: false,
      slackMessage: "Deal Review Pack settings are invalid.",
    };
  }

  private async prepareDealReviewPack(
    context: SalesforceApiContext,
    request: NormalizedDealReviewRequest,
    settings: SalesforcePdfWorkflowSettings,
  ): Promise<DealReviewPackPrepared | DealReviewPackFailure> {
    const opportunity = await this.fetchOpportunity(context, request, settings);
    if (!opportunity.ok) {
      return opportunity;
    }
    const validation = validateOpportunityRules(settings, opportunity.record);
    if (!validation.ok) {
      return validation;
    }
    const summary = await this.buildSummary(settings, opportunity.record);
    const templateInput = buildTemplateInput(summary, this.clock());
    try {
      const rendered = await this.pdfRenderer.render({
        input: templateInput,
        templateId: settings.template_id || defaultTemplateId,
      });
      const title = buildFileTitle(summary);
      return {
        ok: true,
        pdf: {
          bytes: rendered.bytes,
          pathOnClient: `${title}.pdf`,
          templateId: rendered.template.templateId,
          title,
        },
        summary,
      };
    } catch (error) {
      if (error instanceof PdfGenerationError) {
        return {
          code: "render_failed",
          ok: false,
          slackMessage: `Deal Review Pack rendering failed: ${error.message}`,
        };
      }
      throw error;
    }
  }

  private async fetchOpportunity(
    context: SalesforceApiContext,
    request: NormalizedDealReviewRequest,
    settings: SalesforcePdfWorkflowSettings,
  ): Promise<{ ok: true; record: OpportunityRecord } | DealReviewPackFailure> {
    const fields = opportunityQueryFields(settings);
    const where =
      request.opportunityId === undefined
        ? `Name = '${escapeSoqlString(request.opportunityName)}'`
        : `Id = '${request.opportunityId}'`;
    const result = await this.salesforce.query(
      context,
      buildSoql(opportunityObjectName, fields, where, 2),
    );
    if (result.records.length === 0) {
      return {
        code: "opportunity_not_found",
        ok: false,
        slackMessage: "No Salesforce Opportunity matched the request.",
      };
    }
    if (result.records.length > 1) {
      return {
        code: "ambiguous_opportunity",
        ok: false,
        slackMessage:
          "Multiple Salesforce Opportunities matched the request. Use an Opportunity record id.",
      };
    }
    return { ok: true, record: parseOpportunityRecord(settings, result.records[0] ?? {}) };
  }

  private async buildSummary(
    settings: SalesforcePdfWorkflowSettings,
    opportunity: OpportunityRecord,
  ): Promise<DealReviewPackOpportunitySummary> {
    const deterministic = opportunity.summary;
    if (!settings.include_ai_summary || this.narrativeGenerator === undefined) {
      return deterministic;
    }
    try {
      const generated = await this.narrativeGenerator.generate({
        opportunity: deterministic,
        salesforceFields: collectSalesforceFields(settings, opportunity.raw),
      });
      const reviewNotes = generated.reviewNotes.trim();
      return {
        ...deterministic,
        reviewNotes: reviewNotes === "" ? deterministic.reviewNotes : reviewNotes.slice(0, 4_000),
      };
    } catch {
      return deterministic;
    }
  }

  private async attachPdf(
    context: SalesforceApiContext,
    pdf: DealReviewPackSuccess["pdf"],
    targetRecordIds: string[],
  ): Promise<DealReviewPackAttachment> {
    const [primaryTarget, ...additionalTargets] = targetRecordIds;
    const contentVersion = await this.salesforce.createContentVersion(context, {
      firstPublishLocationId: primaryTarget,
      pathOnClient: pdf.pathOnClient,
      pdfBytes: pdf.bytes,
      title: pdf.title,
    });
    const attachment: DealReviewPackAttachment = {
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
          throw new DealReviewPackAttachmentPartialError(
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

type NormalizedDealReviewRequest = {
  ok: true;
  opportunityId?: string;
  opportunityName: string;
};

type OpportunityRecord = {
  id: string;
  raw: SalesforceRecord;
  summary: DealReviewPackOpportunitySummary;
};

type DealReviewPackPrepared = {
  ok: true;
  pdf: DealReviewPackSuccess["pdf"];
  summary: DealReviewPackOpportunitySummary;
};

function parseWorkflowInput(
  input: DealReviewPackWorkflowInput,
): { input: z.output<typeof dealReviewPackWorkflowInputSchema>; ok: true } | DealReviewPackFailure {
  const parsed = dealReviewPackWorkflowInputSchema.safeParse(input);
  if (parsed.success) {
    return { input: parsed.data, ok: true };
  }
  return {
    code: "invalid_request",
    ok: false,
    slackMessage: parsed.error.issues[0]?.message ?? "Deal Review Pack request is invalid.",
  };
}

function normalizeRequest(
  input: z.output<typeof dealReviewPackWorkflowInputSchema>,
): NormalizedDealReviewRequest {
  const idFromUrl =
    input.opportunityUrl === undefined
      ? undefined
      : extractSalesforceRecordId(input.opportunityUrl);
  const opportunityId =
    input.opportunityId === undefined || input.opportunityId === ""
      ? idFromUrl
      : input.opportunityId;
  const opportunityName =
    input.opportunityName === undefined || input.opportunityName === ""
      ? (opportunityId ?? "")
      : input.opportunityName;
  return { ok: true, opportunityId, opportunityName };
}

function opportunityQueryFields(settings: SalesforcePdfWorkflowSettings): string[] {
  return dedupeFields([
    "Id",
    ...Object.values(defaultOpportunityFieldMapping),
    ...Object.values(settings.field_mapping),
    settings.stage_field ?? defaultStageField,
    settings.status_field ?? "",
    settings.approval_status_field ?? "",
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
): string {
  validateObjectApiName(objectApiName);
  return `SELECT ${fields.join(", ")} FROM ${objectApiName} WHERE ${whereClause} LIMIT ${limit}`;
}

function parseOpportunityRecord(
  settings: SalesforcePdfWorkflowSettings,
  record: SalesforceRecord,
): OpportunityRecord {
  const id = stringifyField(readField(record, "Id"));
  const summary: DealReviewPackOpportunitySummary = {
    accountName: stringifyField(readMappedField(settings, record, "accountName")),
    amount: stringifyField(readMappedField(settings, record, "amount")),
    closeDate: stringifyField(readMappedField(settings, record, "closeDate")),
    id,
    nextStep: stringifyField(readMappedField(settings, record, "nextStep")),
    opportunityName: stringifyField(readMappedField(settings, record, "opportunityName")),
    ownerName: stringifyField(readMappedField(settings, record, "ownerName")),
    reviewNotes: stringifyField(readMappedField(settings, record, "reviewNotes")),
    stageName: stringifyField(readMappedField(settings, record, "stageName")),
  };
  return { id, raw: record, summary };
}

function validateOpportunityRules(
  settings: SalesforcePdfWorkflowSettings,
  opportunity: OpportunityRecord,
): { ok: true } | DealReviewPackFailure {
  const required = settings.required_fields.filter((field) =>
    isBlank(readField(opportunity.raw, field)),
  );
  if (required.length > 0) {
    return {
      code: "missing_required_fields",
      missingFields: required,
      ok: false,
      slackMessage: `Opportunity is missing required Salesforce fields: ${required.join(", ")}.`,
    };
  }
  if (settings.allowed_stages.length > 0) {
    const stage = stringifyField(
      readField(opportunity.raw, settings.stage_field ?? defaultStageField),
    );
    if (!settings.allowed_stages.includes(stage)) {
      return {
        code: "disallowed_stage",
        ok: false,
        slackMessage: `Opportunity stage '${stage || "(blank)"}' is not allowed for Deal Review Pack.`,
      };
    }
  }
  if (settings.allowed_approval_statuses.length > 0) {
    const approvalField = settings.approval_status_field ?? settings.status_field;
    const approvalStatus =
      approvalField === undefined || approvalField === null
        ? ""
        : stringifyField(readField(opportunity.raw, approvalField));
    if (!settings.allowed_approval_statuses.includes(approvalStatus)) {
      return {
        code: "approval_not_satisfied",
        ok: false,
        slackMessage: `Opportunity approval status '${approvalStatus || "(blank)"}' is not allowed for Deal Review Pack.`,
      };
    }
  }
  const recordType = stringifyField(
    readField(opportunity.raw, settings.record_type_field ?? defaultRecordTypeIdField),
  );
  if (
    settings.allowed_record_type_ids.length > 0 &&
    !settings.allowed_record_type_ids.includes(recordType)
  ) {
    return {
      code: "disallowed_record_type",
      ok: false,
      slackMessage: "Opportunity record type is not allowed for Deal Review Pack.",
    };
  }
  const recordTypeName = stringifyField(readField(opportunity.raw, defaultRecordTypeNameField));
  if (
    settings.allowed_record_type_names.length > 0 &&
    !settings.allowed_record_type_names.includes(recordTypeName)
  ) {
    return {
      code: "disallowed_record_type",
      ok: false,
      slackMessage: "Opportunity record type is not allowed for Deal Review Pack.",
    };
  }
  return { ok: true };
}

function buildTemplateInput(
  summary: DealReviewPackOpportunitySummary,
  generatedAt: Date,
): Record<string, unknown> {
  return {
    accountName: summary.accountName,
    amount: summary.amount,
    closeDate: summary.closeDate,
    generatedAt: generatedAt.toISOString(),
    nextStep: summary.nextStep,
    opportunityName: summary.opportunityName,
    ownerName: summary.ownerName,
    reviewNotes: summary.reviewNotes,
    sourceRecordId: summary.id,
    stageName: summary.stageName,
  };
}

function resolveAttachTargets(
  settings: SalesforcePdfWorkflowSettings,
  summary: DealReviewPackOpportunitySummary,
): { ok: true; targetRecordIds: string[] } | DealReviewPackFailure {
  if (settings.attach_to === "opportunity" || settings.attach_to === "source_record") {
    return { ok: true, targetRecordIds: [summary.id] };
  }
  return {
    code: "invalid_attach_target",
    ok: false,
    slackMessage: "Deal Review Pack can only attach to the Opportunity record.",
  };
}

function readMappedField(
  settings: SalesforcePdfWorkflowSettings,
  record: SalesforceRecord,
  templateField: keyof typeof defaultOpportunityFieldMapping,
): unknown {
  return readField(
    record,
    settings.field_mapping[templateField] ?? defaultOpportunityFieldMapping[templateField],
  );
}

function collectSalesforceFields(
  settings: SalesforcePdfWorkflowSettings,
  record: SalesforceRecord,
): Record<string, string> {
  return Object.fromEntries(
    dedupeFields([
      ...Object.values(defaultOpportunityFieldMapping),
      ...Object.values(settings.field_mapping),
    ]).map((field) => [field, stringifyField(readField(record, field))]),
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

function isBlank(value: unknown): boolean {
  return stringifyField(value) === "";
}

function buildFileTitle(summary: DealReviewPackOpportunitySummary): string {
  return sanitizeFilename(`Deal-Review-${summary.opportunityName || summary.id}`);
}

function sanitizeFilename(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 120) || "Deal-Review-Pack"
  );
}

function escapeSoqlString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");
}

function workflowFailureFromUnknown(error: unknown): DealReviewPackFailure {
  if (error instanceof DealReviewPackConfigurationError) {
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
        slackMessage:
          "Connect or reconnect Salesforce for this org before generating Deal Review Packs.",
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
    throw new DealReviewPackConfigurationError("Salesforce object API name is invalid.");
  }
}

function validateFieldPath(value: string): void {
  if (
    !/^[A-Za-z][A-Za-z0-9_]*(?:__(?:c|r))?(?:\.[A-Za-z][A-Za-z0-9_]*(?:__(?:c|r))?)*$/u.test(value)
  ) {
    throw new DealReviewPackConfigurationError("Salesforce field path is invalid.");
  }
}

function extractSalesforceRecordId(value: string): string | undefined {
  return value.match(/[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?/u)?.[0];
}

function isSalesforceRecordId(value: string): boolean {
  return /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u.test(value);
}
