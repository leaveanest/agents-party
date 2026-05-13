import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  SlackEventMiddlewareArgs,
  SlackViewMiddlewareArgs,
  StringIndexed,
} from "@slack/bolt";

import {
  AgentRunnerExecutionError,
  type AgentRunner,
  type AgentRunnerResult,
} from "../agents/runner.js";
import { agentSpecialistSchema, type AgentSpecialist } from "../agents/schemas.js";
import type { JsonValue } from "../domain/messageHistory.js";
import type { CredentialProviderKind } from "../providers/credentials.js";
import {
  salesforceAuthConfigSchema,
  salesforceConnectionSchema,
} from "../integrations/oauth/domain.js";
import {
  salesforcePdfAttachTargetSchema,
  salesforcePdfWorkflowActionLabel,
  salesforcePdfWorkflowActions,
  salesforcePdfWorkflowSettingsSchema,
  type SalesforcePdfAttachTarget,
  type SalesforcePdfWorkflowAction,
  type SalesforcePdfWorkflowSettings,
} from "../domain/salesforcePdfWorkflows.js";
import type { JsonObject } from "../infrastructure/postgres/jsonDocumentRepository.js";
import type { TranscriptionGateway } from "../providers/transcriptionGateway.js";
import type { SlackAgentJob, SlackAgentJobQueue } from "../queues/slackAgentJobs.js";
import {
  SlackAudioProcessingError,
  hasSlackAudioFiles,
  resolveSlackAudioAttachments,
} from "./audioTranscription.js";
import type { SlackEventFeatureHandlers } from "./events.js";
import { readSlackEventId } from "./idempotency.js";
import {
  SALESFORCE_PDF_WORKFLOW_ALLOWED_STAGES_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_ALLOWED_STAGES_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_ALLOWED_STATUSES_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_ALLOWED_STATUSES_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_APPROVAL_FIELD_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_APPROVAL_FIELD_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_APPROVAL_STATUSES_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_APPROVAL_STATUSES_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_ATTACH_TO_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_ATTACH_TO_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_CONFIGURE_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_CONFIRMATION_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_CONFIRMATION_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_ENABLED_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_MODAL_CALLBACK_ID,
  SALESFORCE_PDF_WORKFLOW_RECORD_TYPES_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_RECORD_TYPES_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_REQUIRED_FIELDS_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_REQUIRED_FIELDS_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_TEMPLATE_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_TEMPLATE_BLOCK_ID,
  WORKSPACE_CREDENTIAL_BASE_URL_ACTION_ID,
  WORKSPACE_CREDENTIAL_BASE_URL_BLOCK_ID,
  WORKSPACE_CREDENTIAL_CONFIGURE_ACTION_ID,
  WORKSPACE_CREDENTIAL_MODAL_CALLBACK_ID,
  WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
  WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID,
  WORKSPACE_CREDENTIAL_SECRET_ACTION_ID,
  WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID,
} from "./interactiveIds.js";

type SlackEventArgs<TEvent extends string> = SlackEventMiddlewareArgs<TEvent> & AllMiddlewareArgs;
type SlackActionArgs = SlackActionMiddlewareArgs & AllMiddlewareArgs;
type SlackViewArgs = SlackViewMiddlewareArgs & AllMiddlewareArgs;
type SlackClient = SlackEventArgs<"app_mention">["client"];
export type SlackAgentClient = Pick<
  SlackClient,
  "chat" | "conversations" | "filesUploadV2" | "token"
>;

const workspaceCredentialProviderKinds = [
  "openai",
  "azure_openai",
  "anthropic",
  "google",
  "google_maps",
  "groq",
  "xai",
  "plamo",
  "nvidia",
  "litellm",
] as const satisfies readonly CredentialProviderKind[];

const workspaceCredentialProviderOptions = [
  { text: { text: "OpenAI", type: "plain_text" }, value: "openai" },
  { text: { text: "Azure OpenAI", type: "plain_text" }, value: "azure_openai" },
  { text: { text: "Anthropic", type: "plain_text" }, value: "anthropic" },
  { text: { text: "Google", type: "plain_text" }, value: "google" },
  { text: { text: "Google Maps", type: "plain_text" }, value: "google_maps" },
  { text: { text: "Groq", type: "plain_text" }, value: "groq" },
  { text: { text: "xAI", type: "plain_text" }, value: "xai" },
  { text: { text: "PLaMo", type: "plain_text" }, value: "plamo" },
  { text: { text: "NVIDIA", type: "plain_text" }, value: "nvidia" },
  { text: { text: "LiteLLM", type: "plain_text" }, value: "litellm" },
] as const satisfies readonly {
  text: { text: string; type: "plain_text" };
  value: CredentialProviderKind;
}[];

export type SlackResolvedAgentRoute = {
  agent: JsonObject;
  agentId: string;
  modelId?: string;
  modelScope?: string;
  scope: string;
};

export type SlackAgentRoutingRepository = {
  activateThreadAgent(input: {
    agentId: string;
    channelId: string;
    lastMessageTs: string;
    modelId?: string;
    rootMessageTs: string;
    teamId: string;
    threadTs: string;
  }): Promise<JsonObject>;
  findSlackThread(
    teamId: string,
    channelId: string,
    threadTs: string,
  ): Promise<JsonObject | undefined>;
  isChannelEnabled(teamId: string, channelId: string): Promise<boolean>;
  isThreadAutoReplyEnabled(teamId: string, channelId: string): Promise<boolean>;
  resolveAgent?(input: {
    channelId: string;
    teamId: string;
    threadTs?: string;
  }): Promise<SlackResolvedAgentRoute | undefined>;
};

export type SalesforceConnectionHomeRepository = {
  listSalesforceAuthConfigs(teamId: string): Promise<JsonObject[]>;
  listSalesforceConnections(teamId: string, slackUserId?: string): Promise<JsonObject[]>;
};

export type SalesforceConnectionHome = {
  buildStartUrl(input: {
    redirectAfterConnect?: string | null;
    salesforceOrgId: string;
    slackUserId: string;
    teamId: string;
  }): string;
  repository: SalesforceConnectionHomeRepository;
};

export type SalesforcePdfWorkflowRepository = {
  findSalesforcePdfWorkflowSetting(
    teamId: string,
    salesforceOrgId: string,
    action: string,
  ): Promise<JsonObject | undefined>;
  listSalesforcePdfWorkflowSettings(
    teamId: string,
    salesforceOrgId?: string,
  ): Promise<JsonObject[]>;
  saveSalesforcePdfWorkflowSetting(document: {
    action: string;
    enabled: boolean;
    payload: JsonObject;
    salesforceOrgId: string;
    teamId: string;
    templateId: string;
    updatedAt: Date;
  }): Promise<void>;
};

export type SalesforcePdfWorkflowHome = {
  repository: SalesforcePdfWorkflowRepository;
};

export type WorkspaceCredentialSettingsHome = {
  saveProviderApiKey(input: {
    createdByUserId?: string;
    payload?: JsonObject;
    providerKind: CredentialProviderKind;
    secret: string;
    teamId: string;
  }): Promise<void>;
};

export type AgentSlackHandlerOptions = {
  agentJobQueue?: SlackAgentJobQueue;
  audioFetchFn?: typeof fetch;
  audioTranscriptionGateway?: TranscriptionGateway;
  routingRepository?: SlackAgentRoutingRepository;
  salesforceConnectionHome?: SalesforceConnectionHome;
  salesforcePdfWorkflowHome?: SalesforcePdfWorkflowHome;
  workspaceCredentialSettings?: WorkspaceCredentialSettingsHome;
};

type SlackAgentJobRetryContext = {
  attempts: number;
  attemptsMade: number;
};

export function createAgentSlackHandlers(
  runner: AgentRunner,
  options: AgentSlackHandlerOptions = {},
): SlackEventFeatureHandlers {
  return {
    async handleAppHomeOpened({ body, client, event, logger }) {
      if (!hasStringField(event, "user")) {
        logger.warn("Ignoring app_home_opened without a Slack user id.");
        return;
      }
      const teamId = readTeamId(body, event);
      const blocks = await buildAppHomeBlocks({
        logger,
        options,
        slackUserId: event.user,
        teamId,
      });
      await client.views.publish({
        user_id: event.user,
        view: {
          blocks: blocks as never,
          type: "home",
        },
      });
    },
    async handleAppMention(args) {
      await handleMention(args, runner, options);
    },
    async handleMessage(args) {
      await handleMessage(args, runner, options);
    },
    async handleReactionAdded(args) {
      await handleReactionAdded(args, runner, options);
    },
    async handleWorkspaceCredentialConfigureAction(args) {
      await handleWorkspaceCredentialConfigureAction(args, options);
    },
    async handleWorkspaceCredentialModalSubmission(args) {
      await handleWorkspaceCredentialModalSubmission(args, options);
    },
    async handleSalesforcePdfWorkflowConfigureAction(args) {
      await handleSalesforcePdfWorkflowConfigureAction(args, options);
    },
    async handleSalesforcePdfWorkflowModalSubmission(args) {
      await handleSalesforcePdfWorkflowModalSubmission(args, options);
    },
  };
}

