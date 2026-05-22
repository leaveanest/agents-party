import { Pool } from "pg";

import type { JsonValue } from "../../domain/messageHistory.js";
import {
  type JsonObject,
  type PostgresColumnValues,
  PostgresJsonDocumentRepository,
  postgresDocumentTables,
} from "./jsonDocumentRepository.js";

export type PayloadDocument = {
  payload: JsonObject;
};

export type AgentDocument = PayloadDocument & {
  agentId: string;
  enabled: boolean;
  updatedAt: Date;
};

export type WorkspaceSettingsDocument = PayloadDocument & {
  defaultAgentId?: string;
  defaultModelId?: string;
  enabledModelIds?: string[];
  reasoningEffort?: string;
  teamId: string;
  threadAutoReply?: boolean;
  updatedAt: Date;
};

export type ChannelSettingsDocument = WorkspaceSettingsDocument & {
  channelId: string;
};

export type SlackThreadDocument = PayloadDocument & {
  agentId?: string;
  channelId: string;
  createdAt: Date;
  lastMessageTs?: string;
  modelId?: string;
  reasoningEffort?: string;
  rootMessageTs: string;
  status: string;
  teamId: string;
  threadTs: string;
  updatedAt: Date;
};

export type AgentRouteScope = "channel" | "thread" | "workspace";

export type ResolvedAgentRouteDocument = {
  agent: JsonObject;
  agentId: string;
  channelId: string;
  modelFallback?: ResolvedModelFallbackDocument;
  modelId?: string;
  modelScope?: AgentRouteScope;
  reasoningEffort?: string;
  scope: AgentRouteScope;
  teamId: string;
  threadTs?: string;
};

export type ResolvedModelFallbackDocument = {
  fromModelId: string;
  fromScope: AgentRouteScope;
  toModelId?: string;
  toScope?: AgentRouteScope;
};

export type OAuthStateDocument = PayloadDocument & {
  createdAt: Date;
  expiresAt: Date;
  slackUserId: string;
  stateId: string;
  teamId: string;
};

export type GoogleAuthConnectionDocument = PayloadDocument & {
  connectionStatus: string;
  googleAccountEmail?: string;
  googleAccountSubject: string;
  refreshTokenExpiresAt?: Date;
  slackUserId: string;
  teamId: string;
  tokenExpiresAt?: Date;
  updatedAt: Date;
};

export type SalesforceAuthConfigDocument = PayloadDocument & {
  oauthClientId: string;
  salesforceMyDomainHost: string;
  salesforceOrgId: string;
  status: string;
  teamId: string;
  updatedAt: Date;
};

export type SalesforceConnectionDocument = PayloadDocument & {
  connectionStatus: string;
  salesforceOrgId: string;
  salesforceUserId: string;
  salesforceUsername?: string;
  slackUserId: string;
  teamId: string;
  tokenExpiresAt?: Date;
  updatedAt: Date;
};

export type SalesforceOAuthStateDocument = OAuthStateDocument & {
  salesforceOrgId: string;
};

export type SalesforcePdfWorkflowSettingDocument = PayloadDocument & {
  action: string;
  enabled: boolean;
  salesforceOrgId: string;
  teamId: string;
  templateId: string;
  updatedAt: Date;
};

export type SalesforcePdfTemplateDocument = PayloadDocument & {
  action: string;
  salesforceOrgId: string;
  status: string;
  teamId: string;
  templateId: string;
  updatedAt: Date;
};

export class PostgresAgentRoutingRepository {
  private readonly pool: Pool;
  private readonly agents: PostgresJsonDocumentRepository<{ agent_id: string }, JsonObject>;
  private readonly workspaceSettings: PostgresJsonDocumentRepository<
    { team_id: string },
    JsonObject
  >;
  private readonly channelSettings: PostgresJsonDocumentRepository<
    { channel_id: string; team_id: string },
    JsonObject
  >;
  private readonly threads: PostgresJsonDocumentRepository<
    { channel_id: string; team_id: string; thread_ts: string },
    JsonObject
  >;

