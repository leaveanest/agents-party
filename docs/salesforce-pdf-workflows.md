# Salesforce PDF Workflows

Salesforce PDF workflows combine Salesforce records, repository-owned workflow settings, and
pdfme templates to generate PDFs from Slack agent requests. The first supported workflows are:

- `quote_pdf`: creates a Quote PDF from a Salesforce `Quote`.
- `deal_review_pack`: creates a Deal Review Pack from a Salesforce `Opportunity`.

The workflows are disabled by default. A Slack workspace admin or owner must enable each workflow
for each Salesforce org before the agent tools can generate a PDF.

## Runtime Path

1. A Slack user asks the agent to create a Quote PDF or Deal Review Pack.
2. `AgentRunner` exposes the Salesforce PDF tools only when Salesforce OAuth, encrypted tokens,
   PostgreSQL repositories, and the Salesforce PDF runtime are configured.
3. The tool resolves the Slack `team_id`, Slack user, Salesforce org, and record identifier.
4. The workflow loads settings by `team_id + salesforce_org_id + action`.
5. The workflow reads the Salesforce record through the connected Salesforce user, validates
   org-specific policy, and renders a PDF through pdfme.
6. Tool calls generate previews only. Salesforce Files writes must go through the server-controlled
   `attach_confirmed` workflow mode after explicit Slack confirmation. The current agent-tool
   surface does not call `attach_confirmed` directly.
7. Before attachment, the workflow re-fetches and re-validates Salesforce data so stale previews
   cannot bypass the current stage, status, approval, record type, or required-field policy.

Implementation map:

- `src/agents/salesforcePdf/tools.ts`: AI tool definitions exposed to provider calls.
- `src/agents/salesforcePdf/runtime.ts`: runtime dependency wiring for OAuth, Salesforce REST,
  pdfme rendering, and workflow instances.
- `src/agents/salesforcePdf/quotePdfWorkflow.ts`: Quote PDF validation, rendering, and attachment.
- `src/agents/salesforcePdf/dealReviewPackWorkflow.ts`: Deal Review Pack validation, rendering,
  optional AI review notes, and attachment.
- `src/integrations/pdf/`: pdfme generation service and default templates.
- `src/integrations/salesforce/gateway.ts`: Salesforce REST queries and Files creation.
- `src/domain/salesforcePdfWorkflows.ts`: shared settings and template metadata schemas.

## Configuration Prerequisites

The app process needs the Salesforce OAuth runtime and PostgreSQL repositories configured:

```bash
DATABASE_URL=postgresql://...
SALESFORCE_OAUTH_REDIRECT_BASE_URL=https://...
SALESFORCE_OAUTH_CONTEXT_SIGNING_SECRET=...
SALESFORCE_TOKEN_ENCRYPTION_KEY=...
```

`SALESFORCE_OAUTH_CALLBACK_PATH`, `SALESFORCE_OAUTH_START_PATH`, and
`SALESFORCE_OAUTH_DISCONNECT_PATH` can be overridden when the deployed routes need non-default
paths.

Run the TypeScript migrations before enabling the workflows:

```bash
vp run migrate
```

The `salesforce_pdf_workflows` migration creates:

- `salesforce_pdf_workflow_settings`: one settings document per
  `team_id + salesforce_org_id + action`.
- `salesforce_pdf_templates`: template metadata per `team_id + salesforce_org_id + template_id`.

Salesforce workspace OAuth client configuration remains in `salesforce_auth_configs`. User
connections and encrypted tokens remain in the Salesforce OAuth connection repository.

## Salesforce OAuth And Permissions

The Salesforce OAuth flow requests the app scopes defined by the runtime:

- `api`
- `refresh_token`
- `id`

The scopes make API access and refresh possible, but they do not replace Salesforce object,
field, sharing, or Files permissions. The connected Salesforce user must be allowed to:

- read the source records and fields used by the workflow.
- read related records used by default mappings, such as `Quote.Opportunity` and
  `QuoteLineItem`.
- create `ContentVersion` records when attaching PDFs.
- create `ContentDocumentLink` records when linking one generated file to additional Salesforce
  records.
- access the target records chosen by the workflow attachment policy.

If a workspace uses multiple Salesforce orgs, each org needs its own active
`salesforce_auth_configs` row and its own workflow settings. A single Slack user can connect to
multiple configured orgs, but workflow policy is still scoped by Salesforce org.

## Slack Admin Enablement

Slack workspace admins and owners configure the workflows from App Home. Non-admin users cannot
save Salesforce PDF workflow settings.

The settings are scoped by:

- `team_id`: Slack workspace.
- `salesforce_org_id`: Salesforce org.
- `action`: `quote_pdf` or `deal_review_pack`.

For each action, an admin chooses whether it is enabled. Disabled or missing settings fail closed,
even when the Salesforce user is connected and the agent model attempts to call the tool.

Supported settings:

- `enabled`: enables the workflow for the selected org and action.
- `template_id`: pdfme template ID to render.
- `attach_to`: Salesforce Files target policy.
- `require_confirmation_before_attach`: requires Slack confirmation before Salesforce Files writes.
- `allowed_stages`: allowed Opportunity stages.
- `allowed_statuses`: allowed Quote or configured status values.
- `allowed_approval_statuses`: allowed Deal Review Pack approval values.
- `approval_status_field`: Salesforce field path used for Deal Review Pack approval status.
- `required_fields`: Salesforce field paths that must be non-blank.
- `allowed_record_type_ids`: allowed record type IDs.
- `allowed_record_type_names`: allowed record type names.
- `record_type_field`: Salesforce field path used for record type ID checks.
- `field_mapping`: JSON map from PDF input names to Salesforce field paths.
- `include_ai_summary`: reserved for replacing deterministic Deal Review Pack review notes with an
  AI-generated narrative after Salesforce policy validation passes. The default runtime currently
  does not inject a narrative generator, so this setting has no effect until one is wired.