async function buildAppHomeBlocks(input: {
  logger: SlackEventArgs<"app_home_opened">["logger"];
  options: AgentSlackHandlerOptions;
  slackUserId: string;
  teamId: string | undefined;
}): Promise<Record<string, unknown>[]> {
  const blocks: Record<string, unknown>[] = [
    {
      text: { text: "Party on Slack", type: "plain_text" },
      type: "header",
    },
    {
      text: {
        text: "Mention the app in a channel or thread to talk to the assistant.",
        type: "mrkdwn",
      },
      type: "section",
    },
  ];
  if (input.options.workspaceCredentialSettings !== undefined && input.teamId !== undefined) {
    blocks.push({ type: "divider" });
    blocks.push({
      text: { text: "API keys", type: "plain_text" },
      type: "header",
    });
    blocks.push({
      accessory: {
        action_id: WORKSPACE_CREDENTIAL_CONFIGURE_ACTION_ID,
        text: { text: "Configure", type: "plain_text" },
        type: "button",
      },
      text: {
        text: "Store workspace provider API keys for this Slack workspace.",
        type: "mrkdwn",
      },
      type: "section",
    });
  }
  if (input.options.salesforceConnectionHome === undefined || input.teamId === undefined) {
    return blocks;
  }

  try {
    const { repository } = input.options.salesforceConnectionHome;
    const [rawConfigs, rawConnections, rawWorkflowSettings] = await Promise.all([
      repository.listSalesforceAuthConfigs(input.teamId),
      repository.listSalesforceConnections(input.teamId, input.slackUserId),
      input.options.salesforcePdfWorkflowHome?.repository.listSalesforcePdfWorkflowSettings(
        input.teamId,
      ) ?? Promise.resolve([]),
    ]);
    const configs = rawConfigs.map((config) => salesforceAuthConfigSchema.parse(config));
    const connections = rawConnections.map((connection) =>
      salesforceConnectionSchema.parse(connection),
    );
    const workflowSettings = rawWorkflowSettings
      .map((setting) => salesforcePdfWorkflowSettingsSchema.safeParse(setting))
      .filter((result) => result.success)
      .map((result) => result.data);
    if (configs.length === 0) {
      return blocks;
    }
    blocks.push({ type: "divider" });
    blocks.push({
      text: { text: "Salesforce", type: "plain_text" },
      type: "header",
    });
    for (const config of configs) {
      const connection = connections.find(
        (item) => item.salesforce_org_id === config.salesforce_org_id,
      );
      const status = connection?.connection_status ?? "not_connected";
      const actionLabel = status === "active" ? "Reconnect" : "Connect";
      blocks.push({
        accessory: {
          text: { text: actionLabel, type: "plain_text" },
          type: "button",
          url: input.options.salesforceConnectionHome.buildStartUrl({
            redirectAfterConnect: "/",
            salesforceOrgId: config.salesforce_org_id,
            slackUserId: input.slackUserId,
            teamId: input.teamId,
          }),
        },
        text: {
          text: `*${config.salesforce_org_name ?? config.salesforce_org_id}*\n${salesforceStatusText(
            status,
            connection?.salesforce_username ?? connection?.salesforce_user_email ?? undefined,
          )}`,
          type: "mrkdwn",
        },
        type: "section",
      });
      if (input.options.salesforcePdfWorkflowHome !== undefined) {
        blocks.push(
          ...buildSalesforcePdfWorkflowBlocks(config.salesforce_org_id, workflowSettings),
        );
      }
    }
  } catch (error) {
    input.logger.warn("Failed to load Salesforce App Home connection status.", { error });
  }
  return blocks;
}

function buildSalesforcePdfWorkflowBlocks(
  salesforceOrgId: string,
  settings: readonly SalesforcePdfWorkflowSettings[],
): Record<string, unknown>[] {
  return salesforcePdfWorkflowActions.map((action) => {
    const setting = settings.find(
      (item) => item.salesforce_org_id === salesforceOrgId && item.action === action,
    );
    const enabled = setting?.enabled === true;
    return {
      accessory: {
        action_id: SALESFORCE_PDF_WORKFLOW_CONFIGURE_ACTION_ID,
        text: { text: "Configure", type: "plain_text" },
        type: "button",
        value: JSON.stringify({ action, salesforceOrgId }),
      },
      text: {
        text: `*${salesforcePdfWorkflowActionLabel(action)}*\n${enabled ? "Enabled" : "Disabled"}${
          setting === undefined ? "" : ` - template: ${setting.template_id}`
        }`,
        type: "mrkdwn",
      },
      type: "section",
    };
  });
}

function salesforceStatusText(status: string, accountLabel: string | undefined): string {
  if (status === "active") {
    return accountLabel === undefined ? "Connected" : `Connected as ${accountLabel}`;
  }
  if (status === "expired") {
    return "Reconnect required";
  }
  if (status === "revoked") {
    return "Disconnected";
  }
  if (status === "error") {
    return "Connection needs attention";
  }
  return "Not connected";
}

async function handleWorkspaceCredentialConfigureAction(
  { ack, body, client, logger }: SlackActionArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  await ack();
  const teamId = readTeamId(body, {});
  const slackUserId = readSlackUserId(body);
  const triggerId = isRecord(body) ? readString(body, "trigger_id") : undefined;
  if (teamId === undefined || slackUserId === undefined || triggerId === undefined) {
    logger.warn("Ignoring API key configuration action with missing Slack context.");
    return;
  }
  if (options.workspaceCredentialSettings === undefined) {
    await client.views.open({
      trigger_id: triggerId,
      view: buildWorkspaceCredentialUnavailableModal() as never,
    });
    return;
  }
  await client.views.open({
    trigger_id: triggerId,
    view: buildWorkspaceCredentialModal(teamId) as never,
  });
}

async function handleWorkspaceCredentialModalSubmission(
  { ack, body, client, logger, view }: SlackViewArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  const metadataTeamId = readString(view as unknown as StringIndexed, "private_metadata");
  const bodyTeamId = readTeamId(body, {});
  const teamId = bodyTeamId ?? metadataTeamId;
  const slackUserId = readSlackUserId(body);
  if (options.workspaceCredentialSettings === undefined) {
    await ack({
      errors: {
        [WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID]: "API key storage is not configured.",
      },
      response_action: "errors",
    });
    return;
  }
  if (metadataTeamId !== undefined && bodyTeamId !== undefined && metadataTeamId !== bodyTeamId) {
    await ack({
      errors: {
        [WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID]: "Slack workspace context does not match.",
      },
      response_action: "errors",
    });
    return;
  }
  if (teamId === undefined || slackUserId === undefined) {
    await ack({
      errors: {
        [WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID]: "Slack workspace context is missing.",
      },
      response_action: "errors",
    });
    return;
  }
  const parsed = parseWorkspaceCredentialModal(view);
  if ("errors" in parsed) {
    await ack({
      errors: parsed.errors,
      response_action: "errors",
    });
    return;
  }

  await ack({
    response_action: "update",
    view: buildWorkspaceCredentialSavingModal() as never,
  });

  try {
    if (!(await isWorkspaceAdmin(client, slackUserId, logger))) {
      await updateWorkspaceCredentialModal(
        client,
        view,
        buildWorkspaceCredentialResultModal(
          "API key",
          "Only Slack workspace admins and owners can configure API keys.",
        ),
        logger,
      );
      return;
    }
    await options.workspaceCredentialSettings.saveProviderApiKey({
      createdByUserId: slackUserId,
      payload: {
        ...(parsed.baseURL === undefined ? {} : { base_url: parsed.baseURL }),
        source: "slack_app_home",
      },
      providerKind: parsed.providerKind,
      secret: parsed.apiKey,
      teamId,
    });
    logInfo(logger, "Saved workspace provider API key from Slack modal.", {
      providerKind: parsed.providerKind,
      teamId,
    });
    await updateWorkspaceCredentialModal(
      client,
      view,
      buildWorkspaceCredentialResultModal("API key saved", "The workspace API key was saved."),
      logger,
    );
  } catch (error) {
    logger.error("Failed to save workspace provider API key from Slack modal.", {
      error,
      providerKind: parsed.providerKind,
      teamId,
    });
    await updateWorkspaceCredentialModal(
      client,
      view,
      buildWorkspaceCredentialResultModal(
        "API key",
        "Could not save this API key. Try again later.",
      ),
      logger,
    );
  }
}

async function handleSalesforcePdfWorkflowConfigureAction(
  { ack, body, client, logger }: SlackActionArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  await ack();
  const teamId = readTeamId(body, {});
  const slackUserId = readSlackUserId(body);
  const triggerId = isRecord(body) ? readString(body, "trigger_id") : undefined;
  const actionValue = parseSalesforcePdfWorkflowActionValue(readActionValue(body));
  if (
    teamId === undefined ||
    slackUserId === undefined ||
    triggerId === undefined ||
    actionValue === undefined
  ) {
    logger.warn("Ignoring Salesforce PDF workflow configuration action with missing context.");
    return;
  }
  if (options.salesforcePdfWorkflowHome === undefined) {
    await client.views.open({
      trigger_id: triggerId,
      view: buildSalesforcePdfWorkflowResultModal(
        "Salesforce PDF",
        "Salesforce PDF workflow settings are not configured for this app process.",
      ) as never,
    });
    return;
  }
  if (!(await isWorkspaceAdmin(client, slackUserId, logger))) {
    await client.views.open({
      trigger_id: triggerId,
      view: buildSalesforcePdfWorkflowResultModal(
        "Salesforce PDF",
        "Only Slack workspace admins and owners can configure Salesforce PDF workflows.",
      ) as never,
    });
    return;
  }

  const current =
    await options.salesforcePdfWorkflowHome.repository.findSalesforcePdfWorkflowSetting(
      teamId,
      actionValue.salesforceOrgId,
      actionValue.action,
    );
  const parsedCurrent =
    current === undefined ? undefined : salesforcePdfWorkflowSettingsSchema.safeParse(current);
  await client.views.open({
    trigger_id: triggerId,
    view: buildSalesforcePdfWorkflowModal({
      action: actionValue.action,
      salesforceOrgId: actionValue.salesforceOrgId,
      settings: parsedCurrent?.success === true ? parsedCurrent.data : undefined,
      teamId,
    }) as never,
  });
}