  constructor(pool: Pool) {
    this.pool = pool;
    this.agents = new PostgresJsonDocumentRepository(postgresDocumentTables.agent, { pool });
    this.workspaceSettings = new PostgresJsonDocumentRepository(
      postgresDocumentTables.workspaceAppSettings,
      { pool },
    );
    this.channelSettings = new PostgresJsonDocumentRepository(
      postgresDocumentTables.channelAppSettings,
      { pool },
    );
    this.threads = new PostgresJsonDocumentRepository(postgresDocumentTables.slackThread, { pool });
  }

  async saveAgent(document: AgentDocument): Promise<void> {
    await this.agents.upsert({
      key: { agent_id: document.agentId },
      payload: agentPayload(document),
      values: { enabled: document.enabled, updated_at: document.updatedAt },
    });
  }

  async findAgent(agentId: string): Promise<JsonObject | undefined> {
    return this.agents.find({ agent_id: agentId });
  }

  async listAgents(): Promise<JsonObject[]> {
    return this.agents.list();
  }

  async setEnabledAgents(agentIds: readonly string[]): Promise<JsonObject[]> {
    const enabledAgentIds = new Set(agentIds.map((agentId) => agentId.trim()).filter(Boolean));
    const updatedAt = new Date();
    const agents = await this.agents.list();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const repository = new PostgresJsonDocumentRepository(postgresDocumentTables.agent, {
        pool: client as never,
      });
      const updatedAgents: JsonObject[] = [];
      for (const agent of agents) {
        const agentId = stringField(agent, "agent_id");
        const enabled = enabledAgentIds.has(agentId);
        const payload = {
          ...agent,
          enabled,
          updated_at: updatedAt.toISOString(),
        };
        await repository.upsert({
          key: { agent_id: agentId },
          payload,
          values: { enabled, updated_at: updatedAt },
        });
        updatedAgents.push(payload);
      }
      await client.query("commit");
      return sortByStringField(updatedAgents, "agent_id");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveWorkspaceSettings(document: WorkspaceSettingsDocument): Promise<void> {
    await this.workspaceSettings.upsert({
      key: { team_id: document.teamId },
      payload: workspaceSettingsPayload(document),
      values: workspaceSettingsValues(document),
    });
  }

  async findWorkspaceSettings(teamId: string): Promise<JsonObject | undefined> {
    return this.workspaceSettings.find({ team_id: teamId });
  }

  async saveChannelSettings(document: ChannelSettingsDocument): Promise<void> {
    await this.channelSettings.upsert({
      key: { channel_id: document.channelId, team_id: document.teamId },
      payload: settingsPayload(document),
      values: settingsValues(document),
    });
  }

  async findChannelSettings(teamId: string, channelId: string): Promise<JsonObject | undefined> {
    return this.channelSettings.find({ channel_id: channelId, team_id: teamId });
  }

  async isChannelEnabled(teamId: string, channelId: string): Promise<boolean> {
    const workspaceSettings = await this.findWorkspaceSettings(teamId);
    const enabledChannelIds = stringArrayField(workspaceSettings, "enabled_channel_ids");
    return enabledChannelIds.length === 0 || enabledChannelIds.includes(channelId);
  }

  async saveSlackThread(document: SlackThreadDocument): Promise<void> {
    await this.threads.upsert({
      key: {
        channel_id: document.channelId,
        team_id: document.teamId,
        thread_ts: document.threadTs,
      },
      payload: slackThreadPayload(document),
      values: snakeValues({
        agentId: document.agentId,
        createdAt: document.createdAt,
        lastMessageTs: document.lastMessageTs,
        modelId: document.modelId,
        rootMessageTs: document.rootMessageTs,
        status: document.status,
        updatedAt: document.updatedAt,
      }),
    });
  }

  async findSlackThread(
    teamId: string,
    channelId: string,
    threadTs: string,
  ): Promise<JsonObject | undefined> {
    return this.threads.find({ channel_id: channelId, team_id: teamId, thread_ts: threadTs });
  }

  async activateThreadAgent(input: {
    agentId: string;
    channelId: string;
    lastMessageTs: string;
    modelId?: string;
    reasoningEffort?: string;
    rootMessageTs: string;
    teamId: string;
    threadTs: string;
  }): Promise<JsonObject> {
    const currentThread = await this.findSlackThread(input.teamId, input.channelId, input.threadTs);
    const now = new Date();
    const createdAt = stringField(currentThread, "created_at", now.toISOString());
    const rootMessageTs = stringField(currentThread, "root_message_ts", input.rootMessageTs);
    const payload: JsonObject = {
      ...currentThread,
      agent_id: input.agentId,
      channel_id: input.channelId,
      created_at: createdAt,
      last_message_ts: input.lastMessageTs,
      ...(input.modelId === undefined ? {} : { model_id: input.modelId }),
      ...(input.reasoningEffort === undefined ? {} : { reasoning_effort: input.reasoningEffort }),
      root_message_ts: rootMessageTs,
      status: "active",
      team_id: input.teamId,
      thread_ts: input.threadTs,
      updated_at: now.toISOString(),
    };
    await this.saveSlackThread({
      agentId: input.agentId,
      channelId: input.channelId,
      createdAt: new Date(createdAt),
      lastMessageTs: input.lastMessageTs,
      modelId: input.modelId,
      payload,
      reasoningEffort: input.reasoningEffort,
      rootMessageTs,
      status: "active",
      teamId: input.teamId,
      threadTs: input.threadTs,
      updatedAt: now,
    });
    return payload;
  }

  async isThreadAutoReplyEnabled(teamId: string, channelId: string): Promise<boolean> {
    if (!(await this.isChannelEnabled(teamId, channelId))) {
      return false;
    }
    const channelSettings = await this.findChannelSettings(teamId, channelId);
    const channelValue = booleanField(channelSettings, "thread_auto_reply");
    if (channelValue !== undefined) {
      return channelValue;
    }
    const workspaceSettings = await this.findWorkspaceSettings(teamId);
    const workspaceValue = booleanField(workspaceSettings, "thread_auto_reply");
    return workspaceValue ?? true;
  }

  async resolveAgent(input: {
    channelId: string;
    teamId: string;
    threadChannelId?: string;
    threadTs?: string;
  }): Promise<ResolvedAgentRouteDocument | undefined> {
    if (!(await this.isChannelEnabled(input.teamId, input.channelId))) {
      return undefined;
    }

    const [workspaceSettings, channelSettings, thread] = await Promise.all([
      this.findWorkspaceSettings(input.teamId),
      this.findChannelSettings(input.teamId, input.channelId),
      input.threadTs === undefined
        ? Promise.resolve(undefined)
        : this.findSlackThread(
            input.teamId,
            input.threadChannelId ?? input.channelId,
            input.threadTs,
          ),
    ]);
    const activeThread = stringField(thread, "status", "") === "active" ? thread : undefined;
    const resolved = resolveAgentId({
      channelAgentId: optionalStringField(channelSettings, "default_agent_id"),
      threadAgentId: optionalStringField(activeThread, "agent_id"),
      workspaceAgentId: optionalStringField(workspaceSettings, "default_agent_id"),
    });
    if (resolved === undefined) {
      return undefined;
    }
    const agent = await this.findAgent(resolved.agentId);
    if (agent === undefined || booleanField(agent, "enabled") !== true) {
      return undefined;
    }
    const channelModelId = optionalStringField(channelSettings, "default_model_id");
    const enabledModelIds = stringArrayField(workspaceSettings, "enabled_model_ids");
    const threadModelId =
      optionalStringField(activeThread, "model_scope") === "thread"
        ? optionalStringField(activeThread, "model_id")
        : undefined;
    const workspaceModelId = optionalStringField(workspaceSettings, "default_model_id");
    const resolvedModel = resolveModelId({
      channelModelId,
      enabledModelIds,
      threadModelId,
      workspaceModelId,
    });
    if (
      enabledModelIds.length > 0 &&
      resolvedModel === undefined &&
      [threadModelId, channelModelId, workspaceModelId].some((modelId) => modelId !== undefined)
    ) {
      return undefined;
    }
    return {
      agent,
      agentId: resolved.agentId,
      channelId: input.channelId,
      modelFallback: resolvedModel?.fallback,
      modelId: resolvedModel?.modelId,
      modelScope: resolvedModel?.scope,
      reasoningEffort: resolveReasoningEffort({
        channelSettings,
        scope: resolvedModel?.scope,
        thread: activeThread,
        workspaceSettings,
      }),
      scope: resolved.scope,
      teamId: input.teamId,
      threadTs: input.threadTs,
    };
  }
}

export class PostgresOAuthRepository {
  private readonly googleConnections: PostgresJsonDocumentRepository<
    { google_account_subject: string; slack_user_id: string; team_id: string },
    JsonObject
  >;
  private readonly googleStates: PostgresJsonDocumentRepository<
    { state_id: string; team_id: string },
    JsonObject
  >;
  private readonly salesforceConfigs: PostgresJsonDocumentRepository<
    { salesforce_org_id: string; team_id: string },
    JsonObject
  >;
  private readonly salesforceConnections: PostgresJsonDocumentRepository<
    { salesforce_org_id: string; slack_user_id: string; team_id: string },
    JsonObject
  >;
  private readonly salesforceStates: PostgresJsonDocumentRepository<
    { state_id: string; team_id: string },
    JsonObject
  >;

