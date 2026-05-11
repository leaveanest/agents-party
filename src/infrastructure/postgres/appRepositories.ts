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
  rootMessageTs: string;
  status: string;
  teamId: string;
  threadTs: string;
  updatedAt: Date;
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

export type WorkItemDocument = PayloadDocument & {
  audienceChannelId?: string;
  completedAt?: Date;
  dueAt?: Date;
  primaryAssigneeUserId?: string;
  status: string;
  teamId: string;
  title: string;
  updatedAt: Date;
  visibilityKind: string;
  workItemId: string;
};

export type WorkItemParticipantDocument = PayloadDocument & {
  attentionProfile: string;
  lastSeenEventId?: string;
  mutedUntil?: Date;
  nextAttentionAt?: Date;
  role: string;
  teamId: string;
  updatedAt: Date;
  userId: string;
  workItemId: string;
};

export type WorkItemEventDocument = PayloadDocument & {
  eventId: string;
  occurredAt: Date;
  teamId: string;
  type: string;
  workItemId: string;
};

export type WorkItemAttentionIndexDocument = PayloadDocument & {
  audienceChannelId?: string;
  needsAttentionNow: boolean;
  primaryAssigneeUserId?: string;
  status: string;
  teamId: string;
  updatedAt: Date;
  userId: string;
  visibilityKind: string;
  workItemId: string;
};

export type WorkItemCalendarLinkDocument = PayloadDocument & {
  createdAt: Date;
  endsAt?: Date;
  eventTitleSnapshot?: string;
  externalCalendarId: string;
  externalEventId: string;
  isAllDay: boolean;
  lastSyncedAt?: Date;
  linkId: string;
  providerKind: string;
  responseStatus?: string;
  startsAt?: Date;
  syncStatus: string;
  teamId: string;
  updatedAt: Date;
  workItemId: string;
};

export type WorkItemAggregateDocument = {
  attention: JsonObject[];
  calendarLinks: JsonObject[];
  events: JsonObject[];
  item: JsonObject;
  participants: JsonObject[];
};