async function handleSalesforcePdfWorkflowModalSubmission(
  { ack, body, client, logger, view }: SlackViewArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  const metadata = parseSalesforcePdfWorkflowModalMetadata(
    readString(view as unknown as StringIndexed, "private_metadata"),
  );
  const bodyTeamId = readTeamId(body, {});
  const slackUserId = readSlackUserId(body);
  if (options.salesforcePdfWorkflowHome === undefined) {
    await ack({
      errors: {
        [SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID]:
          "Salesforce PDF workflow settings are not configured.",
      },
      response_action: "errors",
    });
    return;
  }
  if (
    metadata === undefined ||
    slackUserId === undefined ||
    (bodyTeamId !== undefined && metadata.teamId !== bodyTeamId)
  ) {
    await ack({
      errors: {
        [SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID]: "Slack workspace context is missing.",
      },
      response_action: "errors",
    });
    return;
  }
  const parsed = parseSalesforcePdfWorkflowModal(view);
  if ("errors" in parsed) {
    await ack({
      errors: parsed.errors,
      response_action: "errors",
    });
    return;
  }

  await ack({
    response_action: "update",
    view: buildSalesforcePdfWorkflowResultModal(
      "Salesforce PDF",
      "Saving workflow settings...",
    ) as never,
  });

  try {
    if (!(await isWorkspaceAdmin(client, slackUserId, logger))) {
      await updateSalesforcePdfWorkflowModal(
        client,
        view,
        buildSalesforcePdfWorkflowResultModal(
          "Salesforce PDF",
          "Only Slack workspace admins and owners can configure Salesforce PDF workflows.",
        ),
        logger,
      );
      return;
    }
    const now = new Date();
    const existingPayload =
      await options.salesforcePdfWorkflowHome.repository.findSalesforcePdfWorkflowSetting(
        metadata.teamId,
        metadata.salesforceOrgId,
        metadata.action,
      );
    const existing = parseExistingSalesforcePdfWorkflowSetting(existingPayload);
    const payload = salesforcePdfWorkflowSettingsSchema.parse({
      action: metadata.action,
      allowed_approval_statuses: parsed.allowedApprovalStatuses,
      allowed_record_type_ids: parsed.allowedRecordTypeIds,
      allowed_record_type_names: parsed.allowedRecordTypeNames,
      allowed_stages: parsed.allowedStages,
      allowed_statuses: parsed.allowedStatuses,
      approval_status_field: parsed.approvalStatusField,
      attach_to: parsed.attachTo,
      created_at: existing?.created_at ?? now,
      enabled: parsed.enabled,
      enabled_at:
        parsed.enabled === false
          ? null
          : existing?.enabled === true
            ? (existing.enabled_at ?? now)
            : now,
      enabled_by_slack_user_id:
        parsed.enabled === false
          ? null
          : existing?.enabled === true
            ? (existing.enabled_by_slack_user_id ?? slackUserId)
            : slackUserId,
      field_mapping: parsed.fieldMapping,
      include_ai_summary: parsed.includeAiSummary,
      required_fields: parsed.requiredFields,
      require_confirmation_before_attach: parsed.requireConfirmationBeforeAttach,
      salesforce_org_id: metadata.salesforceOrgId,
      team_id: metadata.teamId,
      template_id: parsed.templateId,
      updated_at: now,
      updated_by_slack_user_id: slackUserId,
    });
    await options.salesforcePdfWorkflowHome.repository.saveSalesforcePdfWorkflowSetting({
      action: payload.action,
      enabled: payload.enabled,
      payload: salesforcePdfWorkflowPayload(payload),
      salesforceOrgId: payload.salesforce_org_id,
      teamId: payload.team_id,
      templateId: payload.template_id,
      updatedAt: payload.updated_at,
    });
    logInfo(logger, "Saved Salesforce PDF workflow settings from Slack modal.", {
      action: payload.action,
      enabled: payload.enabled,
      salesforceOrgId: payload.salesforce_org_id,
      teamId: payload.team_id,
    });
    await updateSalesforcePdfWorkflowModal(
      client,
      view,
      buildSalesforcePdfWorkflowResultModal(
        "Salesforce PDF",
        `${salesforcePdfWorkflowActionLabel(payload.action)} is ${
          payload.enabled ? "enabled" : "disabled"
        } for this Salesforce org.`,
      ),
      logger,
    );
  } catch (error) {
    logger.error("Failed to save Salesforce PDF workflow settings from Slack modal.", {
      error,
      metadata,
    });
    await updateSalesforcePdfWorkflowModal(
      client,
      view,
      buildSalesforcePdfWorkflowResultModal(
        "Salesforce PDF",
        "Could not save these workflow settings. Try again later.",
      ),
      logger,
    );
  }
}

async function handleMention(
  { body, client, context, event, logger }: SlackEventArgs<"app_mention">,
  runner: AgentRunner,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  if (
    !hasStringField(event, "channel") ||
    !hasStringField(event, "user") ||
    !hasStringField(event, "ts")
  ) {
    logger.warn("Ignoring app_mention with missing channel, user, or timestamp.");
    return;
  }
  const teamId = readTeamId(body, event);
  if (teamId === undefined) {
    logger.warn("Ignoring app_mention without a team id.");
    return;
  }

  const threadTs = readString(event, "thread_ts") ?? event.ts;
  if (options.agentJobQueue !== undefined) {
    if (
      options.routingRepository !== undefined &&
      !(await options.routingRepository.isChannelEnabled(teamId, event.channel))
    ) {
      return;
    }
    await enqueueSlackAgentJob({
      body,
      client,
      eventType: "app_mention",
      job: {
        botUserId: context.botUserId,
        channelId: event.channel,
        enterpriseId: readSlackEnterpriseId(body),
        eventId: readSlackEventId(body),
        eventType: "app_mention",
        isEnterpriseInstall: readSlackEnterpriseInstall(body),
        messageTs: event.ts,
        retryNum: readOptionalContextValue(context.retryNum),
        retryReason: readOptionalContextValue(context.retryReason),
        teamId,
        text: stripBotMention(readString(event, "text") ?? "", context.botUserId),
        threadTs,
        userId: event.user,
      },
      logger,
      queue: options.agentJobQueue,
      threadTs,
    });
    return;
  }

  let runnerResult: AgentRunnerResult | undefined;
  let text: string;
  try {
    if (
      options.routingRepository !== undefined &&
      !(await options.routingRepository.isChannelEnabled(teamId, event.channel))
    ) {
      return;
    }
    const route = await resolveSlackAgentRoute(options.routingRepository, {
      channelId: event.channel,
      teamId,
      threadTs,
    });
    if (options.routingRepository?.resolveAgent !== undefined && route === undefined) {
      text = "No agent is configured for this channel or workspace.";
      await client.chat.postMessage({
        channel: event.channel,
        text,
        thread_ts: threadTs,
      });
      return;
    }
    const routedSpecialist = specialistFromRoute(route);
    if (route !== undefined && routedSpecialist === undefined) {
      text = "The configured agent is not runnable. Please check the agent settings.";
      await client.chat.postMessage({
        channel: event.channel,
        text,
        thread_ts: threadTs,
      });
      return;
    }
    const threadMessages = await readThreadMessages(client, event.channel, threadTs);
    const result = await runner.run({
      channelId: event.channel,
      messageTs: event.ts,
      modelId: route?.modelId,
      specialist: routedSpecialist,
      teamId,
      text: stripBotMention(readString(event, "text") ?? "", context.botUserId),
      threadTs,
      transientAttachments: await resolveTransientAudioAttachmentsForInvocation({
        client,
        event,
        messages: threadMessages,
        options,
        teamId,
      }),
      userId: event.user,
      viewerContextChannelIds: [event.channel],
    });
    runnerResult = result;
    text = result.message;
    logAgentRunnerSuccess(logger, {
      channelId: event.channel,
      eventType: "app_mention",
      messageTs: event.ts,
      result,
      teamId,
      threadTs,
    });
    if (options.routingRepository !== undefined) {
      try {
        await options.routingRepository.activateThreadAgent({
          agentId: route?.agentId ?? result.decision.specialist,
          channelId: event.channel,
          lastMessageTs: event.ts,
          modelId: threadScopedModelId(route),
          rootMessageTs: threadTs,
          teamId,
          threadTs,
        });
      } catch (error) {
        logger.warn("Failed to persist Slack thread routing state after app_mention.", {
          error,
          teamId,
          threadTs,
        });
      }
    }
  } catch (error) {
    logger.error("TypeScript AgentRunner failed while handling app_mention.", {
      error,
      ...runnerFailureLogFields(error),
      teamId,
      threadTs,
    });
    text = runnerUserFacingErrorMessage(error);
  }

  await postAgentResult({
    channel: event.channel,
    client,
    logger,
    result: runnerResult,
    text,
    threadTs,
  });
}