  constructor(pool: Pool) {
    this.googleConnections = new PostgresJsonDocumentRepository(
      postgresDocumentTables.googleAuthConnection,
      { pool },
    );
    this.googleStates = new PostgresJsonDocumentRepository(
      postgresDocumentTables.googleOAuthState,
      {
        pool,
      },
    );
    this.salesforceConfigs = new PostgresJsonDocumentRepository(
      postgresDocumentTables.salesforceAuthConfig,
      { pool },
    );
    this.salesforceConnections = new PostgresJsonDocumentRepository(
      postgresDocumentTables.salesforceConnection,
      { pool },
    );
    this.salesforceStates = new PostgresJsonDocumentRepository(
      postgresDocumentTables.salesforceOAuthState,
      { pool },
    );
  }

  async saveGoogleConnection(document: GoogleAuthConnectionDocument): Promise<void> {
    await this.googleConnections.upsert({
      key: {
        google_account_subject: document.googleAccountSubject,
        slack_user_id: document.slackUserId,
        team_id: document.teamId,
      },
      payload: document.payload,
      values: snakeValues(document),
    });
  }

  async saveGoogleOAuthState(document: OAuthStateDocument): Promise<void> {
    await this.googleStates.upsert({
      key: { state_id: document.stateId, team_id: document.teamId },
      payload: document.payload,
      values: snakeValues(document),
    });
  }