export class PostgresAgentRoutingRepository {
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
      payload: document.payload,
      values: { enabled: document.enabled, updated_at: document.updatedAt },
    });
  }

  async findAgent(agentId: string): Promise<JsonObject | undefined> {
    return this.agents.find({ agent_id: agentId });
  }

  async listAgents(): Promise<JsonObject[]> {
    return this.agents.list();
  }

  async saveWorkspaceSettings(document: WorkspaceSettingsDocument): Promise<void> {
    await this.workspaceSettings.upsert({
      key: { team_id: document.teamId },
      payload: document.payload,
      values: settingsValues(document),
    });
  }

  async findWorkspaceSettings(teamId: string): Promise<JsonObject | undefined> {
    return this.workspaceSettings.find({ team_id: teamId });
  }

  async saveChannelSettings(document: ChannelSettingsDocument): Promise<void> {
    await this.channelSettings.upsert({
      key: { channel_id: document.channelId, team_id: document.teamId },
      payload: document.payload,
      values: settingsValues(document),
    });
  }

  async findChannelSettings(teamId: string, channelId: string): Promise<JsonObject | undefined> {
    return this.channelSettings.find({ channel_id: channelId, team_id: teamId });
  }

  async saveSlackThread(document: SlackThreadDocument): Promise<void> {
    await this.threads.upsert({
      key: {
        channel_id: document.channelId,
        team_id: document.teamId,
        thread_ts: document.threadTs,
      },
      payload: document.payload,
      values: snakeValues({
        agentId: document.agentId,
        createdAt: document.createdAt,
        lastMessageTs: document.lastMessageTs,
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

export class PostgresWorkItemRepository {
  private readonly items: PostgresJsonDocumentRepository<
    { team_id: string; work_item_id: string },
    JsonObject
  >;
  private readonly participants: PostgresJsonDocumentRepository<
    { team_id: string; user_id: string; work_item_id: string },
    JsonObject
  >;
  private readonly events: PostgresJsonDocumentRepository<
    { event_id: string; team_id: string; work_item_id: string },
    JsonObject
  >;
  private readonly attentionIndex: PostgresJsonDocumentRepository<
    { team_id: string; user_id: string; work_item_id: string },
    JsonObject
  >;
  private readonly calendarLinks: PostgresJsonDocumentRepository<
    { link_id: string; team_id: string; work_item_id: string },
    JsonObject
  >;

  constructor(pool: Pool) {
    this.items = new PostgresJsonDocumentRepository(postgresDocumentTables.workItem, { pool });
    this.participants = new PostgresJsonDocumentRepository(
      postgresDocumentTables.workItemParticipant,
      { pool },
    );
    this.events = new PostgresJsonDocumentRepository(postgresDocumentTables.workItemEvent, {
      pool,
    });
    this.attentionIndex = new PostgresJsonDocumentRepository(
      postgresDocumentTables.workItemAttentionIndex,
      { pool },
    );
    this.calendarLinks = new PostgresJsonDocumentRepository(
      postgresDocumentTables.workItemCalendarLink,
      { pool },
    );
  }

  async saveWorkItem(document: WorkItemDocument): Promise<void> {
    await this.items.upsert({
      key: { team_id: document.teamId, work_item_id: document.workItemId },
      payload: document.payload,
      values: snakeValues(document),
    });
  }

  async findWorkItem(teamId: string, workItemId: string): Promise<JsonObject | undefined> {
    return this.items.find({ team_id: teamId, work_item_id: workItemId });
  }

  async getWorkItemAggregate(
    teamId: string,
    workItemId: string,
  ): Promise<WorkItemAggregateDocument | undefined> {
    const item = await this.findWorkItem(teamId, workItemId);
    if (item === undefined) {
      return undefined;
    }
    const key = { team_id: teamId, work_item_id: workItemId };
    const [participants, events, attention, calendarLinks] = await Promise.all([
      this.participants.findByKeyPrefix(key),
      this.events.findByKeyPrefix(key),
      this.attentionIndex.findByKeyPrefix(key),
      this.calendarLinks.findByKeyPrefix(key),
    ]);
    return {
      attention,
      calendarLinks,
      events,
      item,
      participants,
    };
  }

  async listWorkItems(teamId: string): Promise<JsonObject[]> {
    return this.items.list({ team_id: teamId });
  }

  async listAttentionWorkItems(teamId: string, userId: string): Promise<JsonObject[]> {
    return this.attentionIndex.list({
      needs_attention_now: true,
      team_id: teamId,
      user_id: userId,
    });
  }

  async saveParticipant(document: WorkItemParticipantDocument): Promise<void> {
    await this.participants.upsert({
      key: {
        team_id: document.teamId,
        user_id: document.userId,
        work_item_id: document.workItemId,
      },
      payload: document.payload,
      values: snakeValues(document),
    });
  }

  async saveEvent(document: WorkItemEventDocument): Promise<void> {
    await this.events.upsert({
      key: {
        event_id: document.eventId,
        team_id: document.teamId,
        work_item_id: document.workItemId,
      },
      payload: document.payload,
      values: snakeValues(document),
    });
  }

  async saveAttentionIndex(document: WorkItemAttentionIndexDocument): Promise<void> {
    await this.attentionIndex.upsert({
      key: {
        team_id: document.teamId,
        user_id: document.userId,
        work_item_id: document.workItemId,
      },
      payload: document.payload,
      values: snakeValues(document),
    });
  }

  async saveCalendarLink(document: WorkItemCalendarLinkDocument): Promise<void> {
    await this.calendarLinks.upsert({
      key: {
        link_id: document.linkId,
        team_id: document.teamId,
        work_item_id: document.workItemId,
      },
      payload: document.payload,
      values: snakeValues(document),
    });
  }

  async deleteCalendarLink(teamId: string, workItemId: string, linkId: string): Promise<void> {
    await this.calendarLinks.delete({ link_id: linkId, team_id: teamId, work_item_id: workItemId });
  }
}

function settingsValues(document: WorkspaceSettingsDocument): PostgresColumnValues {
  return {
    default_agent_id: document.defaultAgentId ?? null,
    thread_auto_reply: document.threadAutoReply ?? null,
    updated_at: document.updatedAt,
  };
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