`slack_channel_allowlist` and `slack_user_group_allowlist` exist in the settings schema for future
Slack surface policy, but current enforcement is at workspace admin enablement, Salesforce org, and
workflow policy level.

## Templates And Field Mapping

The runtime currently registers two default pdfme templates:

- `quote_v1`
- `deal_review_pack_v1`

`quote_v1` expects:

- `accountName`
- `generatedAt`
- `lineItems`
- `opportunityName`
- `quoteName`
- `quoteNumber`
- `sourceRecordId`
- `totalAmount`

`deal_review_pack_v1` expects:

- `accountName`
- `amount`
- `closeDate`
- `generatedAt`
- `nextStep`
- `opportunityName`
- `ownerName`
- `reviewNotes`
- `sourceRecordId`
- `stageName`

`field_mapping` overrides the Salesforce field path used to populate a PDF input. Use Salesforce
field API names and relationship paths, for example:

```json
{
  "accountName": "Account.Name",
  "amount": "Amount",
  "ownerName": "Owner.Name",
  "reviewNotes": "NextStep"
}
```

Field paths are used in SOQL query construction and record reads. Configure them deliberately and
prefer stable API names over labels.

Quote line items are read from `QuoteLineItem` and rendered up to the workflow limit. Quotes with
more line items fail instead of generating a truncated official-looking quote.

## Attachment Behavior

AI tool calls always run the workflows in preview mode. A prompt-level request such as "attach this
to Salesforce" does not directly write a file into Salesforce, and the current agent-tool surface
returns that confirmation is required instead of calling `attach_confirmed`.

Salesforce Files writes happen only through `attach_confirmed`, after the app has explicit Slack
confirmation. A Slack confirmation handler that invokes `attach_confirmed` must be wired before
attachment is enabled on a Slack surface. In that mode the workflow:

1. reloads settings.
2. re-fetches the Salesforce record.
3. re-validates policy.
4. renders the PDF again.
5. creates a `ContentVersion` with `FirstPublishLocationId`.
6. creates additional `ContentDocumentLink` rows when the policy links one file to more than one
   Salesforce record.

`quote_pdf` supports these `attach_to` values:

- `source_record`: attach to the Quote.
- `quote`: attach to the Quote.
- `opportunity`: attach to the related Opportunity.
- `both`: attach to the Quote first, then link the same file to the related Opportunity.

`deal_review_pack` supports:

- `source_record`: attach to the Opportunity.
- `opportunity`: attach to the Opportunity.

`deal_review_pack` rejects `quote` and `both` as invalid attachment targets.

When a primary `ContentVersion` creation succeeds but an additional `ContentDocumentLink` fails,
the workflow returns partial success with the created Salesforce identifiers so operators can audit
the file that was already created.

## Troubleshooting

`missing_salesforce_connection` or `salesforce_reconnect_required`
: The Slack user has not connected Salesforce for the org, or Salesforce revoked or invalidated the
refresh token. Reconnect from App Home.

`missing_settings`
: No settings exist for the Slack workspace, Salesforce org, and workflow action. A Slack admin or
owner must configure that org/action pair.

`disabled`
: Settings exist, but the workflow is off. A Slack admin or owner must enable it.

`invalid_settings`
: The stored settings payload does not match `salesforcePdfWorkflowSettingsSchema`, or the template
ID is not available in the runtime registry. Re-save settings and verify the template ID.

`quote_not_found` / `opportunity_not_found`
: The connected Salesforce user cannot find a matching record. Use a record ID when names or quote
numbers are ambiguous, and confirm object sharing permissions.

`ambiguous_quote` / `ambiguous_opportunity`
: More than one Salesforce record matched the request. Use the Salesforce record ID.

`disallowed_stage`, `disallowed_status`, `approval_not_satisfied`, or `disallowed_record_type`
: The record violates the org-specific workflow policy. Move the Salesforce record to an allowed
state or update the Slack-admin workflow settings.

`missing_required_fields`
: One or more configured Salesforce fields are blank. Populate the Salesforce data or remove the
field from the required list.

`too_many_line_items`
: The Quote has more line items than the renderer limit. Use the official quote-generation system or
narrow the Quote data before generating.

`render_failed`
: pdfme could not render the selected template with the prepared input. Check `template_id`,
template input names, field mapping, and text lengths.

`attach_failed`
: Salesforce Files creation or linking failed. Check the connected user's `ContentVersion`,
`ContentDocumentLink`, Files, and target-record permissions. If the result says partial success,
audit the returned `ContentVersionId` or `ContentDocumentId` before retrying.

## Rollout Checklist

1. Deploy code and run `vp run migrate`.
2. Configure Salesforce OAuth routes and connected-app redirect URI.
3. Add or verify `salesforce_auth_configs` rows for each workspace/org pair.
4. Confirm the Salesforce connected user can read the relevant objects and fields.
5. Confirm the Salesforce connected user can create Salesforce Files on the target records.
6. Connect Salesforce from Slack App Home for each user/org that will run the workflow.
7. Have a Slack workspace admin enable `quote_pdf` and/or `deal_review_pack` for each org.
8. Generate preview PDFs in Slack.
9. Wire and exercise the explicit attachment confirmation path in a sandbox or staging org before
   production attachment is enabled.