  async consumeGoogleOAuthState(teamId: string, stateId: string): Promise<JsonObject | undefined> {
    return this.googleStates.consume({ state_id: stateId, team_id: teamId });
  }

  async findGoogleConnection(
    teamId: string,
    slackUserId: string,
    googleAccountSubject: string,
  ): Promise<JsonObject | undefined> {
    return this.googleConnections.find({
      google_account_subject: googleAccountSubject,
      slack_user_id: slackUserId,
      team_id: teamId,
    });
  }

  async listGoogleConnections(teamId: string, slackUserId?: string): Promise<JsonObject[]> {
    return this.googleConnections.list(
      slackUserId === undefined
        ? { team_id: teamId }
        : { slack_user_id: slackUserId, team_id: teamId },
    );
  }

  async saveSalesforceAuthConfig(document: SalesforceAuthConfigDocument): Promise<void> {
    await this.salesforceConfigs.upsert({
      key: { salesforce_org_id: document.salesforceOrgId, team_id: document.teamId },
      payload: document.payload,
      values: snakeValues(document),
    });
  }

  async findSalesforceAuthConfig(
    teamId: string,
    salesforceOrgId: string,
  ): Promise<JsonObject | undefined> {
    return this.salesforceConfigs.find({
      salesforce_org_id: salesforceOrgId,
      team_id: teamId,
    });
  }