async function handleMessage(
  { body, client, context, event, logger }: SlackEventArgs<"message">,
  runner: AgentRunner,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  if (
    !hasStringField(event, "channel") ||
    !hasStringField(event, "user") ||
    !hasStringField(event, "ts")
  ) {
    logger.warn("Ignoring message with missing channel, user, or timestamp.");
    return;
  }
  const teamId = readTeamId(body, event);
  if (teamId === undefined) {
    logger.warn("Ignoring message without a team id.");
    return;
  }
  const threadTs = readString(event, "thread_ts");
  if (!isSupportedFollowUpMessage(event, threadTs) || options.routingRepository === undefined) {
    return;
  }
  if (threadTs === undefined) {
    return;
  }

  const [thread, autoReplyEnabled, channelEnabled] = await Promise.all([
    options.routingRepository.findSlackThread(teamId, event.channel, threadTs),
    options.routingRepository.isThreadAutoReplyEnabled(teamId, event.channel),
    options.routingRepository.isChannelEnabled(teamId, event.channel),
  ]);
  if (!channelEnabled || !autoReplyEnabled || !isActiveThread(thread)) {
    return;
  }

  if (options.agentJobQueue !== undefined) {
    await enqueueSlackAgentJob({
      body,
      client,
      eventType: "message_follow_up",
      job: {
        channelId: event.channel,
        enterpriseId: readSlackEnterpriseId(body),
        eventId: readSlackEventId(body),
        eventType: "message_follow_up",
        isEnterpriseInstall: readSlackEnterpriseInstall(body),
        messageTs: event.ts,
        retryNum: readOptionalContextValue(context.retryNum),
        retryReason: readOptionalContextValue(context.retryReason),
        teamId,
        text: readString(event, "text") ?? "",
        threadTs,
        userId: event.user,
      },
      logger,
      queue: options.agentJobQueue,
      threadTs,
    });
    return;
  }

  let runnerResult: AgentRunnerResult | undefined;
  let text: string;
  try {
    const route = await resolveSlackAgentRoute(options.routingRepository, {
      channelId: event.channel,
      teamId,
      threadTs,
    });
    if (options.routingRepository.resolveAgent !== undefined && route === undefined) {
      return;
    }
    const routedSpecialist = specialistFromRoute(route);
    if (route !== undefined && routedSpecialist === undefined) {
      return;
    }
    const specialist = routedSpecialist ?? stringField(thread, "agent_id");
    const modelId = route === undefined ? stringField(thread, "model_id") : route.modelId;
    const threadMessages = await readThreadMessages(client, event.channel, threadTs);
    const result = await runner.run({
      channelId: event.channel,
      messageTs: event.ts,
      modelId,
      specialist,
      teamId,
      text: readString(event, "text") ?? "",
      threadMessages: readThreadTextMessages(threadMessages),
      threadTs,
      transientAttachments: await resolveTransientAudioAttachmentsForInvocation({
        client,
        event,
        messages: threadMessages,
        options,
        teamId,
      }),
      userId: event.user,
      viewerContextChannelIds: [event.channel],
    });
    runnerResult = result;
    text = result.message;
    logAgentRunnerSuccess(logger, {
      channelId: event.channel,
      eventType: "message_follow_up",
      messageTs: event.ts,
      result,
      teamId,
      threadTs,
    });
    try {
      await options.routingRepository.activateThreadAgent({
        agentId: route?.agentId ?? result.decision.specialist,
        channelId: event.channel,
        lastMessageTs: event.ts,
        modelId: route === undefined ? stringField(thread, "model_id") : threadScopedModelId(route),
        rootMessageTs: stringField(thread, "root_message_ts") ?? threadTs,
        teamId,
        threadTs,
      });
    } catch (error) {
      logger.warn("Failed to persist Slack thread routing state after message follow-up.", {
        error,
        teamId,
        threadTs,
      });
    }
  } catch (error) {
    logger.error("TypeScript AgentRunner failed while handling message follow-up.", {
      error,
      ...runnerFailureLogFields(error),
      teamId,
      threadTs,
    });
    text = runnerUserFacingErrorMessage(error);
  }

  await postAgentResult({
    channel: event.channel,
    client,
    logger,
    result: runnerResult,
    text,
    threadTs,
  });
}

export async function processSlackAgentJob(
  job: SlackAgentJob,
  input: {
    audioFetchFn?: typeof fetch;
    audioTranscriptionGateway?: TranscriptionGateway;
    client: SlackAgentClient;
    logger: unknown;
    retryContext?: SlackAgentJobRetryContext;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
  },
): Promise<void> {
  if (job.eventType === "app_mention") {
    await processAppMentionJob(job, input);
    return;
  }
  await processFollowUpMessageJob(job, input);
}

