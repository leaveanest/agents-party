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
import type { JsonValue } from "../domain/messageHistory.js";
import {
  FALLBACK_LOCALE,
  createTranslator,
  defaultTranslator,
  normalizeLocale,
  type Locale,
  type Translator,
} from "../i18n/index.js";
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
import type { UserSettingsRepository } from "../repositories/userSettings.js";
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
  WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_ACTION_ID,
  WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_BLOCK_ID,
  WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_ACTION_ID,
  WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_BLOCK_ID,
  WORKSPACE_CREDENTIAL_SORACOM_OPERATOR_ACTION_ID,
  WORKSPACE_CREDENTIAL_SORACOM_OPERATOR_BLOCK_ID,
  WORKSPACE_CREDENTIAL_SECRET_ACTION_ID,
  WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID,
} from "./interactiveIds.js";
import { resolveUserSettingsTranslator } from "./userLocale.js";

type SlackEventArgs<TEvent extends string> = SlackEventMiddlewareArgs<TEvent> & AllMiddlewareArgs;
type SlackActionArgs = SlackActionMiddlewareArgs & AllMiddlewareArgs;
type SlackViewArgs = SlackViewMiddlewareArgs & AllMiddlewareArgs;
type SlackClient = SlackEventArgs<"app_mention">["client"];
export type SlackAgentClient = Pick<
  SlackClient,
  "chat" | "conversations" | "filesUploadV2" | "token" | "users"
> & {
  assistant?: {
    threads?: {
      setStatus(input: {
        channel_id: string;
        loading_messages?: string[];
        status: string;
        thread_ts: string;
      }): Promise<unknown>;
    };
  };
};

type WorkspaceCredentialProviderSelection = CredentialProviderKind | "google_service_account_json";