  async listSalesforceAuthConfigs(teamId: string): Promise<JsonObject[]> {
    return this.salesforceConfigs.list({ team_id: teamId });
  }

  async saveSalesforceConnection(document: SalesforceConnectionDocument): Promise<void> {
    await this.salesforceConnections.upsert({
      key: {
        salesforce_org_id: document.salesforceOrgId,
        slack_user_id: document.slackUserId,
        team_id: document.teamId,
      },
      payload: document.payload,
      values: snakeValues(document),
    });
  }

  async findSalesforceConnection(
    teamId: string,
    slackUserId: string,
    salesforceOrgId: string,
  ): Promise<JsonObject | undefined> {
    return this.salesforceConnections.find({
      salesforce_org_id: salesforceOrgId,
      slack_user_id: slackUserId,
      team_id: teamId,
    });
  }

  async listSalesforceConnections(teamId: string, slackUserId?: string): Promise<JsonObject[]> {
    return this.salesforceConnections.list(
      slackUserId === undefined
        ? { team_id: teamId }
        : { slack_user_id: slackUserId, team_id: teamId },
    );
  }

  async saveSalesforceOAuthState(document: SalesforceOAuthStateDocument): Promise<void> {
    await this.salesforceStates.upsert({
      key: { state_id: document.stateId, team_id: document.teamId },
      payload: document.payload,
      values: snakeValues(document),
    });
  }

  async consumeSalesforceOAuthState(
    teamId: string,
    stateId: string,
  ): Promise<JsonObject | undefined> {
    return this.salesforceStates.consume({ state_id: stateId, team_id: teamId });
  }
}

export class PostgresSalesforcePdfWorkflowRepository {
  private readonly settings: PostgresJsonDocumentRepository<
    { action: string; salesforce_org_id: string; team_id: string },
    JsonObject
  >;
  private readonly templates: PostgresJsonDocumentRepository<
    { salesforce_org_id: string; team_id: string; template_id: string },
    JsonObject
  >;

  constructor(pool: Pool) {
    this.settings = new PostgresJsonDocumentRepository(
      postgresDocumentTables.salesforcePdfWorkflowSetting,
      { pool },
    );
    this.templates = new PostgresJsonDocumentRepository(
      postgresDocumentTables.salesforcePdfTemplate,
      {
        pool,
      },
    );
  }

  async saveSalesforcePdfWorkflowSetting(
    document: SalesforcePdfWorkflowSettingDocument,
  ): Promise<void> {
    await this.settings.upsert({
      key: {
        action: document.action,
        salesforce_org_id: document.salesforceOrgId,
        team_id: document.teamId,
      },
      payload: document.payload,
      values: snakeValues(document),
    });
  }

  async findSalesforcePdfWorkflowSetting(
    teamId: string,
    salesforceOrgId: string,
    action: string,
  ): Promise<JsonObject | undefined> {
    return this.settings.find({
      action,
      salesforce_org_id: salesforceOrgId,
      team_id: teamId,
    });
  }

  async listSalesforcePdfWorkflowSettings(
    teamId: string,
    salesforceOrgId?: string,
  ): Promise<JsonObject[]> {
    return this.settings.list(
      salesforceOrgId === undefined
        ? { team_id: teamId }
        : { salesforce_org_id: salesforceOrgId, team_id: teamId },
    );
  }

  async saveSalesforcePdfTemplate(document: SalesforcePdfTemplateDocument): Promise<void> {
    await this.templates.upsert({
      key: {
        salesforce_org_id: document.salesforceOrgId,
        team_id: document.teamId,
        template_id: document.templateId,
      },
      payload: document.payload,
      values: snakeValues(document),
    });
  }