async function processAppMentionJob(
  job: SlackAgentJob,
  input: {
    audioFetchFn?: typeof fetch;
    audioTranscriptionGateway?: TranscriptionGateway;
    client: SlackAgentClient;
    logger: unknown;
    retryContext?: SlackAgentJobRetryContext;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
  },
): Promise<void> {
  if (
    input.routingRepository !== undefined &&
    !(await input.routingRepository.isChannelEnabled(job.teamId, job.channelId))
  ) {
    return;
  }

  let runnerResult: AgentRunnerResult | undefined;
  let text: string;
  try {
    const route = await resolveSlackAgentRoute(input.routingRepository, {
      channelId: job.channelId,
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    if (input.routingRepository?.resolveAgent !== undefined && route === undefined) {
      await input.client.chat.postMessage({
        channel: job.channelId,
        text: "No agent is configured for this channel or workspace.",
        thread_ts: job.threadTs,
      });
      return;
    }
    const routedSpecialist = specialistFromRoute(route);
    if (route !== undefined && routedSpecialist === undefined) {
      await input.client.chat.postMessage({
        channel: job.channelId,
        text: "The configured agent is not runnable. Please check the agent settings.",
        thread_ts: job.threadTs,
      });
      return;
    }
    const threadMessages = await readThreadMessages(input.client, job.channelId, job.threadTs);
    const result = await input.runner.run({
      channelId: job.channelId,
      messageTs: job.messageTs,
      modelId: route?.modelId,
      specialist: routedSpecialist,
      teamId: job.teamId,
      text: job.text,
      threadTs: job.threadTs,
      transientAttachments: await resolveTransientAudioAttachmentsForInvocation({
        client: input.client,
        messages: threadMessages,
        options: input,
        teamId: job.teamId,
      }),
      userId: job.userId,
      viewerContextChannelIds: [job.channelId],
    });
    runnerResult = result;
    text = result.message;
    logAgentRunnerSuccess(input.logger, {
      channelId: job.channelId,
      eventType: "app_mention",
      messageTs: job.messageTs,
      result,
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    if (input.routingRepository !== undefined) {
      try {
        await input.routingRepository.activateThreadAgent({
          agentId: route?.agentId ?? result.decision.specialist,
          channelId: job.channelId,
          lastMessageTs: job.messageTs,
          modelId: threadScopedModelId(route),
          rootMessageTs: job.threadTs,
          teamId: job.teamId,
          threadTs: job.threadTs,
        });
      } catch (error) {
        logWarn(input.logger, "Failed to persist Slack thread routing state after app_mention.", {
          error,
          teamId: job.teamId,
          threadTs: job.threadTs,
        });
      }
    }
  } catch (error) {
    logError(input.logger, "TypeScript AgentRunner failed while handling app_mention.", {
      error,
      ...runnerFailureLogFields(error),
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    if (shouldRetryJobFailure(input.retryContext)) {
      throw error;
    }
    text = runnerUserFacingErrorMessage(error);
  }

  await postAgentResult({
    channel: job.channelId,
    client: input.client,
    logger: input.logger,
    result: runnerResult,
    text,
    threadTs: job.threadTs,
  });
}

async function processFollowUpMessageJob(
  job: SlackAgentJob,
  input: {
    audioFetchFn?: typeof fetch;
    audioTranscriptionGateway?: TranscriptionGateway;
    client: SlackAgentClient;
    logger: unknown;
    retryContext?: SlackAgentJobRetryContext;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
  },
): Promise<void> {
  if (input.routingRepository === undefined) {
    return;
  }
  const [thread, autoReplyEnabled, channelEnabled] = await Promise.all([
    input.routingRepository.findSlackThread(job.teamId, job.channelId, job.threadTs),
    input.routingRepository.isThreadAutoReplyEnabled(job.teamId, job.channelId),
    input.routingRepository.isChannelEnabled(job.teamId, job.channelId),
  ]);
  if (!channelEnabled || !autoReplyEnabled || !isActiveThread(thread)) {
    return;
  }

  let runnerResult: AgentRunnerResult | undefined;
  let text: string;
  try {
    const route = await resolveSlackAgentRoute(input.routingRepository, {
      channelId: job.channelId,
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    if (input.routingRepository.resolveAgent !== undefined && route === undefined) {
      return;
    }
    const routedSpecialist = specialistFromRoute(route);
    if (route !== undefined && routedSpecialist === undefined) {
      return;
    }
    const specialist = routedSpecialist ?? stringField(thread, "agent_id");
    const modelId = route === undefined ? stringField(thread, "model_id") : route.modelId;
    const threadMessages = await readThreadMessages(input.client, job.channelId, job.threadTs);
    const result = await input.runner.run({
      channelId: job.channelId,
      messageTs: job.messageTs,
      modelId,
      specialist,
      teamId: job.teamId,
      text: job.text,
      threadMessages: readThreadTextMessages(threadMessages),
      threadTs: job.threadTs,
      transientAttachments: await resolveTransientAudioAttachmentsForInvocation({
        client: input.client,
        messages: threadMessages,
        options: input,
        teamId: job.teamId,
      }),
      userId: job.userId,
      viewerContextChannelIds: [job.channelId],
    });
    runnerResult = result;
    text = result.message;
    logAgentRunnerSuccess(input.logger, {
      channelId: job.channelId,
      eventType: "message_follow_up",
      messageTs: job.messageTs,
      result,
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    try {
      await input.routingRepository.activateThreadAgent({
        agentId: route?.agentId ?? result.decision.specialist,
        channelId: job.channelId,
        lastMessageTs: job.messageTs,
        modelId: route === undefined ? stringField(thread, "model_id") : threadScopedModelId(route),
        rootMessageTs: stringField(thread, "root_message_ts") ?? job.threadTs,
        teamId: job.teamId,
        threadTs: job.threadTs,
      });
    } catch (error) {
      logWarn(
        input.logger,
        "Failed to persist Slack thread routing state after message follow-up.",
        {
          error,
          teamId: job.teamId,
          threadTs: job.threadTs,
        },
      );
    }
  } catch (error) {
    logError(input.logger, "TypeScript AgentRunner failed while handling message follow-up.", {
      error,
      ...runnerFailureLogFields(error),
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    if (shouldRetryJobFailure(input.retryContext)) {
      throw error;
    }
    text = runnerUserFacingErrorMessage(error);
  }

  await postAgentResult({
    channel: job.channelId,
    client: input.client,
    logger: input.logger,
    result: runnerResult,
    text,
    threadTs: job.threadTs,
  });
}

async function enqueueSlackAgentJob(input: {
  body: unknown;
  client: SlackAgentClient;
  eventType: SlackAgentJob["eventType"];
  job: SlackAgentJob;
  logger: unknown;
  queue: SlackAgentJobQueue;
  threadTs: string;
}): Promise<void> {
  try {
    const result = await input.queue.enqueue(input.job);
    logInfo(input.logger, "Queued Slack agent job.", {
      deduplicated: result.deduplicated,
      eventId: readSlackEventId(input.body),
      eventType: input.eventType,
      jobId: result.jobId,
      teamId: input.job.teamId,
      threadTs: input.threadTs,
    });
  } catch (error) {
    logError(input.logger, "Failed to queue Slack agent job.", {
      error,
      eventId: readSlackEventId(input.body),
      eventType: input.eventType,
      teamId: input.job.teamId,
      threadTs: input.threadTs,
    });
    await input.client.chat.postMessage({
      channel: input.job.channelId,
      text: "I couldn't queue that request. Please try again in a moment.",
      thread_ts: input.threadTs,
    });
  }
}

async function handleReactionAdded(
  { body, client, event, logger }: SlackEventArgs<"reaction_added">,
  runner: AgentRunner,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  const targetLanguage = resolveTranslationLanguageFromReaction(readString(event, "reaction"));
  if (targetLanguage === undefined) {
    return;
  }
  const teamId = readTeamId(body, event);
  const item = event.item;
  if (teamId === undefined || !isRecord(item) || item.type !== "message") {
    return;
  }
  const channelId = typeof item.channel === "string" ? item.channel : undefined;
  const messageTs = typeof item.ts === "string" ? item.ts : undefined;
  if (channelId === undefined || messageTs === undefined) {
    return;
  }
  if (options.routingRepository === undefined) {
    return;
  }
  if (!(await options.routingRepository.isChannelEnabled(teamId, channelId))) {
    return;
  }

  let sourceText: string | undefined;
  let threadTs = messageTs;
  try {
    const sourceMessage = await fetchSingleMessage(client, channelId, messageTs);
    sourceText = readString(sourceMessage, "text");
    threadTs = readString(sourceMessage, "thread_ts") ?? messageTs;
  } catch (error) {
    logger.warn("Could not fetch source message for translation reaction.", {
      error,
      teamId,
      threadTs,
    });
  }

  let text: string;
  try {
    const route = await resolveSlackAgentRoute(options.routingRepository, {
      channelId,
      teamId,
      threadTs,
    });
    if (options.routingRepository.resolveAgent !== undefined && route === undefined) {
      return;
    }
    const routedSpecialist = specialistFromRoute(route);
    if (route !== undefined && routedSpecialist !== "translation") {
      return;
    }
    if (sourceText === undefined || sourceText.trim() === "") {
      await client.chat.postMessage({
        channel: channelId,
        text: "I couldn't read text from the reacted message.",
        thread_ts: threadTs,
      });
      return;
    }
    const result = await runner.run({
      channelId,
      messageTs,
      modelId: route?.modelId,
      specialist: "translation",
      teamId,
      text: `Translate the following Slack message to ${targetLanguage}:\n\n${sourceText}`,
      threadTs,
      userId: readString(event, "user") ?? "unknown",
      viewerContextChannelIds: [channelId],
    });
    text = result.message;
    logAgentRunnerSuccess(logger, {
      channelId,
      eventType: "reaction_added",
      messageTs,
      result,
      teamId,
      threadTs,
    });
  } catch (error) {
    logger.error("TypeScript AgentRunner failed while handling translation reaction.", {
      error,
      ...runnerFailureLogFields(error),
      teamId,
      threadTs,
    });
    text = "I couldn't translate that message. Please try again in a moment.";
  }

  await client.chat.postMessage({
    channel: channelId,
    text,
    thread_ts: threadTs,
  });
}

function readTeamId(body: unknown, event: StringIndexed): string | undefined {
  if (isRecord(body)) {
    if (typeof body.team_id === "string") {
      return body.team_id;
    }
    if (typeof body.team === "string") {
      return body.team;
    }
    if (isRecord(body.team) && typeof body.team.id === "string") {
      return body.team.id;
    }
    if (isRecord(body.user) && typeof body.user.team_id === "string") {
      return body.user.team_id;
    }
  }
  return readString(event, "team");
}

function isSupportedFollowUpMessage(event: StringIndexed, threadTs: string | undefined): boolean {
  if (typeof event.bot_id === "string") {
    return false;
  }
  if (isRecord(event.bot_profile)) {
    return false;
  }
  const subtype = readString(event, "subtype");
  if (subtype !== undefined) {
    return false;
  }
  if (threadTs === undefined || threadTs === event.ts) {
    return false;
  }
  return (readString(event, "text") ?? "").trim() !== "" || hasSlackAudioFiles(event);
}

async function readThreadMessages(
  client: SlackAgentClient,
  channelId: string,
  threadTs: string,
): Promise<StringIndexed[]> {
  try {
    const response = await client.conversations.replies({
      channel: channelId,
      limit: 20,
      ts: threadTs,
    });
    const messages = Array.isArray(response.messages) ? response.messages : [];
    return messages.filter((message): message is StringIndexed => isRecord(message));
  } catch {
    return [];
  }
}

function readThreadTextMessages(messages: readonly StringIndexed[]): string[] {
  return messages
    .map((message) => readString(message, "text"))
    .filter((text): text is string => text !== undefined);
}

async function resolveTransientAudioAttachmentsForInvocation(input: {
  client: SlackAgentClient;
  event?: StringIndexed;
  messages: readonly StringIndexed[];
  options: {
    audioFetchFn?: typeof fetch;
    audioTranscriptionGateway?: TranscriptionGateway;
  };
  teamId: string;
}) {
  const messages = mergeSlackMessages(input.messages, input.event);
  return resolveSlackAudioAttachments({
    clientToken: input.client.token,
    fetchFn: input.options.audioFetchFn,
    messages,
    teamId: input.teamId,
    transcriptionGateway: input.options.audioTranscriptionGateway,
  });
}

function mergeSlackMessages(
  messages: readonly StringIndexed[],
  event: StringIndexed | undefined,
): StringIndexed[] {
  const merged = [...messages];
  const fallbackTs = event === undefined ? undefined : readString(event, "ts");
  const hasFallback =
    fallbackTs !== undefined && merged.some((message) => readString(message, "ts") === fallbackTs);
  if (event !== undefined && (!hasFallback || hasSlackAudioFiles(event))) {
    merged.push(event);
  }
  return merged;
}

function runnerUserFacingErrorMessage(error: unknown): string {
  if (error instanceof SlackAudioProcessingError) {
    return error.message;
  }
  return "I couldn't complete that request. Please try again in a moment.";
}

export async function postAgentResult(input: {
  channel: string;
  client: SlackAgentClient;
  logger: unknown;
  result: AgentRunnerResult | undefined;
  text: string;
  threadTs: string;
}): Promise<void> {
  const media = readGeneratedMedia(input.result?.structuredResult);
  if (media?.dataBase64 !== undefined) {
    await input.client.filesUploadV2({
      channel_id: input.channel,
      file: Buffer.from(media.dataBase64, "base64"),
      filename: mediaFilename(media),
      initial_comment: input.text,
      thread_ts: input.threadTs,
    });
    logInfo(input.logger, "Delivered generated media to Slack.", {
      channelId: input.channel,
      delivery: "file_upload",
      mediaKind: media.kind,
      threadTs: input.threadTs,
    });
    return;
  }

  const suffix = media?.uri ?? media?.operationName;
  await input.client.chat.postMessage({
    channel: input.channel,
    text: suffix === undefined ? input.text : `${input.text}\n${suffix}`,
    thread_ts: input.threadTs,
  });
  if (suffix !== undefined) {
    logInfo(input.logger, "Delivered generated media handoff to Slack.", {
      channelId: input.channel,
      delivery: media?.uri === undefined ? "operation" : "uri",
      mediaKind: media?.kind,
      threadTs: input.threadTs,
    });
  }
}

function logAgentRunnerSuccess(
  logger: unknown,
  input: {
    channelId: string;
    eventType: "app_mention" | "message_follow_up" | "reaction_added";
    messageTs: string;
    result: AgentRunnerResult;
    teamId: string;
    threadTs: string;
  },
): void {
  const media = readGeneratedMedia(input.result.structuredResult);
  logInfo(logger, "TypeScript AgentRunner completed Slack event.", {
    channelId: input.channelId,
    eventType: input.eventType,
    hasStructuredResult: input.result.structuredResult !== undefined,
    mediaKind: media?.kind,
    messageTs: input.messageTs,
    modelId: input.result.model?.id,
    provider: input.result.model?.provider,
    specialist: input.result.decision.specialist,
    teamId: input.teamId,
    threadTs: input.threadTs,
    toolResultCount: input.result.toolResults.length,
  });
}

function logInfo(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.info === "function") {
    logger.info(message, metadata);
  }
}

function logWarn(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.warn === "function") {
    logger.warn(message, metadata);
  }
}

function logError(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.error === "function") {
    logger.error(message, metadata);
  }
}

function runnerFailureLogFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof AgentRunnerExecutionError)) {
    return {};
  }
  return {
    modelId: error.model?.id,
    provider: error.model?.provider,
    specialist: error.specialist,
  };
}

function shouldRetryJobFailure(context: SlackAgentJobRetryContext | undefined): boolean {
  if (context === undefined) {
    return false;
  }
  return context.attemptsMade + 1 < context.attempts;
}

function readGeneratedMedia(value: JsonValue | undefined): GeneratedSlackMedia | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const media = value.media;
  if (!isRecord(media)) {
    return undefined;
  }
  if (media.kind !== "image" && media.kind !== "video") {
    return undefined;
  }
  return {
    dataBase64: readOptionalString(media.dataBase64),
    kind: media.kind,
    mimeType: readOptionalString(media.mimeType),
    operationName: readOptionalString(media.operationName),
    uri: readOptionalString(media.uri),
  };
}

type GeneratedSlackMedia = {
  dataBase64?: string;
  kind: "image" | "video";
  mimeType?: string;
  operationName?: string;
  uri?: string;
};

function mediaFilename(media: GeneratedSlackMedia): string {
  const extension = mediaExtension(media);
  return `generated-${media.kind}.${extension}`;
}

function mediaExtension(media: GeneratedSlackMedia): string {
  if (media.mimeType === "image/jpeg") {
    return "jpg";
  }
  if (media.mimeType === "image/webp") {
    return "webp";
  }
  if (media.mimeType === "video/mp4") {
    return "mp4";
  }
  return media.kind === "image" ? "png" : "mp4";
}

async function fetchSingleMessage(
  client: SlackEventArgs<"reaction_added">["client"],
  channelId: string,
  messageTs: string,
): Promise<StringIndexed> {
  const response = await client.conversations.history({
    channel: channelId,
    inclusive: true,
    latest: messageTs,
    limit: 1,
    oldest: messageTs,
  });
  const messages = Array.isArray(response.messages) ? response.messages : [];
  const message = messages[0];
  if (!isRecord(message)) {
    throw new Error("Slack history response did not contain a message.");
  }
  return message;
}

function buildWorkspaceCredentialModal(teamId: string): Record<string, unknown> {
  return {
    callback_id: WORKSPACE_CREDENTIAL_MODAL_CALLBACK_ID,
    private_metadata: teamId,
    submit: { text: "Save", type: "plain_text" },
    title: { text: "API key", type: "plain_text" },
    type: "modal",
    blocks: [
      {
        block_id: WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID,
        element: {
          action_id: WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
          initial_option: workspaceCredentialProviderOptions[0],
          options: workspaceCredentialProviderOptions,
          type: "static_select",
        },
        label: { text: "Provider", type: "plain_text" },
        type: "input",
      },
      {
        block_id: WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID,
        element: {
          action_id: WORKSPACE_CREDENTIAL_SECRET_ACTION_ID,
          type: "plain_text_input",
        },
        label: { text: "API key", type: "plain_text" },
        type: "input",
      },
      {
        block_id: WORKSPACE_CREDENTIAL_BASE_URL_BLOCK_ID,
        element: {
          action_id: WORKSPACE_CREDENTIAL_BASE_URL_ACTION_ID,
          placeholder: { text: "https://proxy.example/v1", type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: "Base URL", type: "plain_text" },
        optional: true,
        type: "input",
      },
    ],
  };
}

function buildWorkspaceCredentialSavingModal(): Record<string, unknown> {
  return buildWorkspaceCredentialResultModal("API key", "Saving API key...");
}

function buildWorkspaceCredentialResultModal(title: string, text: string): Record<string, unknown> {
  return {
    close: { text: "Close", type: "plain_text" },
    title: { text: title, type: "plain_text" },
    type: "modal",
    blocks: [
      {
        text: {
          text,
          type: "mrkdwn",
        },
        type: "section",
      },
    ],
  };
}

function buildWorkspaceCredentialUnavailableModal(): Record<string, unknown> {
  return {
    close: { text: "Close", type: "plain_text" },
    title: { text: "API key", type: "plain_text" },
    type: "modal",
    blocks: [
      {
        text: {
          text: "API key storage is not configured for this app process.",
          type: "mrkdwn",
        },
        type: "section",
      },
    ],
  };
}

const salesforcePdfWorkflowEnabledOptions = [
  { text: { text: "Disabled", type: "plain_text" }, value: "false" },
  { text: { text: "Enabled", type: "plain_text" }, value: "true" },
] as const;

const salesforcePdfWorkflowAttachTargetOptions = [
  { text: { text: "Source record", type: "plain_text" }, value: "source_record" },
  { text: { text: "Quote", type: "plain_text" }, value: "quote" },
  { text: { text: "Opportunity", type: "plain_text" }, value: "opportunity" },
  { text: { text: "Quote and Opportunity", type: "plain_text" }, value: "both" },
] as const;

const salesforcePdfWorkflowConfirmationOptions = [
  { text: { text: "Require confirmation", type: "plain_text" }, value: "true" },
  { text: { text: "Do not require confirmation", type: "plain_text" }, value: "false" },
] as const;

const salesforcePdfWorkflowAiSummaryOptions = [
  { text: { text: "AI summary off", type: "plain_text" }, value: "false" },
  { text: { text: "AI summary on", type: "plain_text" }, value: "true" },
] as const;

function buildSalesforcePdfWorkflowModal(input: {
  action: SalesforcePdfWorkflowAction;
  salesforceOrgId: string;
  settings?: SalesforcePdfWorkflowSettings;
  teamId: string;
}): Record<string, unknown> {
  const settings = input.settings;
  const enabledOption = salesforcePdfWorkflowEnabledOptions.find(
    (option) => option.value === String(settings?.enabled === true),
  );
  const attachTo = settings?.attach_to ?? "source_record";
  const attachOption = salesforcePdfWorkflowAttachTargetOptions.find(
    (option) => option.value === attachTo,
  );
  const confirmationOption = salesforcePdfWorkflowConfirmationOptions.find(
    (option) => option.value === String(settings?.require_confirmation_before_attach !== false),
  );
  const aiSummaryOption = salesforcePdfWorkflowAiSummaryOptions.find(
    (option) => option.value === String(settings?.include_ai_summary === true),
  );
  return {
    callback_id: SALESFORCE_PDF_WORKFLOW_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({
      action: input.action,
      salesforceOrgId: input.salesforceOrgId,
      teamId: input.teamId,
    }),
    submit: { text: "Save", type: "plain_text" },
    title: { text: "Salesforce PDF", type: "plain_text" },
    type: "modal",
    blocks: [
      {
        block_id: SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_ENABLED_ACTION_ID,
          initial_option: enabledOption ?? salesforcePdfWorkflowEnabledOptions[0],
          options: salesforcePdfWorkflowEnabledOptions,
          type: "static_select",
        },
        label: { text: salesforcePdfWorkflowActionLabel(input.action), type: "plain_text" },
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_TEMPLATE_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_TEMPLATE_ACTION_ID,
          initial_value: settings?.template_id,
          placeholder: { text: `${input.action}_v1`, type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: "Template ID", type: "plain_text" },
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_ALLOWED_STAGES_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_ALLOWED_STAGES_ACTION_ID,
          initial_value: settings?.allowed_stages.join(", "),
          placeholder: { text: "Proposal, Negotiation", type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: "Allowed stages", type: "plain_text" },
        optional: true,
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_ALLOWED_STATUSES_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_ALLOWED_STATUSES_ACTION_ID,
          initial_value: settings?.allowed_statuses.join(", "),
          placeholder: { text: "Approved, Presented", type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: "Allowed statuses", type: "plain_text" },
        optional: true,
        type: "input",
      },
      ...(input.action === "deal_review_pack"
        ? [
            {
              block_id: SALESFORCE_PDF_WORKFLOW_APPROVAL_FIELD_BLOCK_ID,
              element: {
                action_id: SALESFORCE_PDF_WORKFLOW_APPROVAL_FIELD_ACTION_ID,
                initial_value: settings?.approval_status_field ?? undefined,
                placeholder: { text: "Approval_Status__c", type: "plain_text" },
                type: "plain_text_input",
              },
              label: { text: "Approval status field", type: "plain_text" },
              optional: true,
              type: "input",
            },
            {
              block_id: SALESFORCE_PDF_WORKFLOW_APPROVAL_STATUSES_BLOCK_ID,
              element: {
                action_id: SALESFORCE_PDF_WORKFLOW_APPROVAL_STATUSES_ACTION_ID,
                initial_value: settings?.allowed_approval_statuses.join(", "),
                placeholder: { text: "Approved, Accepted", type: "plain_text" },
                type: "plain_text_input",
              },
              label: { text: "Allowed approval statuses", type: "plain_text" },
              optional: true,
              type: "input",
            },
            {
              block_id: SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_BLOCK_ID,
              element: {
                action_id: SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_ACTION_ID,
                initial_option: aiSummaryOption ?? salesforcePdfWorkflowAiSummaryOptions[0],
                options: salesforcePdfWorkflowAiSummaryOptions,
                type: "static_select",
              },
              label: { text: "AI summary", type: "plain_text" },
              type: "input",
            },
          ]
        : []),
      {
        block_id: SALESFORCE_PDF_WORKFLOW_REQUIRED_FIELDS_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_REQUIRED_FIELDS_ACTION_ID,
          initial_value: settings?.required_fields.join(", "),
          placeholder: { text: "AccountId, Amount, CloseDate", type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: "Required fields", type: "plain_text" },
        optional: true,
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_RECORD_TYPES_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_RECORD_TYPES_ACTION_ID,
          initial_value:
            settings === undefined
              ? undefined
              : [...settings.allowed_record_type_names, ...settings.allowed_record_type_ids].join(
                  ", ",
                ),
          placeholder: { text: "New Business, Renewal", type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: "Allowed RecordTypes", type: "plain_text" },
        optional: true,
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_ATTACH_TO_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_ATTACH_TO_ACTION_ID,
          initial_option: attachOption ?? salesforcePdfWorkflowAttachTargetOptions[0],
          options: salesforcePdfWorkflowAttachTargetOptions,
          type: "static_select",
        },
        label: { text: "Attach to", type: "plain_text" },
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_CONFIRMATION_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_CONFIRMATION_ACTION_ID,
          initial_option: confirmationOption ?? salesforcePdfWorkflowConfirmationOptions[0],
          options: salesforcePdfWorkflowConfirmationOptions,
          type: "static_select",
        },
        label: { text: "Attachment confirmation", type: "plain_text" },
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_ACTION_ID,
          initial_value:
            settings === undefined || Object.keys(settings.field_mapping).length === 0
              ? undefined
              : JSON.stringify(settings.field_mapping, null, 2),
          multiline: true,
          placeholder: { text: '{"customerName":"Account.Name"}', type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: "Field mapping JSON", type: "plain_text" },
        optional: true,
        type: "input",
      },
    ],
  };
}

function buildSalesforcePdfWorkflowResultModal(
  title: string,
  text: string,
): Record<string, unknown> {
  return {
    close: { text: "Close", type: "plain_text" },
    title: { text: title, type: "plain_text" },
    type: "modal",
    blocks: [
      {
        text: {
          text,
          type: "mrkdwn",
        },
        type: "section",
      },
    ],
  };
}

async function updateSalesforcePdfWorkflowModal(
  client: SlackClient,
  view: unknown,
  modal: Record<string, unknown>,
  logger: unknown,
): Promise<void> {
  const viewId = readString(view as unknown as StringIndexed, "id");
  if (viewId === undefined) {
    logWarn(logger, "Could not update Salesforce PDF workflow modal without Slack view id.", {});
    return;
  }
  try {
    await client.views.update({
      view: modal as never,
      view_id: viewId,
    });
  } catch (error) {
    logWarn(logger, "Failed to update Salesforce PDF workflow modal.", { error, viewId });
  }
}

async function updateWorkspaceCredentialModal(
  client: SlackClient,
  view: unknown,
  modal: Record<string, unknown>,
  logger: unknown,
): Promise<void> {
  const viewId = readString(view as unknown as StringIndexed, "id");
  if (viewId === undefined) {
    logWarn(logger, "Could not update API key modal without Slack view id.", {});
    return;
  }
  try {
    await client.views.update({
      view: modal as never,
      view_id: viewId,
    });
  } catch (error) {
    logWarn(logger, "Failed to update API key modal.", { error, viewId });
  }
}

function parseWorkspaceCredentialModal(view: unknown):
  | {
      apiKey: string;
      baseURL?: string;
      providerKind: CredentialProviderKind;
    }
  | { errors: Record<string, string> } {
  const providerValue = readSelectedOptionValue(
    view,
    WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID,
    WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
  );
  const providerKind = parseCredentialProviderKind(providerValue);
  const apiKey = readModalInputValue(
    view,
    WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID,
    WORKSPACE_CREDENTIAL_SECRET_ACTION_ID,
  )?.trim();
  const baseURL = readModalInputValue(
    view,
    WORKSPACE_CREDENTIAL_BASE_URL_BLOCK_ID,
    WORKSPACE_CREDENTIAL_BASE_URL_ACTION_ID,
  )?.trim();
  const errors: Record<string, string> = {};
  if (providerKind === undefined) {
    errors[WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID] = "Choose a supported provider.";
  }
  if (apiKey === undefined || apiKey === "") {
    errors[WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID] = "Enter an API key.";
  }
  if (baseURL !== undefined && baseURL !== "" && !isHttpUrl(baseURL)) {
    errors[WORKSPACE_CREDENTIAL_BASE_URL_BLOCK_ID] = "Enter a valid http or https URL.";
  }
  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  return {
    apiKey: apiKey as string,
    baseURL: baseURL === undefined || baseURL === "" ? undefined : baseURL,
    providerKind: providerKind as CredentialProviderKind,
  };
}

function parseSalesforcePdfWorkflowModal(view: unknown):
  | {
      allowedRecordTypeIds: string[];
      allowedRecordTypeNames: string[];
      allowedApprovalStatuses: string[];
      allowedStages: string[];
      allowedStatuses: string[];
      approvalStatusField: string | null;
      attachTo: SalesforcePdfAttachTarget;
      enabled: boolean;
      fieldMapping: Record<string, string>;
      includeAiSummary: boolean;
      requiredFields: string[];
      requireConfirmationBeforeAttach: boolean;
      templateId: string;
    }
  | { errors: Record<string, string> } {
  const enabled = parseBooleanOption(
    readSelectedOptionValue(
      view,
      SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID,
      SALESFORCE_PDF_WORKFLOW_ENABLED_ACTION_ID,
    ),
  );
  const templateId = readModalInputValue(
    view,
    SALESFORCE_PDF_WORKFLOW_TEMPLATE_BLOCK_ID,
    SALESFORCE_PDF_WORKFLOW_TEMPLATE_ACTION_ID,
  )?.trim();
  const attachToValue = readSelectedOptionValue(
    view,
    SALESFORCE_PDF_WORKFLOW_ATTACH_TO_BLOCK_ID,
    SALESFORCE_PDF_WORKFLOW_ATTACH_TO_ACTION_ID,
  );
  const attachTo = salesforcePdfAttachTargetSchema.safeParse(attachToValue);
  const requireConfirmationBeforeAttach = parseBooleanOption(
    readSelectedOptionValue(
      view,
      SALESFORCE_PDF_WORKFLOW_CONFIRMATION_BLOCK_ID,
      SALESFORCE_PDF_WORKFLOW_CONFIRMATION_ACTION_ID,
    ),
  );
  const includeAiSummary = parseBooleanOption(
    readSelectedOptionValue(
      view,
      SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_BLOCK_ID,
      SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_ACTION_ID,
    ) ?? "false",
  );
  const fieldMapping = parseFieldMapping(
    readModalInputValue(
      view,
      SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_BLOCK_ID,
      SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_ACTION_ID,
    ),
  );
  const errors: Record<string, string> = {};
  if (enabled === undefined) {
    errors[SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID] = "Choose whether this workflow is enabled.";
  }
  if (templateId === undefined || templateId === "") {
    errors[SALESFORCE_PDF_WORKFLOW_TEMPLATE_BLOCK_ID] = "Enter a template ID.";
  }
  if (!attachTo.success) {
    errors[SALESFORCE_PDF_WORKFLOW_ATTACH_TO_BLOCK_ID] = "Choose a supported attachment target.";
  }
  if (requireConfirmationBeforeAttach === undefined) {
    errors[SALESFORCE_PDF_WORKFLOW_CONFIRMATION_BLOCK_ID] =
      "Choose whether attachment confirmation is required.";
  }
  if (includeAiSummary === undefined) {
    errors[SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_BLOCK_ID] = "Choose whether AI summary is enabled.";
  }
  if ("error" in fieldMapping) {
    errors[SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_BLOCK_ID] = fieldMapping.error;
  }
  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  const recordTypes = parseCsvList(
    readModalInputValue(
      view,
      SALESFORCE_PDF_WORKFLOW_RECORD_TYPES_BLOCK_ID,
      SALESFORCE_PDF_WORKFLOW_RECORD_TYPES_ACTION_ID,
    ),
  );
  return {
    allowedRecordTypeIds: recordTypes.filter((value) => /^012[A-Za-z0-9]{12,15}$/u.test(value)),
    allowedRecordTypeNames: recordTypes.filter((value) => !/^012[A-Za-z0-9]{12,15}$/u.test(value)),
    allowedApprovalStatuses: parseCsvList(
      readModalInputValue(
        view,
        SALESFORCE_PDF_WORKFLOW_APPROVAL_STATUSES_BLOCK_ID,
        SALESFORCE_PDF_WORKFLOW_APPROVAL_STATUSES_ACTION_ID,
      ),
    ),
    allowedStages: parseCsvList(
      readModalInputValue(
        view,
        SALESFORCE_PDF_WORKFLOW_ALLOWED_STAGES_BLOCK_ID,
        SALESFORCE_PDF_WORKFLOW_ALLOWED_STAGES_ACTION_ID,
      ),
    ),
    allowedStatuses: parseCsvList(
      readModalInputValue(
        view,
        SALESFORCE_PDF_WORKFLOW_ALLOWED_STATUSES_BLOCK_ID,
        SALESFORCE_PDF_WORKFLOW_ALLOWED_STATUSES_ACTION_ID,
      ),
    ),
    approvalStatusField:
      readModalInputValue(
        view,
        SALESFORCE_PDF_WORKFLOW_APPROVAL_FIELD_BLOCK_ID,
        SALESFORCE_PDF_WORKFLOW_APPROVAL_FIELD_ACTION_ID,
      )?.trim() || null,
    attachTo: attachTo.data as SalesforcePdfAttachTarget,
    enabled: enabled as boolean,
    fieldMapping: "value" in fieldMapping ? fieldMapping.value : {},
    includeAiSummary: includeAiSummary as boolean,
    requiredFields: parseCsvList(
      readModalInputValue(
        view,
        SALESFORCE_PDF_WORKFLOW_REQUIRED_FIELDS_BLOCK_ID,
        SALESFORCE_PDF_WORKFLOW_REQUIRED_FIELDS_ACTION_ID,
      ),
    ),
    requireConfirmationBeforeAttach: requireConfirmationBeforeAttach as boolean,
    templateId: templateId as string,
  };
}

function parseExistingSalesforcePdfWorkflowSetting(
  payload: JsonObject | undefined,
): SalesforcePdfWorkflowSettings | undefined {
  if (payload === undefined) {
    return undefined;
  }
  const parsed = salesforcePdfWorkflowSettingsSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

function parseFieldMapping(
  raw: string | undefined,
): { value: Record<string, string> } | { error: string } {
  const text = raw?.trim();
  if (text === undefined || text === "") {
    return { value: {} };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return { error: "Enter a JSON object." };
    }
    const mapping: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || key.trim() === "" || value.trim() === "") {
        return { error: "Field mapping values must be non-empty strings." };
      }
      mapping[key.trim()] = value.trim();
    }
    return { value: mapping };
  } catch {
    return { error: "Enter valid JSON." };
  }
}

function parseCsvList(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function parseBooleanOption(value: string | undefined): boolean | undefined {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function parseCredentialProviderKind(
  value: string | undefined,
): CredentialProviderKind | undefined {
  return workspaceCredentialProviderKinds.find((providerKind) => providerKind === value);
}

async function isWorkspaceAdmin(
  client: SlackClient,
  slackUserId: string,
  logger: unknown,
): Promise<boolean> {
  try {
    const response = await client.users.info({ user: slackUserId });
    const user = response.user;
    if (!isRecord(user)) {
      return false;
    }
    return (
      readBoolean(user, "is_admin") === true ||
      readBoolean(user, "is_owner") === true ||
      readBoolean(user, "is_primary_owner") === true
    );
  } catch (error) {
    logWarn(logger, "Failed to verify Slack workspace admin status.", {
      error,
      slackUserId,
    });
    return false;
  }
}

function readSlackUserId(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  if (typeof body.user === "string") {
    return body.user;
  }
  if (isRecord(body.user) && typeof body.user.id === "string") {
    return body.user.id;
  }
  return undefined;
}

function readActionValue(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.actions)) {
    return undefined;
  }
  const [action] = body.actions;
  return isRecord(action) && typeof action.value === "string" ? action.value : undefined;
}

function parseSalesforcePdfWorkflowActionValue(
  value: string | undefined,
): { action: SalesforcePdfWorkflowAction; salesforceOrgId: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const action = parseSalesforcePdfWorkflowAction(readOptionalString(parsed.action));
    const salesforceOrgId = readOptionalString(parsed.salesforceOrgId);
    return action === undefined || salesforceOrgId === undefined
      ? undefined
      : { action, salesforceOrgId };
  } catch {
    return undefined;
  }
}