const workspaceCredentialProviderOptions = [
  { label: "OpenAI", value: "openai" },
  { label: "Azure OpenAI", value: "azure_openai" },
  { label: "Anthropic", value: "anthropic" },
  { label: "Google", value: "google" },
  { label: "Google service account JSON", value: "google_service_account_json" },
  { label: "Google Maps", value: "google_maps" },
  { label: "Groq", value: "groq" },
  { label: "xAI", value: "xai" },
  { label: "PLaMo", value: "plamo" },
  { label: "NVIDIA", value: "nvidia" },
  { label: "LiteLLM", value: "litellm" },
  { label: "SORACOM", value: "soracom" },
] as const satisfies readonly {
  label: string;
  value: WorkspaceCredentialProviderSelection;
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
    credentialName?: string;
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
  defaultLocale?: Locale;
  routingRepository?: SlackAgentRoutingRepository;
  salesforceConnectionHome?: SalesforceConnectionHome;
  salesforcePdfWorkflowHome?: SalesforcePdfWorkflowHome;
  userSettingsRepository?: UserSettingsRepository;
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
      const translator = await resolveHandlerTranslator(teamId, event.user, options, logger);
      const blocks = await buildAppHomeBlocks({
        logger,
        options,
        slackUserId: event.user,
        teamId,
        translator,
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
    async handleWorkspaceCredentialProviderSelectAction(args) {
      await handleWorkspaceCredentialProviderSelectAction(args, options);
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
  translator: Translator;
}): Promise<Record<string, unknown>[]> {
  const { translator } = input;
  const blocks: Record<string, unknown>[] = [
    {
      text: { text: translator.t("appHome.title"), type: "plain_text" },
      type: "header",
    },
    {
      text: {
        text: translator.t("appHome.intro"),
        type: "mrkdwn",
      },
      type: "section",
    },
  ];
  if (input.options.workspaceCredentialSettings !== undefined && input.teamId !== undefined) {
    blocks.push({ type: "divider" });
    blocks.push({
      text: { text: translator.t("appHome.apiKeys.title"), type: "plain_text" },
      type: "header",
    });
    blocks.push({
      accessory: {
        action_id: WORKSPACE_CREDENTIAL_CONFIGURE_ACTION_ID,
        text: { text: translator.t("appHome.configure"), type: "plain_text" },
        type: "button",
      },
      text: {
        text: translator.t("appHome.apiKeys.body"),
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
      text: { text: translator.t("appHome.salesforce.title"), type: "plain_text" },
      type: "header",
    });
    for (const config of configs) {
      const connection = connections.find(
        (item) => item.salesforce_org_id === config.salesforce_org_id,
      );
      const status = connection?.connection_status ?? "not_connected";
      const actionLabel =
        status === "active"
          ? translator.t("appHome.salesforce.reconnect")
          : translator.t("appHome.salesforce.connect");
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
            translator,
          )}`,
          type: "mrkdwn",
        },
        type: "section",
      });
      if (input.options.salesforcePdfWorkflowHome !== undefined) {
        blocks.push(
          ...buildSalesforcePdfWorkflowBlocks(
            config.salesforce_org_id,
            workflowSettings,
            translator,
          ),
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
  translator: Translator,
): Record<string, unknown>[] {
  return salesforcePdfWorkflowActions.map((action) => {
    const setting = settings.find(
      (item) => item.salesforce_org_id === salesforceOrgId && item.action === action,
    );
    const enabled = setting?.enabled === true;
    return {
      accessory: {
        action_id: SALESFORCE_PDF_WORKFLOW_CONFIGURE_ACTION_ID,
        text: { text: translator.t("appHome.configure"), type: "plain_text" },
        type: "button",
        value: JSON.stringify({ action, salesforceOrgId }),
      },
      text: {
        text: `*${salesforcePdfWorkflowActionLabel(action)}*\n${
          setting === undefined
            ? enabled
              ? translator.t("common.enabled")
              : translator.t("common.disabled")
            : translator.t("appHome.salesforce.workflowStatus", {
                status: enabled ? translator.t("common.enabled") : translator.t("common.disabled"),
                templateId: setting.template_id,
              })
        }`,
        type: "mrkdwn",
      },
      type: "section",
    };
  });
}

function salesforceStatusText(
  status: string,
  accountLabel: string | undefined,
  translator: Translator,
): string {
  if (status === "active") {
    return accountLabel === undefined
      ? translator.t("appHome.salesforce.connected")
      : translator.t("appHome.salesforce.connectedAs", { account: accountLabel });
  }
  if (status === "expired") {
    return translator.t("appHome.salesforce.reconnectRequired");
  }
  if (status === "revoked") {
    return translator.t("appHome.salesforce.disconnected");
  }
  if (status === "error") {
    return translator.t("appHome.salesforce.connectionNeedsAttention");
  }
  return translator.t("appHome.salesforce.notConnected");
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
  const translator = createTranslator(options.defaultLocale ?? FALLBACK_LOCALE);
  if (options.workspaceCredentialSettings === undefined) {
    const response = await client.views.open({
      trigger_id: triggerId,
      view: buildWorkspaceCredentialUnavailableModal(translator) as never,
    });
    await updateOpenedWorkspaceCredentialModalLocale({
      client,
      logger,
      response,
      slackUserId,
      teamId,
      translator,
      userSettingsRepository: options.userSettingsRepository,
      view: buildWorkspaceCredentialUnavailableModal,
    });
    return;
  }
  const response = await client.views.open({
    trigger_id: triggerId,
    view: buildWorkspaceCredentialModal(teamId, "openai", translator) as never,
  });
  await updateOpenedWorkspaceCredentialModalLocale({
    client,
    logger,
    response,
    slackUserId,
    teamId,
    translator,
    userSettingsRepository: options.userSettingsRepository,
    view: (localizedTranslator) =>
      buildWorkspaceCredentialModal(teamId, "openai", localizedTranslator),
  });
}

async function updateOpenedWorkspaceCredentialModalLocale(input: {
  client: SlackClient;
  logger: unknown;
  response: unknown;
  slackUserId: string;
  teamId: string;
  translator: Translator;
  userSettingsRepository: UserSettingsRepository | undefined;
  view(translator: Translator): Record<string, unknown>;
}): Promise<void> {
  const translator = await resolveHandlerTranslator(
    input.teamId,
    input.slackUserId,
    {
      defaultLocale: input.translator.locale,
      userSettingsRepository: input.userSettingsRepository,
    },
    input.logger,
  );
  if (translator.locale === input.translator.locale) {
    return;
  }
  const openedView = isRecord(input.response) ? input.response.view : undefined;
  await updateWorkspaceCredentialModal(
    input.client,
    openedView,
    input.view(translator),
    input.logger,
  );
}

async function handleWorkspaceCredentialProviderSelectAction(
  { ack, body, client, logger }: SlackActionArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  await ack();
  const view = isRecord(body) ? body.view : undefined;
  const metadata = parseWorkspaceCredentialModalMetadata(
    isRecord(view) ? readString(view, "private_metadata") : undefined,
  );
  const slackUserId = readSlackUserId(body);
  const teamId = metadata?.teamId ?? readTeamId(body, {});
  const translator = await resolveHandlerTranslator(
    teamId,
    slackUserId,
    {
      defaultLocale: metadata?.locale ?? options.defaultLocale,
      userSettingsRepository: options.userSettingsRepository,
    },
    logger,
  );
  const providerValue = readSelectedOptionValue(
    view,
    WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID,
    WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
  );
  const providerSelection = parseWorkspaceCredentialProviderSelection(providerValue) ?? "openai";
  logInfo(logger, "Updating workspace credential modal for selected provider.", {
    providerSelection,
    teamId,
  });
  await updateWorkspaceCredentialModal(
    client,
    view,
    buildWorkspaceCredentialModal(teamId ?? "", providerSelection, translator),
    logger,
  );
}

async function handleWorkspaceCredentialModalSubmission(
  { ack, body, client, logger, view }: SlackViewArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  const metadata = parseWorkspaceCredentialModalMetadata(
    readString(view as unknown as StringIndexed, "private_metadata"),
  );
  const metadataTeamId = metadata?.teamId;
  const bodyTeamId = readTeamId(body, {});
  const teamId = bodyTeamId ?? metadataTeamId;
  const slackUserId = readSlackUserId(body);
  const ackTranslator = createTranslator(
    metadata?.locale ?? options.defaultLocale ?? FALLBACK_LOCALE,
  );
  if (options.workspaceCredentialSettings === undefined) {
    await ack({
      errors: {
        [WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID]: ackTranslator.t("credential.error.notConfigured"),
      },
      response_action: "errors",
    });
    return;
  }
  if (metadataTeamId !== undefined && bodyTeamId !== undefined && metadataTeamId !== bodyTeamId) {
    await ack({
      errors: {
        [WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID]: ackTranslator.t("credential.error.contextMismatch"),
      },
      response_action: "errors",
    });
    return;
  }
  if (teamId === undefined || slackUserId === undefined) {
    await ack({
      errors: {
        [WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID]: ackTranslator.t("credential.error.contextMissing"),
      },
      response_action: "errors",
    });
    return;
  }
  const parsed = parseWorkspaceCredentialModal(view, ackTranslator);
  if ("errors" in parsed) {
    await ack({
      errors: parsed.errors,
      response_action: "errors",
    });
    return;
  }

  await ack({
    response_action: "update",
    view: buildWorkspaceCredentialSavingModal(ackTranslator) as never,
  });

  let resultTranslator = ackTranslator;
  try {
    const userContext = await resolveSlackUserContext(client, slackUserId, ackTranslator, logger);
    const { translator } = userContext;
    resultTranslator = translator;
    if (!userContext.isWorkspaceAdmin) {
      await updateWorkspaceCredentialModal(
        client,
        view,
        buildWorkspaceCredentialResultModal(
          translator.t("credential.title.apiKey"),
          translator.t("credential.error.unauthorized"),
          translator,
        ),
        logger,
      );
      return;
    }
    await options.workspaceCredentialSettings.saveProviderApiKey({
      createdByUserId: slackUserId,
      ...(parsed.credentialName === undefined ? {} : { credentialName: parsed.credentialName }),
      payload: parsed.payload,
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
      buildWorkspaceCredentialResultModal(
        translator.t("credential.title.saved"),
        translator.t("credential.result.saved"),
        translator,
      ),
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
        resultTranslator.t("credential.title.apiKey"),
        resultTranslator.t("credential.error.saveFailed"),
        resultTranslator,
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
  const translator = createTranslator(options.defaultLocale ?? FALLBACK_LOCALE);
  const userContext = await resolveSlackUserContext(client, slackUserId, translator, logger);
  if (options.salesforcePdfWorkflowHome === undefined) {
    const response = await client.views.open({
      trigger_id: triggerId,
      view: buildSalesforcePdfWorkflowResultModal(
        translator.t("salesforcePdf.title"),
        translator.t("salesforcePdf.error.processNotConfigured"),
        translator,
      ) as never,
    });
    await updateOpenedSalesforcePdfWorkflowModalLocale({
      client,
      logger,
      response,
      slackUserId,
      teamId,
      translator,
      userSettingsRepository: options.userSettingsRepository,
      view: (localizedTranslator) =>
        buildSalesforcePdfWorkflowResultModal(
          localizedTranslator.t("salesforcePdf.title"),
          localizedTranslator.t("salesforcePdf.error.processNotConfigured"),
          localizedTranslator,
        ),
    });
    return;
  }
  if (!userContext.isWorkspaceAdmin) {
    const response = await client.views.open({
      trigger_id: triggerId,
      view: buildSalesforcePdfWorkflowResultModal(
        translator.t("salesforcePdf.title"),
        translator.t("salesforcePdf.error.unauthorized"),
        translator,
      ) as never,
    });
    await updateOpenedSalesforcePdfWorkflowModalLocale({
      client,
      logger,
      response,
      slackUserId,
      teamId,
      translator,
      userSettingsRepository: options.userSettingsRepository,
      view: (localizedTranslator) =>
        buildSalesforcePdfWorkflowResultModal(
          localizedTranslator.t("salesforcePdf.title"),
          localizedTranslator.t("salesforcePdf.error.unauthorized"),
          localizedTranslator,
        ),
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
  const response = await client.views.open({
    trigger_id: triggerId,
    view: buildSalesforcePdfWorkflowModal({
      action: actionValue.action,
      salesforceOrgId: actionValue.salesforceOrgId,
      settings: parsedCurrent?.success === true ? parsedCurrent.data : undefined,
      teamId,
      translator,
    }) as never,
  });
  await updateOpenedSalesforcePdfWorkflowModalLocale({
    client,
    logger,
    response,
    slackUserId,
    teamId,
    translator,
    userSettingsRepository: options.userSettingsRepository,
    view: (localizedTranslator) =>
      buildSalesforcePdfWorkflowModal({
        action: actionValue.action,
        salesforceOrgId: actionValue.salesforceOrgId,
        settings: parsedCurrent?.success === true ? parsedCurrent.data : undefined,
        teamId,
        translator: localizedTranslator,
      }),
  });
}

async function updateOpenedSalesforcePdfWorkflowModalLocale(input: {
  client: SlackClient;
  logger: unknown;
  response: unknown;
  slackUserId: string;
  teamId: string;
  translator: Translator;
  userSettingsRepository: UserSettingsRepository | undefined;
  view(translator: Translator): Record<string, unknown>;
}): Promise<void> {
  const translator = await resolveHandlerTranslator(
    input.teamId,
    input.slackUserId,
    {
      defaultLocale: input.translator.locale,
      userSettingsRepository: input.userSettingsRepository,
    },
    input.logger,
  );
  if (translator.locale === input.translator.locale) {
    return;
  }
  const openedView = isRecord(input.response) ? input.response.view : undefined;
  await updateSalesforcePdfWorkflowModal(
    input.client,
    openedView,
    input.view(translator),
    input.logger,
  );
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
  const ackTranslator = createTranslator(
    metadata?.locale ?? options.defaultLocale ?? FALLBACK_LOCALE,
  );
  if (options.salesforcePdfWorkflowHome === undefined) {
    await ack({
      errors: {
        [SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID]: ackTranslator.t(
          "salesforcePdf.error.notConfigured",
        ),
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
        [SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID]: ackTranslator.t(
          "salesforcePdf.error.contextMissing",
        ),
      },
      response_action: "errors",
    });
    return;
  }
  const parsed = parseSalesforcePdfWorkflowModal(view, ackTranslator);
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
      ackTranslator.t("salesforcePdf.title"),
      ackTranslator.t("salesforcePdf.result.saving"),
      ackTranslator,
    ) as never,
  });

  let resultTranslator = ackTranslator;
  try {
    const userContext = await resolveSlackUserContext(client, slackUserId, ackTranslator, logger);
    const { translator } = userContext;
    resultTranslator = translator;
    if (!userContext.isWorkspaceAdmin) {
      await updateSalesforcePdfWorkflowModal(
        client,
        view,
        buildSalesforcePdfWorkflowResultModal(
          translator.t("salesforcePdf.title"),
          translator.t("salesforcePdf.error.unauthorized"),
          translator,
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
        translator.t("salesforcePdf.title"),
        translator.t("salesforcePdf.result.saved", {
          action: salesforcePdfWorkflowActionLabel(payload.action),
          status: payload.enabled
            ? translator.t("common.enabledStatus")
            : translator.t("common.disabledStatus"),
        }),
        translator,
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
        resultTranslator.t("salesforcePdf.title"),
        resultTranslator.t("salesforcePdf.error.saveFailed"),
        resultTranslator,
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

  const translator = await resolveHandlerTranslator(teamId, event.user, options, logger);
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
      translator,
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
      text = translator.t("slack.error.noAgent");
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
          agentId: route?.agentId ?? "assistant",
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
    text = runnerUserFacingErrorMessage(error, translator);
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

  const translator = await resolveHandlerTranslator(teamId, event.user, options, logger);
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
      translator,
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
    const modelId = route === undefined ? stringField(thread, "model_id") : route.modelId;
    const threadMessages = await readThreadMessages(client, event.channel, threadTs);
    const result = await runner.run({
      channelId: event.channel,
      messageTs: event.ts,
      modelId,
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
        agentId: route?.agentId ?? stringField(thread, "agent_id") ?? "assistant",
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
    text = runnerUserFacingErrorMessage(error, translator);
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
    defaultLocale?: Locale;
    logger: unknown;
    retryContext?: SlackAgentJobRetryContext;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
    userSettingsRepository?: UserSettingsRepository;
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
    defaultLocale?: Locale;
    logger: unknown;
    retryContext?: SlackAgentJobRetryContext;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
    userSettingsRepository?: UserSettingsRepository;
  },
): Promise<void> {
  if (
    input.routingRepository !== undefined &&
    !(await input.routingRepository.isChannelEnabled(job.teamId, job.channelId))
  ) {
    return;
  }
  const translator = await resolveHandlerTranslator(job.teamId, job.userId, input, input.logger);
  await setSlackAssistantThreadStatus({
    channelId: job.channelId,
    client: input.client,
    logger: input.logger,
    translator,
    threadTs: job.threadTs,
  });

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
        text: translator.t("slack.error.noAgent"),
        thread_ts: job.threadTs,
      });
      return;
    }
    const threadMessages = await readThreadMessages(input.client, job.channelId, job.threadTs);
    const result = await input.runner.run({
      channelId: job.channelId,
      messageTs: job.messageTs,
      modelId: route?.modelId,
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
          agentId: route?.agentId ?? "assistant",
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
    text = runnerUserFacingErrorMessage(error, translator);
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
    defaultLocale?: Locale;
    logger: unknown;
    retryContext?: SlackAgentJobRetryContext;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
    userSettingsRepository?: UserSettingsRepository;
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

  const translator = await resolveHandlerTranslator(job.teamId, job.userId, input, input.logger);
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
    await setSlackAssistantThreadStatus({
      channelId: job.channelId,
      client: input.client,
      logger: input.logger,
      translator,
      threadTs: job.threadTs,
    });
    const modelId = route === undefined ? stringField(thread, "model_id") : route.modelId;
    const threadMessages = await readThreadMessages(input.client, job.channelId, job.threadTs);
    const result = await input.runner.run({
      channelId: job.channelId,
      messageTs: job.messageTs,
      modelId,
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
        agentId: route?.agentId ?? stringField(thread, "agent_id") ?? "assistant",
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
    text = runnerUserFacingErrorMessage(error, translator);
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

async function setSlackAssistantThreadStatus(input: {
  channelId: string;
  client: SlackAgentClient;
  logger: unknown;
  translator: Translator;
  threadTs: string;
}): Promise<void> {
  const setStatus = input.client.assistant?.threads?.setStatus;
  if (setStatus === undefined) {
    return;
  }
  try {
    await setStatus({
      channel_id: input.channelId,
      status: input.translator.t("slack.status.working"),
      thread_ts: input.threadTs,
    });
  } catch (error) {
    logWarn(input.logger, "Failed to set Slack assistant thread status.", {
      channelId: input.channelId,
      error,
      threadTs: input.threadTs,
    });
  }
}

async function enqueueSlackAgentJob(input: {
  body: unknown;
  client: SlackAgentClient;
  eventType: SlackAgentJob["eventType"];
  job: SlackAgentJob;
  logger: unknown;
  queue: SlackAgentJobQueue;
  translator: Translator;
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
      text: input.translator.t("slack.error.queue"),
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
  const translator = await resolveHandlerTranslator(
    teamId,
    readString(event, "user"),
    options,
    logger,
  );

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
    if (sourceText === undefined || sourceText.trim() === "") {
      await client.chat.postMessage({
        channel: channelId,
        text: translator.t("slack.error.unreadableReaction"),
        thread_ts: threadTs,
      });
      return;
    }
    const result = await runner.run({
      channelId,
      messageTs,
      modelId: route?.modelId,
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
    text = translator.t("slack.error.translation");
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

function runnerUserFacingErrorMessage(error: unknown, translator: Translator): string {
  if (error instanceof SlackAudioProcessingError) {
    return error.message;
  }
  return translator.t("slack.error.genericRequest");
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

async function resolveHandlerTranslator(
  teamId: string | undefined,
  userId: string | undefined,
  options: { defaultLocale?: Locale; userSettingsRepository?: UserSettingsRepository },
  logger: unknown,
): Promise<Translator> {
  return resolveUserSettingsTranslator({
    defaultLocale: options.defaultLocale ?? FALLBACK_LOCALE,
    logger,
    repository: options.userSettingsRepository,
    teamId,
    userId,
  });
}

async function resolveSlackUserContext(
  client: SlackAgentClient,
  userId: string | undefined,
  translator: Translator,
  logger: unknown,
): Promise<{ isWorkspaceAdmin: boolean; translator: Translator }> {
  const info = client.users?.info;
  if (info === undefined || userId === undefined) {
    return { isWorkspaceAdmin: false, translator };
  }
  try {
    const response = await info({ user: userId });
    const user = isRecord(response) && isRecord(response.user) ? response.user : undefined;
    const isAdmin =
      user !== undefined &&
      (readBoolean(user, "is_admin") === true ||
        readBoolean(user, "is_owner") === true ||
        readBoolean(user, "is_primary_owner") === true);
    return { isWorkspaceAdmin: isAdmin, translator };
  } catch (error) {
    logWarn(logger, "Failed to resolve Slack user context.", {
      error,
      slackUserId: userId,
    });
    return { isWorkspaceAdmin: false, translator };
  }
}

function runnerFailureLogFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof AgentRunnerExecutionError)) {
    return {};
  }
  return {
    modelId: error.model?.id,
    provider: error.model?.provider,
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

function buildWorkspaceCredentialModal(
  teamId: string,
  providerSelection: WorkspaceCredentialProviderSelection,
  translator: Translator = defaultTranslator,
): Record<string, unknown> {
  const providerKind = providerKindForCredentialSelection(providerSelection);
  return {
    callback_id: WORKSPACE_CREDENTIAL_MODAL_CALLBACK_ID,
    private_metadata: workspaceCredentialPrivateMetadata(teamId, translator),
    submit: { text: translator.t("common.save"), type: "plain_text" },
    title: { text: translator.t("credential.title"), type: "plain_text" },
    type: "modal",
    blocks: [
      {
        block_id: WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID,
        dispatch_action: true,
        element: {
          action_id: WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
          initial_option: workspaceCredentialProviderOption(providerSelection, translator),
          options: workspaceCredentialProviderOptionsFor(translator),
          type: "static_select",
        },
        label: { text: translator.t("credential.label.provider"), type: "plain_text" },
        type: "input",
      },
      {
        block_id: WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID,
        element: {
          action_id: WORKSPACE_CREDENTIAL_SECRET_ACTION_ID,
          ...(providerSelection === "google_service_account_json" ? { multiline: true } : {}),
          type: "plain_text_input",
        },
        label: {
          text:
            providerSelection === "google_service_account_json"
              ? translator.t("credential.label.serviceAccountJson")
              : providerKind === "soracom"
                ? translator.t("credential.label.authKeySecret")
                : translator.t("credential.label.secret"),
          type: "plain_text",
        },
        type: "input",
      },
      ...workspaceCredentialProviderDetailBlocks(providerSelection, translator),
    ],
  };
}

function workspaceCredentialProviderDetailBlocks(
  providerSelection: WorkspaceCredentialProviderSelection,
  translator: Translator,
): Record<string, unknown>[] {
  const providerKind = providerKindForCredentialSelection(providerSelection);
  if (providerSelection === "google_service_account_json") {
    return [];
  }
  if (providerKind !== "soracom") {
    return [
      {
        block_id: WORKSPACE_CREDENTIAL_BASE_URL_BLOCK_ID,
        element: {
          action_id: WORKSPACE_CREDENTIAL_BASE_URL_ACTION_ID,
          placeholder: { text: "https://proxy.example/v1", type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: translator.t("credential.label.baseUrl"), type: "plain_text" },
        optional: true,
        type: "input",
      },
    ];
  }
  return [
    {
      block_id: WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_BLOCK_ID,
      element: {
        action_id: WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_ACTION_ID,
        placeholder: { text: "keyId-xxxxxxxxxx", type: "plain_text" },
        type: "plain_text_input",
      },
      label: { text: translator.t("credential.label.authKeyId"), type: "plain_text" },
      type: "input",
    },
    {
      block_id: WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_BLOCK_ID,
      element: {
        action_id: WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_ACTION_ID,
        initial_option: {
          text: { text: translator.t("credential.option.coverageGlobal"), type: "plain_text" },
          value: "global",
        },
        options: [
          {
            text: { text: translator.t("credential.option.coverageGlobal"), type: "plain_text" },
            value: "global",
          },
          {
            text: { text: translator.t("credential.option.coverageJapan"), type: "plain_text" },
            value: "japan",
          },
        ],
        type: "static_select",
      },
      label: { text: translator.t("credential.label.coverage"), type: "plain_text" },
      type: "input",
    },
    {
      block_id: WORKSPACE_CREDENTIAL_SORACOM_OPERATOR_BLOCK_ID,
      element: {
        action_id: WORKSPACE_CREDENTIAL_SORACOM_OPERATOR_ACTION_ID,
        placeholder: { text: "OP0012345678", type: "plain_text" },
        type: "plain_text_input",
      },
      label: { text: translator.t("credential.label.operatorId"), type: "plain_text" },
      optional: true,
      type: "input",
    },
  ];
}

function workspaceCredentialProviderOption(
  providerSelection: WorkspaceCredentialProviderSelection,
  translator: Translator,
): {
  text: { text: string; type: "plain_text" };
  value: WorkspaceCredentialProviderSelection;
} {
  const options = workspaceCredentialProviderOptionsFor(translator);
  return options.find((option) => option.value === providerSelection) ?? options[0];
}

function workspaceCredentialProviderOptionsFor(translator: Translator): {
  text: { text: string; type: "plain_text" };
  value: WorkspaceCredentialProviderSelection;
}[] {
  return workspaceCredentialProviderOptions.map((option) => ({
    text: {
      text:
        option.value === "google_service_account_json"
          ? translator.t("credential.provider.googleServiceAccount")
          : option.label,
      type: "plain_text",
    },
    value: option.value,
  }));
}

function providerKindForCredentialSelection(
  providerSelection: WorkspaceCredentialProviderSelection,
): CredentialProviderKind {
  return providerSelection === "google_service_account_json" ? "google" : providerSelection;
}

function workspaceCredentialPrivateMetadata(teamId: string, translator: Translator): string {
  return JSON.stringify({ locale: translator.locale, teamId });
}

function buildWorkspaceCredentialSavingModal(
  translator: Translator = defaultTranslator,
): Record<string, unknown> {
  return buildWorkspaceCredentialResultModal(
    translator.t("credential.title.apiKey"),
    translator.t("credential.result.saving"),
    translator,
  );
}

function buildWorkspaceCredentialResultModal(
  title: string,
  text: string,
  translator: Translator = defaultTranslator,
): Record<string, unknown> {
  return {
    close: { text: translator.t("common.close"), type: "plain_text" },
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

function buildWorkspaceCredentialUnavailableModal(
  translator: Translator = defaultTranslator,
): Record<string, unknown> {
  return {
    close: { text: translator.t("common.close"), type: "plain_text" },
    title: { text: translator.t("credential.title.apiKey"), type: "plain_text" },
    type: "modal",
    blocks: [
      {
        text: {
          text: translator.t("credential.unavailable"),
          type: "mrkdwn",
        },
        type: "section",
      },
    ],
  };
}

function salesforcePdfWorkflowEnabledOptionsFor(translator: Translator): {
  text: { text: string; type: "plain_text" };
  value: "false" | "true";
}[] {
  return [
    { text: { text: translator.t("common.disabled"), type: "plain_text" }, value: "false" },
    { text: { text: translator.t("common.enabled"), type: "plain_text" }, value: "true" },
  ];
}

function salesforcePdfWorkflowAttachTargetOptionsFor(translator: Translator): {
  text: { text: string; type: "plain_text" };
  value: SalesforcePdfAttachTarget;
}[] {
  return [
    {
      text: { text: translator.t("salesforcePdf.attachTarget.sourceRecord"), type: "plain_text" },
      value: "source_record",
    },
    {
      text: { text: translator.t("salesforcePdf.attachTarget.quote"), type: "plain_text" },
      value: "quote",
    },
    {
      text: { text: translator.t("salesforcePdf.attachTarget.opportunity"), type: "plain_text" },
      value: "opportunity",
    },
    {
      text: { text: translator.t("salesforcePdf.attachTarget.both"), type: "plain_text" },
      value: "both",
    },
  ];
}

function salesforcePdfWorkflowConfirmationOptionsFor(translator: Translator): {
  text: { text: string; type: "plain_text" };
  value: "false" | "true";
}[] {
  return [
    {
      text: { text: translator.t("salesforcePdf.option.requireConfirmation"), type: "plain_text" },
      value: "true",
    },
    {
      text: {
        text: translator.t("salesforcePdf.option.doNotRequireConfirmation"),
        type: "plain_text",
      },
      value: "false",
    },
  ];
}

function salesforcePdfWorkflowAiSummaryOptionsFor(translator: Translator): {
  text: { text: string; type: "plain_text" };
  value: "false" | "true";
}[] {
  return [
    {
      text: { text: translator.t("salesforcePdf.option.aiSummaryOff"), type: "plain_text" },
      value: "false",
    },
    {
      text: { text: translator.t("salesforcePdf.option.aiSummaryOn"), type: "plain_text" },
      value: "true",
    },
  ];
}

function buildSalesforcePdfWorkflowModal(input: {
  action: SalesforcePdfWorkflowAction;
  salesforceOrgId: string;
  settings?: SalesforcePdfWorkflowSettings;
  teamId: string;
  translator?: Translator;
}): Record<string, unknown> {
  const translator = input.translator ?? defaultTranslator;
  const enabledOptions = salesforcePdfWorkflowEnabledOptionsFor(translator);
  const attachTargetOptions = salesforcePdfWorkflowAttachTargetOptionsFor(translator);
  const confirmationOptions = salesforcePdfWorkflowConfirmationOptionsFor(translator);
  const aiSummaryOptions = salesforcePdfWorkflowAiSummaryOptionsFor(translator);
  const settings = input.settings;
  const enabledOption = enabledOptions.find(
    (option) => option.value === String(settings?.enabled === true),
  );
  const attachTo = settings?.attach_to ?? "source_record";
  const attachOption = attachTargetOptions.find((option) => option.value === attachTo);
  const confirmationOption = confirmationOptions.find(
    (option) => option.value === String(settings?.require_confirmation_before_attach !== false),
  );
  const aiSummaryOption = aiSummaryOptions.find(
    (option) => option.value === String(settings?.include_ai_summary === true),
  );
  return {
    callback_id: SALESFORCE_PDF_WORKFLOW_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({
      action: input.action,
      locale: translator.locale,
      salesforceOrgId: input.salesforceOrgId,
      teamId: input.teamId,
    }),
    submit: { text: translator.t("common.save"), type: "plain_text" },
    title: { text: translator.t("salesforcePdf.title"), type: "plain_text" },
    type: "modal",
    blocks: [
      {
        block_id: SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_ENABLED_ACTION_ID,
          initial_option: enabledOption ?? enabledOptions[0],
          options: enabledOptions,
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
        label: { text: translator.t("salesforcePdf.label.templateId"), type: "plain_text" },
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
        label: { text: translator.t("salesforcePdf.label.allowedStages"), type: "plain_text" },
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
        label: { text: translator.t("salesforcePdf.label.allowedStatuses"), type: "plain_text" },
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
              label: {
                text: translator.t("salesforcePdf.label.approvalStatusField"),
                type: "plain_text",
              },
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
              label: {
                text: translator.t("salesforcePdf.label.allowedApprovalStatuses"),
                type: "plain_text",
              },
              optional: true,
              type: "input",
            },
            {
              block_id: SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_BLOCK_ID,
              element: {
                action_id: SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_ACTION_ID,
                initial_option: aiSummaryOption ?? aiSummaryOptions[0],
                options: aiSummaryOptions,
                type: "static_select",
              },
              label: { text: translator.t("salesforcePdf.label.aiSummary"), type: "plain_text" },
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
        label: { text: translator.t("salesforcePdf.label.requiredFields"), type: "plain_text" },
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
        label: {
          text: translator.t("salesforcePdf.label.allowedRecordTypes"),
          type: "plain_text",
        },
        optional: true,
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_ATTACH_TO_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_ATTACH_TO_ACTION_ID,
          initial_option: attachOption ?? attachTargetOptions[0],
          options: attachTargetOptions,
          type: "static_select",
        },
        label: { text: translator.t("salesforcePdf.label.attachTo"), type: "plain_text" },
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_CONFIRMATION_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_CONFIRMATION_ACTION_ID,
          initial_option: confirmationOption ?? confirmationOptions[0],
          options: confirmationOptions,
          type: "static_select",
        },
        label: { text: translator.t("salesforcePdf.label.confirmation"), type: "plain_text" },
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
        label: { text: translator.t("salesforcePdf.label.fieldMapping"), type: "plain_text" },
        optional: true,
        type: "input",
      },
    ],
  };
}

function buildSalesforcePdfWorkflowResultModal(
  title: string,
  text: string,
  translator: Translator = defaultTranslator,
): Record<string, unknown> {
  return {
    close: { text: translator.t("common.close"), type: "plain_text" },
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

function parseWorkspaceCredentialModal(
  view: unknown,
  translator: Translator = defaultTranslator,
):
  | {
      apiKey: string;
      baseURL?: string;
      credentialName?: string;
      payload: JsonObject;
      providerKind: CredentialProviderKind;
    }
  | { errors: Record<string, string> } {
  const providerValue = readSelectedOptionValue(
    view,
    WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID,
    WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
  );
  const providerSelection = parseWorkspaceCredentialProviderSelection(providerValue);
  const providerKind =
    providerSelection === undefined
      ? undefined
      : providerKindForCredentialSelection(providerSelection);
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
  const soracomAuthKeyId = readModalInputValue(
    view,
    WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_BLOCK_ID,
    WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_ACTION_ID,
  )?.trim();
  const soracomCoverage = readSelectedOptionValue(
    view,
    WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_BLOCK_ID,
    WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_ACTION_ID,
  );
  const soracomOperatorId = readModalInputValue(
    view,
    WORKSPACE_CREDENTIAL_SORACOM_OPERATOR_BLOCK_ID,
    WORKSPACE_CREDENTIAL_SORACOM_OPERATOR_ACTION_ID,
  )?.trim();
  const errors: Record<string, string> = {};
  if (providerKind === undefined) {
    errors[WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID] = translator.t(
      "credential.error.chooseProvider",
    );
  }
  if (apiKey === undefined || apiKey === "") {
    errors[WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID] =
      providerSelection === "google_service_account_json"
        ? translator.t("credential.error.serviceAccountJsonRequired")
        : providerKind === "soracom"
          ? translator.t("credential.error.authKeySecretRequired")
          : translator.t("credential.error.apiKeyRequired");
  }
  const googleServiceAccount =
    providerSelection === "google_service_account_json"
      ? parseGoogleServiceAccountCredentialJson(apiKey)
      : undefined;
  if (
    providerSelection === "google_service_account_json" &&
    apiKey !== undefined &&
    apiKey !== "" &&
    googleServiceAccount === undefined
  ) {
    errors[WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID] = translator.t(
      "credential.error.invalidServiceAccountJson",
    );
  }
  if (providerKind === "soracom") {
    if (soracomAuthKeyId === undefined || soracomAuthKeyId === "") {
      errors[WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_BLOCK_ID] = translator.t(
        "credential.error.authKeyIdRequired",
      );
    }
    if (soracomCoverage !== "global" && soracomCoverage !== "japan") {
      errors[WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_BLOCK_ID] = translator.t(
        "credential.error.chooseCoverage",
      );
    }
  }
  if (
    providerKind !== "soracom" &&
    baseURL !== undefined &&
    baseURL !== "" &&
    !isHttpUrl(baseURL)
  ) {
    errors[WORKSPACE_CREDENTIAL_BASE_URL_BLOCK_ID] = translator.t(
      "credential.error.invalidBaseUrl",
    );
  }
  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  if (providerKind === "soracom") {
    return {
      apiKey: apiKey as string,
      credentialName: "auth_key",
      payload: {
        auth_key_id: soracomAuthKeyId as string,
        coverage_type: soracomCoverage as "global" | "japan",
        ...(soracomOperatorId === undefined || soracomOperatorId === ""
          ? {}
          : { operator_id: soracomOperatorId }),
        source: "slack_app_home",
      },
      providerKind,
    };
  }
  if (providerSelection === "google_service_account_json") {
    return {
      apiKey: apiKey as string,
      credentialName: "service_account_json",
      payload: {
        ...(googleServiceAccount?.project_id === undefined
          ? {}
          : { project_id: googleServiceAccount.project_id }),
        source: "slack_app_home",
      },
      providerKind: "google",
    };
  }
  return {
    apiKey: apiKey as string,
    baseURL: baseURL === undefined || baseURL === "" ? undefined : baseURL,
    payload: {
      ...(baseURL === undefined || baseURL === "" ? {} : { base_url: baseURL }),
      source: "slack_app_home",
    },
    providerKind: providerKind as CredentialProviderKind,
  };
}

function parseSalesforcePdfWorkflowModal(
  view: unknown,
  translator: Translator = defaultTranslator,
):
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
    translator,
  );
  const errors: Record<string, string> = {};
  if (enabled === undefined) {
    errors[SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID] = translator.t(
      "salesforcePdf.error.enabledRequired",
    );
  }
  if (templateId === undefined || templateId === "") {
    errors[SALESFORCE_PDF_WORKFLOW_TEMPLATE_BLOCK_ID] = translator.t(
      "salesforcePdf.error.templateRequired",
    );
  }
  if (!attachTo.success) {
    errors[SALESFORCE_PDF_WORKFLOW_ATTACH_TO_BLOCK_ID] = translator.t(
      "salesforcePdf.error.attachTargetRequired",
    );
  }
  if (requireConfirmationBeforeAttach === undefined) {
    errors[SALESFORCE_PDF_WORKFLOW_CONFIRMATION_BLOCK_ID] = translator.t(
      "salesforcePdf.error.confirmationRequired",
    );
  }
  if (includeAiSummary === undefined) {
    errors[SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_BLOCK_ID] = translator.t(
      "salesforcePdf.error.summaryRequired",
    );
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
  translator: Translator = defaultTranslator,
): { value: Record<string, string> } | { error: string } {
  const text = raw?.trim();
  if (text === undefined || text === "") {
    return { value: {} };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return { error: translator.t("salesforcePdf.error.fieldMappingObject") };
    }
    const mapping: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || key.trim() === "" || value.trim() === "") {
        return { error: translator.t("salesforcePdf.error.fieldMappingStringValues") };
      }
      mapping[key.trim()] = value.trim();
    }
    return { value: mapping };
  } catch {
    return { error: translator.t("salesforcePdf.error.fieldMappingJson") };
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

function parseWorkspaceCredentialProviderSelection(
  value: string | undefined,
): WorkspaceCredentialProviderSelection | undefined {
  return workspaceCredentialProviderOptions.find((option) => option.value === value)?.value;
}

function parseWorkspaceCredentialModalMetadata(
  value: string | undefined,
): { locale?: Locale; teamId: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return value.trim() === "" ? undefined : { teamId: value };
    }
    const teamId = readOptionalString(parsed.teamId);
    return teamId === undefined
      ? undefined
      : {
          locale: normalizeLocale(readOptionalString(parsed.locale)),
          teamId,
        };
  } catch {
    return value.trim() === "" ? undefined : { teamId: value };
  }
}

function parseGoogleServiceAccountCredentialJson(
  value: string | undefined,
): { project_id?: string } | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const clientEmail = readString(parsed, "client_email");
  const privateKey = readString(parsed, "private_key");
  if (clientEmail === undefined || privateKey === undefined) {
    return undefined;
  }
  return { project_id: readString(parsed, "project_id") };
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
      locale?: Locale;
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
    const locale = normalizeLocale(readOptionalString(parsed.locale));
    const salesforceOrgId = readOptionalString(parsed.salesforceOrgId);
    const teamId = readOptionalString(parsed.teamId);
    return action === undefined || salesforceOrgId === undefined || teamId === undefined
      ? undefined
      : { action, locale, salesforceOrgId, teamId };
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