  async findSalesforcePdfTemplate(
    teamId: string,
    salesforceOrgId: string,
    templateId: string,
  ): Promise<JsonObject | undefined> {
    return this.templates.find({
      salesforce_org_id: salesforceOrgId,
      team_id: teamId,
      template_id: templateId,
    });
  }

  async listSalesforcePdfTemplates(
    teamId: string,
    salesforceOrgId?: string,
  ): Promise<JsonObject[]> {
    return this.templates.list(
      salesforceOrgId === undefined
        ? { team_id: teamId }
        : { salesforce_org_id: salesforceOrgId, team_id: teamId },
    );
  }
}

function resolveAgentId(input: {
  channelAgentId?: string;
  threadAgentId?: string;
  workspaceAgentId?: string;
}): { agentId: string; scope: AgentRouteScope } | undefined {
  if (input.threadAgentId !== undefined) {
    return { agentId: input.threadAgentId, scope: "thread" };
  }
  if (input.channelAgentId !== undefined) {
    return { agentId: input.channelAgentId, scope: "channel" };
  }
  if (input.workspaceAgentId !== undefined) {
    return { agentId: input.workspaceAgentId, scope: "workspace" };
  }
  return undefined;
}

function resolveModelId(input: {
  channelModelId?: string;
  enabledModelIds?: readonly string[];
  threadModelId?: string;
  workspaceModelId?: string;
}):
  | { fallback?: ResolvedModelFallbackDocument; modelId: string; scope: AgentRouteScope }
  | undefined {
  const candidates: Array<{ modelId?: string; scope: AgentRouteScope }> = [
    { modelId: input.threadModelId, scope: "thread" },
    { modelId: input.channelModelId, scope: "channel" },
    { modelId: input.workspaceModelId, scope: "workspace" },
  ];
  const configuredCandidates = candidates.filter(
    (candidate): candidate is { modelId: string; scope: AgentRouteScope } =>
      candidate.modelId !== undefined,
  );
  const enabledModelIds = new Set(input.enabledModelIds ?? []);
  if (enabledModelIds.size === 0) {
    return configuredCandidates[0];
  }
  let fallbackFrom: { modelId: string; scope: AgentRouteScope } | undefined;
  for (const candidate of configuredCandidates) {
    if (enabledModelIds.has(candidate.modelId)) {
      return fallbackFrom === undefined
        ? candidate
        : {
            ...candidate,
            fallback: {
              fromModelId: fallbackFrom.modelId,
              fromScope: fallbackFrom.scope,
              toModelId: candidate.modelId,
              toScope: candidate.scope,
            },
          };
    }
    fallbackFrom ??= candidate;
  }
  return undefined;
}

function resolveReasoningEffort(input: {
  channelSettings?: JsonObject;
  scope?: AgentRouteScope;
  thread?: JsonObject;
  workspaceSettings?: JsonObject;
}): string | undefined {
  switch (input.scope) {
    case "thread":
      return (
        optionalStringField(input.thread, "reasoning_effort") ??
        optionalStringField(input.channelSettings, "reasoning_effort") ??
        optionalStringField(input.workspaceSettings, "reasoning_effort")
      );
    case "channel":
      return (
        optionalStringField(input.channelSettings, "reasoning_effort") ??
        optionalStringField(input.workspaceSettings, "reasoning_effort")
      );
    case "workspace":
      return optionalStringField(input.workspaceSettings, "reasoning_effort");
    default:
      return undefined;
  }
}

function stringField(
  payload: JsonObject | undefined,
  fieldName: string,
  fallback?: string,
): string {
  const value = payload?.[fieldName];
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Missing string field '${fieldName}'.`);
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Expected '${fieldName}' to be a string.`);
}