function parseSalesforcePdfWorkflowModalMetadata(value: string | undefined):
  | {
      action: SalesforcePdfWorkflowAction;
      salesforceOrgId: string;
      teamId: string;
    }
  | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const action = parseSalesforcePdfWorkflowAction(readOptionalString(parsed.action));
    const salesforceOrgId = readOptionalString(parsed.salesforceOrgId);
    const teamId = readOptionalString(parsed.teamId);
    return action === undefined || salesforceOrgId === undefined || teamId === undefined
      ? undefined
      : { action, salesforceOrgId, teamId };
  } catch {
    return undefined;
  }
}

function parseSalesforcePdfWorkflowAction(
  value: string | undefined,
): SalesforcePdfWorkflowAction | undefined {
  return salesforcePdfWorkflowActions.find((action) => action === value);
}

function salesforcePdfWorkflowPayload(settings: SalesforcePdfWorkflowSettings): JsonObject {
  return {
    action: settings.action,
    allowed_approval_statuses: settings.allowed_approval_statuses,
    allowed_record_type_ids: settings.allowed_record_type_ids,
    allowed_record_type_names: settings.allowed_record_type_names,
    allowed_stages: settings.allowed_stages,
    allowed_statuses: settings.allowed_statuses,
    approval_status_field: settings.approval_status_field ?? null,
    attach_to: settings.attach_to,
    created_at: settings.created_at.toISOString(),
    enabled: settings.enabled,
    enabled_at: settings.enabled_at?.toISOString() ?? null,
    enabled_by_slack_user_id: settings.enabled_by_slack_user_id ?? null,
    field_mapping: settings.field_mapping,
    include_ai_summary: settings.include_ai_summary,
    record_type_field: settings.record_type_field ?? null,
    required_fields: settings.required_fields,
    require_confirmation_before_attach: settings.require_confirmation_before_attach,
    salesforce_org_id: settings.salesforce_org_id,
    slack_channel_allowlist: settings.slack_channel_allowlist,
    slack_user_group_allowlist: settings.slack_user_group_allowlist,
    status_field: settings.status_field ?? null,
    stage_field: settings.stage_field ?? null,
    team_id: settings.team_id,
    template_id: settings.template_id,
    updated_at: settings.updated_at.toISOString(),
    updated_by_slack_user_id: settings.updated_by_slack_user_id ?? null,
  };
}

