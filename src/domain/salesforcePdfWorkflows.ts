import { z } from "zod";

export const salesforcePdfWorkflowActions = ["quote_pdf", "deal_review_pack"] as const;

export const salesforcePdfWorkflowActionSchema = z.enum(salesforcePdfWorkflowActions);

export const salesforcePdfAttachTargetSchema = z.enum([
  "source_record",
  "quote",
  "opportunity",
  "both",
]);

const trimmedStringSchema = z.string().trim().min(1);

export const salesforcePdfWorkflowSettingsSchema = z.object({
  action: salesforcePdfWorkflowActionSchema,
  allowed_record_type_ids: z.array(trimmedStringSchema).default([]),
  allowed_record_type_names: z.array(trimmedStringSchema).default([]),
  allowed_approval_statuses: z.array(trimmedStringSchema).default([]),
  allowed_stages: z.array(trimmedStringSchema).default([]),
  allowed_statuses: z.array(trimmedStringSchema).default([]),
  approval_status_field: z.string().nullable().optional(),
  attach_to: salesforcePdfAttachTargetSchema.default("source_record"),
  created_at: z.coerce.date(),
  enabled: z.boolean().default(false),
  enabled_at: z.coerce.date().nullable().optional(),
  enabled_by_slack_user_id: z.string().nullable().optional(),
  field_mapping: z.record(z.string(), trimmedStringSchema).default({}),
  include_ai_summary: z.boolean().default(false),
  record_type_field: z.string().nullable().optional(),
  required_fields: z.array(trimmedStringSchema).default([]),
  require_confirmation_before_attach: z.boolean().default(true),
  salesforce_org_id: trimmedStringSchema,
  slack_channel_allowlist: z.array(trimmedStringSchema).default([]),
  slack_user_group_allowlist: z.array(trimmedStringSchema).default([]),
  status_field: z.string().nullable().optional(),
  stage_field: z.string().nullable().optional(),
  team_id: trimmedStringSchema,
  template_id: trimmedStringSchema,
  updated_at: z.coerce.date(),
  updated_by_slack_user_id: z.string().nullable().optional(),
});

export const salesforcePdfTemplateMetadataSchema = z.object({
  action: salesforcePdfWorkflowActionSchema,
  created_at: z.coerce.date(),
  created_by_slack_user_id: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  display_name: trimmedStringSchema,
  salesforce_org_id: trimmedStringSchema,
  status: z.enum(["active", "archived", "draft"]).default("draft"),
  team_id: trimmedStringSchema,
  template_id: trimmedStringSchema,
  updated_at: z.coerce.date(),
  version: trimmedStringSchema,
});

export type SalesforcePdfWorkflowAction = z.infer<typeof salesforcePdfWorkflowActionSchema>;
export type SalesforcePdfAttachTarget = z.infer<typeof salesforcePdfAttachTargetSchema>;
export type SalesforcePdfWorkflowSettings = z.infer<typeof salesforcePdfWorkflowSettingsSchema>;
export type SalesforcePdfTemplateMetadata = z.infer<typeof salesforcePdfTemplateMetadataSchema>;

export type SalesforcePdfWorkflowGateResult =
  | { allowed: true; settings: SalesforcePdfWorkflowSettings }
  | { allowed: false; reason: "disabled" | "missing_settings" | "invalid_settings" };

export function evaluateSalesforcePdfWorkflowGate(
  payload: unknown,
): SalesforcePdfWorkflowGateResult {
  if (payload === undefined) {
    return { allowed: false, reason: "missing_settings" };
  }
  const parsed = salesforcePdfWorkflowSettingsSchema.safeParse(payload);
  if (!parsed.success) {
    return { allowed: false, reason: "invalid_settings" };
  }
  if (!parsed.data.enabled) {
    return { allowed: false, reason: "disabled" };
  }
  return { allowed: true, settings: parsed.data };
}

export function salesforcePdfWorkflowActionLabel(action: SalesforcePdfWorkflowAction): string {
  switch (action) {
    case "quote_pdf":
      return "Quote PDF";
    case "deal_review_pack":
      return "Deal Review Pack";
  }
}