function optionalStringField(
  payload: JsonObject | undefined,
  fieldName: string,
): string | undefined {
  const value = payload?.[fieldName];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function booleanField(payload: JsonObject | undefined, fieldName: string): boolean | undefined {
  const value = payload?.[fieldName];
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayField(payload: JsonObject | undefined, fieldName: string): string[] {
  const value = payload?.[fieldName];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function sortByStringField<T extends JsonObject>(values: T[], fieldName: string): T[] {
  return [...values].sort((left, right) =>
    stringField(left, fieldName, "").localeCompare(stringField(right, fieldName, "")),
  );
}

function assignIfDefined(
  payload: JsonObject,
  fieldName: string,
  value: JsonValue | undefined,
): void {
  if (value !== undefined) {
    payload[fieldName] = value;
  }
}

function settingsValues(document: WorkspaceSettingsDocument): PostgresColumnValues {
  return {
    default_agent_id: document.defaultAgentId ?? null,
    default_model_id: document.defaultModelId ?? null,
    thread_auto_reply: document.threadAutoReply ?? null,
    updated_at: document.updatedAt,
  };
}

function workspaceSettingsValues(document: WorkspaceSettingsDocument): PostgresColumnValues {
  return {
    ...settingsValues(document),
    enabled_model_ids: JSON.stringify(document.enabledModelIds ?? []),
  };
}

function agentPayload(document: AgentDocument): JsonObject {
  const payload: JsonObject = { ...document.payload };
  delete payload.agent_id;
  delete payload.enabled;
  delete payload.updated_at;
  assignIfDefined(payload, "agent_id", document.agentId);
  assignIfDefined(payload, "enabled", document.enabled);
  assignIfDefined(payload, "updated_at", document.updatedAt.toISOString());
  return payload;
}

function settingsPayload(document: WorkspaceSettingsDocument): JsonObject {
  const payload: JsonObject = { ...document.payload };
  delete payload.default_agent_id;
  delete payload.default_model_id;
  delete payload.enabled_model_ids;
  delete payload.reasoning_effort;
  delete payload.thread_auto_reply;
  delete payload.updated_at;
  assignIfDefined(payload, "default_agent_id", document.defaultAgentId);
  assignIfDefined(payload, "default_model_id", document.defaultModelId);
  assignIfDefined(payload, "reasoning_effort", document.reasoningEffort);
  assignIfDefined(payload, "thread_auto_reply", document.threadAutoReply);
  assignIfDefined(payload, "updated_at", document.updatedAt.toISOString());
  return payload;
}

function workspaceSettingsPayload(document: WorkspaceSettingsDocument): JsonObject {
  const payload = settingsPayload(document);
  assignIfDefined(payload, "enabled_model_ids", document.enabledModelIds);
  return payload;
}

function slackThreadPayload(document: SlackThreadDocument): JsonObject {
  const payload: JsonObject = { ...document.payload };
  delete payload.agent_id;
  delete payload.channel_id;
  delete payload.created_at;
  delete payload.last_message_ts;
  delete payload.model_id;
  delete payload.model_scope;
  delete payload.reasoning_effort;
  delete payload.root_message_ts;
  delete payload.status;
  delete payload.team_id;
  delete payload.thread_ts;
  delete payload.updated_at;
  assignIfDefined(payload, "agent_id", document.agentId);
  assignIfDefined(payload, "channel_id", document.channelId);
  assignIfDefined(payload, "created_at", document.createdAt.toISOString());
  assignIfDefined(payload, "last_message_ts", document.lastMessageTs);
  assignIfDefined(payload, "model_id", document.modelId);
  assignIfDefined(payload, "model_scope", document.modelId === undefined ? undefined : "thread");
  assignIfDefined(payload, "reasoning_effort", document.reasoningEffort);
  assignIfDefined(payload, "root_message_ts", document.rootMessageTs);
  assignIfDefined(payload, "status", document.status);
  assignIfDefined(payload, "team_id", document.teamId);
  assignIfDefined(payload, "thread_ts", document.threadTs);
  assignIfDefined(payload, "updated_at", document.updatedAt.toISOString());
  return payload;
}

function snakeValues(document: Record<string, unknown>): PostgresColumnValues {
  const values: PostgresColumnValues = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === "payload" || value === undefined) {
      continue;
    }
    if (value instanceof Date || isColumnJsonValue(value)) {
      values[camelToSnake(key)] = value;
    }
  }
  return values;
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

function isColumnJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