function readModalInputValue(view: unknown, blockId: string, actionId: string): string | undefined {
  const element = readModalElement(view, blockId, actionId);
  return isRecord(element) && typeof element.value === "string" ? element.value : undefined;
}

function readSelectedOptionValue(
  view: unknown,
  blockId: string,
  actionId: string,
): string | undefined {
  const element = readModalElement(view, blockId, actionId);
  const option = isRecord(element) ? element.selected_option : undefined;
  return isRecord(option) && typeof option.value === "string" ? option.value : undefined;
}

function readModalElement(view: unknown, blockId: string, actionId: string): unknown {
  if (!isRecord(view)) {
    return undefined;
  }
  const state = view.state;
  if (!isRecord(state)) {
    return undefined;
  }
  const values = state.values;
  if (!isRecord(values)) {
    return undefined;
  }
  const block = values[blockId];
  if (!isRecord(block)) {
    return undefined;
  }
  return block[actionId];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveTranslationLanguageFromReaction(reaction: string | undefined): string | undefined {
  const normalized = reaction
    ?.trim()
    .toLocaleLowerCase()
    .replace(/^flag-/u, "");
  if (normalized === undefined || normalized === "") {
    return undefined;
  }
  return FLAG_REACTION_LANGUAGE_CODES[normalized];
}

function isActiveThread(thread: JsonObject | undefined): boolean {
  return (
    thread !== undefined &&
    stringField(thread, "status") === "active" &&
    stringField(thread, "agent_id") !== undefined
  );
}

async function resolveSlackAgentRoute(
  repository: SlackAgentRoutingRepository | undefined,
  input: {
    channelId: string;
    teamId: string;
    threadTs?: string;
  },
): Promise<SlackResolvedAgentRoute | undefined> {
  return repository?.resolveAgent?.(input);
}

function specialistFromRoute(
  route: SlackResolvedAgentRoute | undefined,
): AgentSpecialist | undefined {
  if (route === undefined) {
    return undefined;
  }
  const candidate = stringField(route.agent, "specialist") ?? route.agentId;
  const parsed = agentSpecialistSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function threadScopedModelId(route: SlackResolvedAgentRoute | undefined): string | undefined {
  return route?.modelScope === "thread" ? route.modelId : undefined;
}

function stringField(value: JsonObject | undefined, field: string): string | undefined {
  const fieldValue = value?.[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

const FLAG_REACTION_LANGUAGE_CODES: Record<string, string> = {
  au: "en",
  br: "pt",
  ca: "en",
  cn: "zh-CN",
  cz: "cs",
  de: "de",
  dk: "da",
  es: "es",
  fi: "fi",
  fr: "fr",
  gb: "en",
  gr: "el",
  hk: "zh-TW",
  hu: "hu",
  id: "id",
  il: "he",
  in: "hi",
  it: "it",
  jp: "ja",
  kr: "ko",
  mx: "es",
  nl: "nl",
  no: "no",
  nz: "en",
  pl: "pl",
  pt: "pt",
  ro: "ro",
  ru: "ru",
  sa: "ar",
  se: "sv",
  th: "th",
  tr: "tr",
  tw: "zh-TW",
  ua: "uk",
  us: "en",
  vn: "vi",
};

function stripBotMention(text: string, botUserId: string | undefined): string {
  if (botUserId === undefined) {
    return text.trim();
  }
  return text.replace(new RegExp(`<@${escapeRegExp(botUserId)}>\\s*`, "u"), "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readString(value: StringIndexed, field: string): string | undefined {
  const fieldValue = value[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function readBodyString(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const fieldValue = value[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function readSlackEnterpriseId(body: unknown): string | undefined {
  return (
    readBodyString(body, "enterprise_id") ?? readFirstAuthorizationString(body, "enterprise_id")
  );
}

function readSlackEnterpriseInstall(body: unknown): boolean | undefined {
  return (
    readBodyBoolean(body, "is_enterprise_install") ??
    readFirstAuthorizationBoolean(body, "is_enterprise_install")
  );
}

function readBodyBoolean(value: unknown, field: string): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value[field] === "boolean" ? value[field] : undefined;
}

function readFirstAuthorizationString(body: unknown, field: string): string | undefined {
  const authorization = readFirstAuthorization(body);
  const fieldValue = authorization?.[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function readFirstAuthorizationBoolean(body: unknown, field: string): boolean | undefined {
  const authorization = readFirstAuthorization(body);
  return typeof authorization?.[field] === "boolean" ? authorization[field] : undefined;
}

function readFirstAuthorization(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !Array.isArray(body.authorizations)) {
    return undefined;
  }
  const [authorization] = body.authorizations;
  return isRecord(authorization) ? authorization : undefined;
}

function readOptionalContextValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(value: StringIndexed, field: string): boolean | undefined {
  const fieldValue = value[field];
  return typeof fieldValue === "boolean" ? fieldValue : undefined;
}

function hasStringField<TField extends string>(
  value: StringIndexed,
  field: TField,
): value is StringIndexed & Record<TField, string> {
  return readString(value, field) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
