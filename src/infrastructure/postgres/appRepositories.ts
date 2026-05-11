import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type { JsonValue } from "../../domain/messageHistory.js";
import type { CalendarProviderKind } from "../../domain/workItemCalendar.js";
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

export type AgentRouteScope = "channel" | "thread" | "workspace";

export type ResolvedAgentRouteDocument = {
  agent: JsonObject;
  channelId: string;
  scope: AgentRouteScope;
  teamId: string;
  threadTs?: string;
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
  providerKind: CalendarProviderKind;
  responseStatus?: string;
  startsAt?: Date;
  syncStatus: string;
  teamId: string;
  updatedAt: Date;
  workItemId: string;
};

export type ParticipantRole = "collaborator" | "follower" | "primary_assignee";
export type AttentionProfile = "focus" | "mute" | "track";
export type WorkItemStatus =
  | "archived"
  | "blocked"
  | "canceled"
  | "captured"
  | "done"
  | "in_progress"
  | "planned";
export type VisibilityPolicyKind = "context" | "named" | "private";
export type WorkEventType =
  | "attention_scheduled"
  | "blocked"
  | "calendar_event_canceled"
  | "calendar_event_linked"
  | "calendar_event_rescheduled"
  | "calendar_event_unlinked"
  | "collaborator_added"
  | "collaborator_removed"
  | "completed"
  | "due_at_changed"
  | "follower_added"
  | "follower_removed"
  | "mentioned"
  | "primary_assignee_changed"
  | "reopened"
  | "status_changed"
  | "unblocked"
  | "work_item_created";
export type WorkItemQueryView =
  | "channel_open"
  | "done_recently"
  | "inbox"
  | "my_tasks"
  | "needs_attention";

export type ParticipantAttentionUpdate = {
  attentionProfile?: AttentionProfile;
  clearMutedUntil?: boolean;
  clearNextAttentionAt?: boolean;
  createIfMissing?: boolean;
  mutedUntil?: Date | string;
  nextAttentionAt?: Date | string;
  roleIfMissing?: ParticipantRole;
  userId: string;
};

export type WorkItemPatch = {
  clearFields?: string[];
  description?: string;
  dueAt?: Date | string;
  homeChannelId?: string;
  namedVisibilityUserIds?: string[];
  priority?: string;
  projectRef?: string;
  status?: WorkItemStatus;
  tags?: string[];
  title?: string;
  visibilityKind?: VisibilityPolicyKind;
};

export type WorkItemMutationDocument = {
  attentionUpdates?: ParticipantAttentionUpdate[];
  clearPrimaryAssignee?: boolean;
  collaboratorUserIdsToAdd?: string[];
  collaboratorUserIdsToRemove?: string[];
  events?: JsonObject[];
  followerUserIdsToAdd?: string[];
  followerUserIdsToRemove?: string[];
  itemPatch?: WorkItemPatch;
  primaryAssigneeUserId?: string;
};

export type WorkItemQueryDocument = {
  audienceChannelId?: string;
  dueBefore?: Date | string;
  includeCompleted?: boolean;
  limit?: number;
  needsAttentionOnly?: boolean;
  participantUserId?: string;
  primaryAssigneeUserId?: string;
  statusIn?: WorkItemStatus[];
  teamId: string;
  textQuery?: string;
  view?: WorkItemQueryView;
  viewerChannelId?: string;
  viewerContextChannelIds?: string[];
  viewerUserId?: string;
  visibilityKind?: VisibilityPolicyKind;
};

export type WorkItemAggregateDocument = {
  attentionIndexes: JsonObject[];
  calendarLinks: JsonObject[];
  item: JsonObject;
  participants: JsonObject[];
  recentEvents: JsonObject[];
  viewerRelation?: JsonObject;
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

  async activateThreadAgent(input: {
    agentId: string;
    channelId: string;
    lastMessageTs: string;
    rootMessageTs: string;
    teamId: string;
    threadTs: string;
  }): Promise<JsonObject> {
    const currentThread = await this.findSlackThread(input.teamId, input.channelId, input.threadTs);
    const now = new Date();
    const createdAt = stringField(currentThread, "created_at", now.toISOString());
    const rootMessageTs = stringField(currentThread, "root_message_ts", input.rootMessageTs);
    const payload: JsonObject = {
      agent_id: input.agentId,
      channel_id: input.channelId,
      created_at: createdAt,
      last_message_ts: input.lastMessageTs,
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
      payload,
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
        : this.findSlackThread(input.teamId, input.channelId, input.threadTs),
    ]);
    const resolved = resolveAgentId({
      channelAgentId: optionalStringField(channelSettings, "default_agent_id"),
      threadAgentId: optionalStringField(thread, "agent_id"),
      workspaceAgentId: optionalStringField(workspaceSettings, "default_agent_id"),
    });
    if (resolved === undefined) {
      return undefined;
    }
    const agent = await this.findAgent(resolved.agentId);
    if (agent === undefined || booleanField(agent, "enabled") === false) {
      return undefined;
    }
    return {
      agent,
      channelId: input.channelId,
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

export class PostgresWorkItemRepository {
  private readonly pool: Pool;
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
    this.pool = pool;
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

  async createWorkItem(
    item: JsonObject,
    participants: JsonObject[],
    initialEvents: JsonObject[],
  ): Promise<WorkItemAggregateDocument> {
    return this.withTransaction(async (repositories) => {
      await repositories.items.upsert(workItemRecord(item));
      await replaceDocuments(
        repositories.participants,
        { team_id: teamId(item), work_item_id: workItemId(item) },
        participants,
        participantRecord(teamId(item)),
      );
      const events = sortEvents(initialEvents);
      await replaceDocuments(
        repositories.events,
        { team_id: teamId(item), work_item_id: workItemId(item) },
        events,
        eventRecord(teamId(item)),
      );
      const attentionIndexes = buildAttentionIndexes(item, participants, events);
      await replaceDocuments(
        repositories.attentionIndex,
        { team_id: teamId(item), work_item_id: workItemId(item) },
        attentionIndexes,
        attentionIndexRecord,
      );
      return hydrateWorkItemAggregate({
        attentionIndexes,
        calendarLinks: [],
        events,
        item,
        participants,
        viewerUserId: stringField(item, "created_by_user_id"),
      });
    });
  }

  async getWorkItemAggregate(
    teamId: string,
    workItemId: string,
    viewerUserId?: string,
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
    return hydrateWorkItemAggregate({
      attentionIndexes: attention,
      calendarLinks,
      events,
      item,
      participants,
      viewerUserId,
    });
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

  async getWorkItem(input: {
    teamId: string;
    viewerContextChannelIds: readonly string[];
    viewerUserId: string;
    workItemId: string;
  }): Promise<WorkItemAggregateDocument | undefined> {
    const aggregate = await this.getWorkItemAggregate(
      input.teamId,
      input.workItemId,
      input.viewerUserId,
    );
    if (
      aggregate === undefined ||
      !canViewWorkItem(aggregate, input.viewerUserId, input.viewerContextChannelIds)
    ) {
      return undefined;
    }
    return aggregate;
  }

  async listWorkItemAggregates(query: WorkItemQueryDocument): Promise<WorkItemAggregateDocument[]> {
    const workItemIds =
      query.needsAttentionOnly === true || query.view === "needs_attention"
        ? (await this.listAttentionWorkItems(query.teamId, query.viewerUserId ?? "")).map((row) =>
            stringField(row, "work_item_id"),
          )
        : (await this.listWorkItems(query.teamId)).map((row) => stringField(row, "work_item_id"));
    const aggregates: WorkItemAggregateDocument[] = [];
    for (const workItemId of workItemIds) {
      const aggregate = await this.getWorkItem({
        teamId: query.teamId,
        viewerContextChannelIds: query.viewerContextChannelIds ?? [],
        viewerUserId: query.viewerUserId ?? "",
        workItemId,
      });
      if (aggregate !== undefined && matchesWorkItemQuery(aggregate, query)) {
        aggregates.push(aggregate);
      }
    }
    return aggregates
      .sort((left, right) => sortValue(right, query) - sortValue(left, query))
      .slice(0, query.limit ?? 20);
  }

  async mutateWorkItem(input: {
    actorUserId: string;
    mutation: WorkItemMutationDocument;
    teamId: string;
    workItemId: string;
  }): Promise<WorkItemAggregateDocument> {
    return this.withTransaction(async (repositories) => {
      const current = await readAggregateInTransaction(
        repositories,
        input.teamId,
        input.workItemId,
      );
      if (current === undefined) {
        throw new Error(`Work item '${input.workItemId}' was not found.`);
      }
      const now = new Date();
      const nextParticipants = applyParticipantMutation(
        current.participants,
        input.mutation,
        input.workItemId,
        now,
      );
      const primaryAssigneeUserId = findPrimaryAssigneeUserId(nextParticipants);
      const nextItem = applyItemMutation(current.item, input.mutation.itemPatch ?? {}, {
        now,
        primaryAssigneeUserId,
      });
      const nextEvents = sortEvents([...current.recentEvents, ...(input.mutation.events ?? [])]);
      const attentionIndexes = buildAttentionIndexes(nextItem, nextParticipants, nextEvents, now);
      await repositories.items.upsert(workItemRecord(nextItem));
      await replaceDocuments(
        repositories.participants,
        { team_id: input.teamId, work_item_id: input.workItemId },
        nextParticipants,
        participantRecord(input.teamId),
      );
      await replaceDocuments(
        repositories.events,
        { team_id: input.teamId, work_item_id: input.workItemId },
        nextEvents,
        eventRecord(input.teamId),
      );
      await replaceDocuments(
        repositories.attentionIndex,
        { team_id: input.teamId, work_item_id: input.workItemId },
        attentionIndexes,
        attentionIndexRecord,
      );
      return hydrateWorkItemAggregate({
        attentionIndexes,
        calendarLinks: current.calendarLinks,
        events: nextEvents,
        item: nextItem,
        participants: nextParticipants,
        viewerUserId: input.actorUserId,
      });
    });
  }

  async linkCalendarEvent(input: {
    actorUserId: string;
    applyStartsAtToDueAt?: boolean;
    applyStartsAtToNextAttentionAtForUserId?: string;
    calendarLink: JsonObject;
    teamId: string;
    workItemId: string;
  }): Promise<WorkItemAggregateDocument> {
    if (
      stringField(input.calendarLink, "team_id") !== input.teamId ||
      stringField(input.calendarLink, "work_item_id") !== input.workItemId
    ) {
      throw new Error("calendarLink must belong to the target work item.");
    }
    if (
      (input.applyStartsAtToDueAt === true ||
        input.applyStartsAtToNextAttentionAtForUserId !== undefined) &&
      optionalStringField(input.calendarLink, "starts_at") === undefined
    ) {
      throw new Error("calendarLink.starts_at is required for time updates.");
    }

    return this.withTransaction(async (repositories) => {
      const current = await readAggregateInTransaction(
        repositories,
        input.teamId,
        input.workItemId,
      );
      if (current === undefined) {
        throw new Error(`Work item '${input.workItemId}' was not found.`);
      }
      const existingLink = current.calendarLinks.find(
        (link) => stringField(link, "link_id") === stringField(input.calendarLink, "link_id"),
      );
      const now = new Date();
      const persistedLink: JsonObject = {
        ...input.calendarLink,
        created_at: stringField(
          existingLink,
          "created_at",
          stringField(input.calendarLink, "created_at", now.toISOString()),
        ),
        updated_at: now.toISOString(),
      };
      let nextItem: JsonObject = { ...current.item, updated_at: now.toISOString() };
      let nextParticipants = [...current.participants];
      const events = [...current.recentEvents];
      if (existingLink === undefined) {
        events.push(
          calendarEvent(
            input.workItemId,
            "calendar_event_linked",
            input.actorUserId,
            persistedLink,
            now,
          ),
        );
      } else if (calendarLinkTimeChanged(existingLink, persistedLink)) {
        events.push(
          calendarEvent(
            input.workItemId,
            "calendar_event_rescheduled",
            input.actorUserId,
            persistedLink,
            now,
          ),
        );
      }
      if (
        stringField(persistedLink, "sync_status") === "canceled" &&
        optionalStringField(existingLink, "sync_status") !== "canceled"
      ) {
        events.push(
          calendarEvent(
            input.workItemId,
            "calendar_event_canceled",
            input.actorUserId,
            persistedLink,
            now,
          ),
        );
      }
      const startsAt = optionalStringField(persistedLink, "starts_at");
      if (input.applyStartsAtToDueAt === true) {
        nextItem = { ...nextItem, due_at: startsAt ?? null };
        events.push({
          actor_user_id: input.actorUserId,
          event_id: randomUUID(),
          occurred_at: now.toISOString(),
          payload: {
            calendar_link_id: stringField(persistedLink, "link_id"),
            from_due_at: current.item.due_at ?? null,
            to_due_at: startsAt ?? null,
          },
          type: "due_at_changed",
          work_item_id: input.workItemId,
        });
      }
      if (input.applyStartsAtToNextAttentionAtForUserId !== undefined) {
        nextParticipants = applyParticipantMutation(
          nextParticipants,
          {
            attentionUpdates: [
              {
                nextAttentionAt: startsAt,
                userId: input.applyStartsAtToNextAttentionAtForUserId,
              },
            ],
          },
          input.workItemId,
          now,
        );
        events.push({
          actor_user_id: input.actorUserId,
          affected_user_ids: [input.applyStartsAtToNextAttentionAtForUserId],
          event_id: randomUUID(),
          occurred_at: now.toISOString(),
          payload: {
            calendar_link_id: stringField(persistedLink, "link_id"),
            next_attention_at: startsAt ?? null,
          },
          type: "attention_scheduled",
          work_item_id: input.workItemId,
        });
      }

      const nextEvents = sortEvents(events);
      const nextLinks = [
        ...current.calendarLinks.filter(
          (link) => stringField(link, "link_id") !== stringField(persistedLink, "link_id"),
        ),
        persistedLink,
      ];
      const attentionIndexes = buildAttentionIndexes(nextItem, nextParticipants, nextEvents, now);
      await repositories.items.upsert(workItemRecord(nextItem));
      await repositories.calendarLinks.upsert(calendarLinkRecord(persistedLink));
      await replaceDocuments(
        repositories.participants,
        { team_id: input.teamId, work_item_id: input.workItemId },
        nextParticipants,
        participantRecord(input.teamId),
      );
      await replaceDocuments(
        repositories.events,
        { team_id: input.teamId, work_item_id: input.workItemId },
        nextEvents,
        eventRecord(input.teamId),
      );
      await replaceDocuments(
        repositories.attentionIndex,
        { team_id: input.teamId, work_item_id: input.workItemId },
        attentionIndexes,
        attentionIndexRecord,
      );
      return hydrateWorkItemAggregate({
        attentionIndexes,
        calendarLinks: nextLinks,
        events: nextEvents,
        item: nextItem,
        participants: nextParticipants,
        viewerUserId: input.actorUserId,
      });
    });
  }

  async unlinkCalendarEvent(input: {
    actorUserId: string;
    linkId: string;
    teamId: string;
    workItemId: string;
  }): Promise<WorkItemAggregateDocument> {
    return this.withTransaction(async (repositories) => {
      const current = await readAggregateInTransaction(
        repositories,
        input.teamId,
        input.workItemId,
      );
      if (current === undefined) {
        throw new Error(`Work item '${input.workItemId}' was not found.`);
      }
      const removedLink = current.calendarLinks.find(
        (link) => stringField(link, "link_id") === input.linkId,
      );
      if (removedLink === undefined) {
        throw new Error(`Calendar link '${input.linkId}' was not found.`);
      }
      const now = new Date();
      const nextItem = { ...current.item, updated_at: now.toISOString() };
      const nextEvents = sortEvents([
        ...current.recentEvents,
        calendarEvent(
          input.workItemId,
          "calendar_event_unlinked",
          input.actorUserId,
          removedLink,
          now,
        ),
      ]);
      const nextLinks = current.calendarLinks.filter(
        (link) => stringField(link, "link_id") !== input.linkId,
      );
      const attentionIndexes = buildAttentionIndexes(
        nextItem,
        current.participants,
        nextEvents,
        now,
      );
      await repositories.items.upsert(workItemRecord(nextItem));
      await repositories.calendarLinks.delete({
        link_id: input.linkId,
        team_id: input.teamId,
        work_item_id: input.workItemId,
      });
      await replaceDocuments(
        repositories.events,
        { team_id: input.teamId, work_item_id: input.workItemId },
        nextEvents,
        eventRecord(input.teamId),
      );
      await replaceDocuments(
        repositories.attentionIndex,
        { team_id: input.teamId, work_item_id: input.workItemId },
        attentionIndexes,
        attentionIndexRecord,
      );
      return hydrateWorkItemAggregate({
        attentionIndexes,
        calendarLinks: nextLinks,
        events: nextEvents,
        item: nextItem,
        participants: current.participants,
        viewerUserId: input.actorUserId,
      });
    });
  }

  private async withTransaction<T>(
    callback: (repositories: WorkItemTransactionRepositories) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const repositories = createWorkItemRepositories(client);
      const result = await callback(repositories);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
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

type WorkItemTransactionRepositories = {
  attentionIndex: PostgresJsonDocumentRepository<
    { team_id: string; user_id: string; work_item_id: string },
    JsonObject
  >;
  calendarLinks: PostgresJsonDocumentRepository<
    { link_id: string; team_id: string; work_item_id: string },
    JsonObject
  >;
  events: PostgresJsonDocumentRepository<
    { event_id: string; team_id: string; work_item_id: string },
    JsonObject
  >;
  items: PostgresJsonDocumentRepository<{ team_id: string; work_item_id: string }, JsonObject>;
  participants: PostgresJsonDocumentRepository<
    { team_id: string; user_id: string; work_item_id: string },
    JsonObject
  >;
};

const COMPLETED_STATUSES = new Set<WorkItemStatus>(["archived", "canceled", "done"]);
const DIRECTED_ATTENTION_EVENT_TYPES = new Set<WorkEventType>([
  "collaborator_added",
  "follower_added",
  "mentioned",
  "primary_assignee_changed",
]);
const RELEVANT_ATTENTION_EVENT_TYPES = new Set<WorkEventType>([
  ...DIRECTED_ATTENTION_EVENT_TYPES,
  "attention_scheduled",
  "blocked",
  "calendar_event_canceled",
  "calendar_event_linked",
  "calendar_event_rescheduled",
  "calendar_event_unlinked",
  "completed",
  "due_at_changed",
  "reopened",
  "status_changed",
  "unblocked",
  "work_item_created",
]);

function createWorkItemRepositories(client: PoolClient): WorkItemTransactionRepositories {
  const pool = client as never;
  return {
    attentionIndex: new PostgresJsonDocumentRepository(
      postgresDocumentTables.workItemAttentionIndex,
      {
        pool,
      },
    ),
    calendarLinks: new PostgresJsonDocumentRepository(postgresDocumentTables.workItemCalendarLink, {
      pool,
    }),
    events: new PostgresJsonDocumentRepository(postgresDocumentTables.workItemEvent, { pool }),
    items: new PostgresJsonDocumentRepository(postgresDocumentTables.workItem, { pool }),
    participants: new PostgresJsonDocumentRepository(postgresDocumentTables.workItemParticipant, {
      pool,
    }),
  };
}

async function readAggregateInTransaction(
  repositories: WorkItemTransactionRepositories,
  teamId: string,
  workItemId: string,
): Promise<WorkItemAggregateDocument | undefined> {
  const item = await repositories.items.find({ team_id: teamId, work_item_id: workItemId });
  if (item === undefined) {
    return undefined;
  }
  const key = { team_id: teamId, work_item_id: workItemId };
  const [participants, recentEvents, attentionIndexes, calendarLinks] = await Promise.all([
    repositories.participants.findByKeyPrefix(key),
    repositories.events.findByKeyPrefix(key),
    repositories.attentionIndex.findByKeyPrefix(key),
    repositories.calendarLinks.findByKeyPrefix(key),
  ]);
  return hydrateWorkItemAggregate({
    attentionIndexes,
    calendarLinks,
    events: recentEvents,
    item,
    participants,
  });
}

async function replaceDocuments<TKey extends PostgresColumnValues, TPayload extends JsonObject>(
  repository: PostgresJsonDocumentRepository<TKey, TPayload>,
  where: PostgresColumnValues,
  payloads: TPayload[],
  toRecord: (
    payload: TPayload,
  ) => Parameters<PostgresJsonDocumentRepository<TKey, TPayload>["upsert"]>[0],
): Promise<void> {
  await repository.deleteWhere(where);
  for (const payload of payloads) {
    await repository.upsert(toRecord(payload));
  }
}

function workItemRecord(item: JsonObject) {
  return {
    key: { team_id: teamId(item), work_item_id: workItemId(item) },
    payload: item,
    values: {
      audience_channel_id: item.audience_channel_id ?? null,
      completed_at: item.completed_at ?? null,
      due_at: item.due_at ?? null,
      primary_assignee_user_id: item.primary_assignee_user_id ?? null,
      status: stringField(item, "status", "captured"),
      title: stringField(item, "title", ""),
      updated_at: item.updated_at ?? new Date().toISOString(),
      visibility_kind: stringField(item, "visibility_kind", "private"),
    },
  };
}

function participantRecord(teamId: string) {
  return (participant: JsonObject) => ({
    key: {
      team_id: teamId,
      user_id: stringField(participant, "user_id"),
      work_item_id: workItemId(participant),
    },
    payload: participant,
    values: {
      attention_profile: stringField(participant, "attention_profile", "track"),
      last_seen_event_id: participant.last_seen_event_id ?? null,
      muted_until: participant.muted_until ?? null,
      next_attention_at: participant.next_attention_at ?? null,
      role: stringField(participant, "role", "follower"),
      updated_at: participant.updated_at ?? new Date().toISOString(),
    },
  });
}

function eventRecord(teamId: string) {
  return (event: JsonObject) => ({
    key: {
      event_id: stringField(event, "event_id"),
      team_id: teamId,
      work_item_id: workItemId(event),
    },
    payload: event,
    values: {
      occurred_at: event.occurred_at ?? new Date().toISOString(),
      type: stringField(event, "type"),
    },
  });
}

function attentionIndexRecord(attentionIndex: JsonObject) {
  return {
    key: {
      team_id: teamId(attentionIndex),
      user_id: stringField(attentionIndex, "user_id"),
      work_item_id: workItemId(attentionIndex),
    },
    payload: attentionIndex,
    values: {
      audience_channel_id: attentionIndex.audience_channel_id ?? null,
      needs_attention_now: booleanField(attentionIndex, "needs_attention_now") ?? false,
      primary_assignee_user_id: attentionIndex.primary_assignee_user_id ?? null,
      status: stringField(attentionIndex, "status", "captured"),
      updated_at: attentionIndex.updated_at ?? new Date().toISOString(),
      visibility_kind: stringField(attentionIndex, "visibility_kind", "private"),
    },
  };
}

function calendarLinkRecord(calendarLink: JsonObject) {
  return {
    key: {
      link_id: stringField(calendarLink, "link_id"),
      team_id: teamId(calendarLink),
      work_item_id: workItemId(calendarLink),
    },
    payload: calendarLink,
    values: {
      created_at: calendarLink.created_at ?? new Date().toISOString(),
      ends_at: calendarLink.ends_at ?? null,
      event_title_snapshot: calendarLink.event_title_snapshot ?? null,
      external_calendar_id: stringField(calendarLink, "external_calendar_id"),
      external_event_id: stringField(calendarLink, "external_event_id"),
      is_all_day: booleanField(calendarLink, "is_all_day") ?? false,
      last_synced_at: calendarLink.last_synced_at ?? null,
      provider_kind: stringField(calendarLink, "provider_kind"),
      response_status: calendarLink.response_status ?? null,
      starts_at: calendarLink.starts_at ?? null,
      sync_status: stringField(calendarLink, "sync_status", "active"),
      updated_at: calendarLink.updated_at ?? new Date().toISOString(),
    },
  };
}

function hydrateWorkItemAggregate(input: {
  attentionIndexes: JsonObject[];
  calendarLinks: JsonObject[];
  events: JsonObject[];
  item: JsonObject;
  participants: JsonObject[];
  viewerUserId?: string;
}): WorkItemAggregateDocument {
  return {
    attentionIndexes: input.attentionIndexes,
    calendarLinks: sortByStringField(input.calendarLinks, "created_at"),
    item: input.item,
    participants: sortByStringField(input.participants, "user_id"),
    recentEvents: sortEvents(input.events),
    viewerRelation:
      input.viewerUserId === undefined
        ? undefined
        : input.participants.find(
            (participant) => stringField(participant, "user_id") === input.viewerUserId,
          ),
  };
}

function applyItemMutation(
  item: JsonObject,
  patch: WorkItemPatch,
  options: { now: Date; primaryAssigneeUserId?: string },
): JsonObject {
  const next: JsonObject = { ...item };
  for (const fieldName of patch.clearFields ?? []) {
    if (["description", "due_at", "home_channel_id", "project_ref"].includes(fieldName)) {
      next[fieldName] = null;
    }
    if (["blocked_by_work_item_ids", "named_visibility_user_ids", "tags"].includes(fieldName)) {
      next[fieldName] = [];
    }
  }
  assignIfDefined(next, "title", patch.title);
  assignIfDefined(next, "description", patch.description);
  assignIfDefined(next, "status", patch.status);
  assignIfDefined(next, "priority", patch.priority);
  assignIfDefined(next, "due_at", dateValue(patch.dueAt));
  assignIfDefined(next, "visibility_kind", patch.visibilityKind);
  assignIfDefined(next, "named_visibility_user_ids", patch.namedVisibilityUserIds);
  assignIfDefined(next, "home_channel_id", patch.homeChannelId);
  assignIfDefined(next, "tags", patch.tags);
  assignIfDefined(next, "project_ref", patch.projectRef);
  next.primary_assignee_user_id = options.primaryAssigneeUserId ?? null;
  next.audience_channel_id = deriveAudienceChannelId(next);
  next.completed_at = completedAtForStatus(
    item,
    stringField(next, "status") as WorkItemStatus,
    options.now,
  );
  next.updated_at = options.now.toISOString();
  return next;
}

function applyParticipantMutation(
  currentParticipants: JsonObject[],
  mutation: WorkItemMutationDocument,
  workItemId: string,
  now: Date,
): JsonObject[] {
  const participants = new Map(
    currentParticipants.map((participant) => [
      stringField(participant, "user_id"),
      { ...participant },
    ]),
  );
  const ensureParticipant = (userId: string, role: ParticipantRole): JsonObject => {
    const existing = participants.get(userId);
    let attentionProfile = (stringField(
      existing,
      "attention_profile",
      defaultAttentionProfile(role),
    ) ?? defaultAttentionProfile(role)) as AttentionProfile;
    if (role === "primary_assignee" && attentionProfile === "mute") {
      attentionProfile = "focus";
    }
    const participant: JsonObject = {
      attention_profile: attentionProfile,
      joined_at: stringField(existing, "joined_at", now.toISOString()),
      last_seen_event_id: existing?.last_seen_event_id ?? null,
      muted_until: role === "primary_assignee" ? null : (existing?.muted_until ?? null),
      next_attention_at: existing?.next_attention_at ?? null,
      role,
      updated_at: now.toISOString(),
      user_id: userId,
      work_item_id: workItemId,
    };
    participants.set(userId, participant);
    return participant;
  };

  if (mutation.clearPrimaryAssignee === true || mutation.primaryAssigneeUserId !== undefined) {
    for (const [userId, participant] of participants.entries()) {
      if (stringField(participant, "role") === "primary_assignee") {
        participants.delete(userId);
      }
    }
  }
  if (mutation.primaryAssigneeUserId !== undefined) {
    ensureParticipant(mutation.primaryAssigneeUserId, "primary_assignee");
  }
  for (const userId of mutation.collaboratorUserIdsToAdd ?? []) {
    if (stringField(participants.get(userId), "role") !== "primary_assignee") {
      ensureParticipant(userId, "collaborator");
    }
  }
  for (const userId of mutation.collaboratorUserIdsToRemove ?? []) {
    if (stringField(participants.get(userId), "role") === "collaborator") {
      participants.delete(userId);
    }
  }
  for (const userId of mutation.followerUserIdsToAdd ?? []) {
    if (!participants.has(userId)) {
      ensureParticipant(userId, "follower");
    }
  }
  for (const userId of mutation.followerUserIdsToRemove ?? []) {
    if (stringField(participants.get(userId), "role") === "follower") {
      participants.delete(userId);
    }
  }
  for (const update of mutation.attentionUpdates ?? []) {
    const existing = participants.get(update.userId);
    if (existing === undefined && update.createIfMissing === false) {
      continue;
    }
    const participant =
      existing ?? ensureParticipant(update.userId, update.roleIfMissing ?? "follower");
    const role = stringField(participant, "role", "follower") as ParticipantRole;
    let attentionProfile =
      update.attentionProfile ??
      (stringField(participant, "attention_profile") as AttentionProfile);
    let mutedUntil: JsonValue =
      update.clearMutedUntil === true
        ? null
        : (dateValue(update.mutedUntil) ?? participant.muted_until ?? null);
    if (role === "primary_assignee" && attentionProfile === "mute") {
      attentionProfile = "focus";
      mutedUntil = null;
    }
    participants.set(update.userId, {
      ...participant,
      attention_profile: attentionProfile,
      muted_until: mutedUntil,
      next_attention_at:
        update.clearNextAttentionAt === true
          ? null
          : (dateValue(update.nextAttentionAt) ?? participant.next_attention_at ?? null),
      updated_at: now.toISOString(),
    });
  }
  return sortByStringField([...participants.values()], "user_id");
}

function buildAttentionIndexes(
  item: JsonObject,
  participants: JsonObject[],
  events: JsonObject[],
  now = new Date(),
): JsonObject[] {
  return participants.map((participant) => {
    const unseenEventTypes = unseenEventTypesForParticipant(
      events,
      optionalStringField(participant, "last_seen_event_id"),
    );
    const attentionProfile = stringField(
      participant,
      "attention_profile",
      "track",
    ) as AttentionProfile;
    const attention = deriveAttentionState({
      attentionProfile,
      mutedUntil: optionalStringField(participant, "muted_until"),
      nextAttentionAt: optionalStringField(participant, "next_attention_at"),
      now,
      unseenEventTypes,
    });
    return {
      attention_profile: attentionProfile,
      attention_reason: attention.reason ?? null,
      audience_channel_id: item.audience_channel_id ?? null,
      home_channel_id: item.home_channel_id ?? null,
      last_seen_event_id: participant.last_seen_event_id ?? null,
      needs_attention_now: attention.needsAttentionNow,
      next_attention_at: participant.next_attention_at ?? null,
      primary_assignee_user_id: item.primary_assignee_user_id ?? null,
      status: stringField(item, "status", "captured"),
      team_id: teamId(item),
      updated_at: now.toISOString(),
      user_id: stringField(participant, "user_id"),
      visibility_kind: stringField(item, "visibility_kind", "private"),
      work_item_id: workItemId(item),
    };
  });
}

function canViewWorkItem(
  aggregate: WorkItemAggregateDocument,
  viewerUserId: string,
  viewerContextChannelIds: readonly string[],
): boolean {
  if (
    aggregate.participants.some(
      (participant) => stringField(participant, "user_id") === viewerUserId,
    )
  ) {
    return true;
  }
  const visibilityKind = stringField(aggregate.item, "visibility_kind");
  if (visibilityKind === "private") {
    return false;
  }
  if (visibilityKind === "named") {
    return stringArrayField(aggregate.item, "named_visibility_user_ids").includes(viewerUserId);
  }
  if (visibilityKind === "context") {
    const audienceChannelId = optionalStringField(aggregate.item, "audience_channel_id");
    return audienceChannelId !== undefined && viewerContextChannelIds.includes(audienceChannelId);
  }
  return false;
}

function matchesWorkItemQuery(
  aggregate: WorkItemAggregateDocument,
  query: WorkItemQueryDocument,
): boolean {
  const item = aggregate.item;
  const participantUserIds = new Set(
    aggregate.participants.map((participant) => stringField(participant, "user_id")),
  );
  const status = stringField(item, "status") as WorkItemStatus;
  if (query.includeCompleted !== true && COMPLETED_STATUSES.has(status)) {
    return false;
  }
  if (
    query.statusIn !== undefined &&
    query.statusIn.length > 0 &&
    !query.statusIn.includes(status)
  ) {
    return false;
  }
  if (
    query.visibilityKind !== undefined &&
    stringField(item, "visibility_kind") !== query.visibilityKind
  ) {
    return false;
  }
  if (
    query.primaryAssigneeUserId !== undefined &&
    optionalStringField(item, "primary_assignee_user_id") !== query.primaryAssigneeUserId
  ) {
    return false;
  }
  if (query.participantUserId !== undefined && !participantUserIds.has(query.participantUserId)) {
    return false;
  }
  if (
    query.audienceChannelId !== undefined &&
    optionalStringField(item, "audience_channel_id") !== query.audienceChannelId
  ) {
    return false;
  }
  if (
    query.dueBefore !== undefined &&
    !isBeforeOrEqual(optionalStringField(item, "due_at"), query.dueBefore)
  ) {
    return false;
  }
  if (query.textQuery !== undefined && !matchesTextQuery(item, query.textQuery)) {
    return false;
  }
  if (query.needsAttentionOnly === true && !needsAttentionForViewer(aggregate)) {
    return false;
  }
  const viewerUserId = query.viewerUserId ?? "";
  switch (query.view ?? "inbox") {
    case "my_tasks":
      return optionalStringField(item, "primary_assignee_user_id") === viewerUserId;
    case "inbox":
      return participantUserIds.has(viewerUserId);
    case "channel_open": {
      const channelId = query.audienceChannelId ?? query.viewerChannelId;
      return (
        channelId !== undefined && optionalStringField(item, "audience_channel_id") === channelId
      );
    }
    case "done_recently":
      return COMPLETED_STATUSES.has(status);
    default:
      return true;
  }
}

function needsAttentionForViewer(aggregate: WorkItemAggregateDocument): boolean {
  const viewerRelation = aggregate.viewerRelation;
  if (viewerRelation === undefined) {
    return false;
  }
  return deriveAttentionState({
    attentionProfile: stringField(viewerRelation, "attention_profile", "track") as AttentionProfile,
    mutedUntil: optionalStringField(viewerRelation, "muted_until"),
    nextAttentionAt: optionalStringField(viewerRelation, "next_attention_at"),
    now: new Date(),
    unseenEventTypes: unseenEventTypesForParticipant(
      aggregate.recentEvents,
      optionalStringField(viewerRelation, "last_seen_event_id"),
    ),
  }).needsAttentionNow;
}

function deriveAttentionState(input: {
  attentionProfile: AttentionProfile;
  mutedUntil?: string;
  nextAttentionAt?: string;
  now: Date;
  unseenEventTypes: WorkEventType[];
}): { needsAttentionNow: boolean; reason?: string } {
  if (input.unseenEventTypes.some((eventType) => DIRECTED_ATTENTION_EVENT_TYPES.has(eventType))) {
    return { needsAttentionNow: true, reason: "directed_event" };
  }
  if (input.attentionProfile === "mute") {
    return { needsAttentionNow: false, reason: "mute" };
  }
  if (input.attentionProfile === "focus") {
    return { needsAttentionNow: true, reason: "focus" };
  }
  if (input.mutedUntil !== undefined && new Date(input.mutedUntil) > input.now) {
    return { needsAttentionNow: false, reason: "muted_until" };
  }
  if (input.nextAttentionAt !== undefined && new Date(input.nextAttentionAt) <= input.now) {
    return { needsAttentionNow: true, reason: "next_attention_at" };
  }
  if (input.unseenEventTypes.some((eventType) => RELEVANT_ATTENTION_EVENT_TYPES.has(eventType))) {
    return { needsAttentionNow: true, reason: "relevant_event" };
  }
  return { needsAttentionNow: false };
}

function unseenEventTypesForParticipant(
  events: JsonObject[],
  lastSeenEventId?: string,
): WorkEventType[] {
  if (lastSeenEventId === undefined) {
    return events.map((event) => stringField(event, "type") as WorkEventType);
  }
  const seenIndex = events.findIndex((event) => stringField(event, "event_id") === lastSeenEventId);
  return events
    .slice(seenIndex === -1 ? 0 : seenIndex + 1)
    .map((event) => stringField(event, "type") as WorkEventType);
}

function deriveAudienceChannelId(item: JsonObject): JsonValue {
  if (stringField(item, "visibility_kind") !== "context") {
    return null;
  }
  return optionalStringField(item, "home_channel_id") ?? stringField(item, "source_channel_id");
}

function defaultAttentionProfile(role: ParticipantRole): AttentionProfile {
  return role === "primary_assignee" ? "focus" : "track";
}

function completedAtForStatus(item: JsonObject, nextStatus: WorkItemStatus, now: Date): JsonValue {
  if (nextStatus === "done") {
    return item.completed_at ?? now.toISOString();
  }
  if (optionalStringField(item, "status") === "done") {
    return null;
  }
  return item.completed_at ?? null;
}

function findPrimaryAssigneeUserId(participants: JsonObject[]): string | undefined {
  return participants
    .filter((participant) => stringField(participant, "role") === "primary_assignee")
    .map((participant) => stringField(participant, "user_id"))[0];
}

function calendarEvent(
  workItemId: string,
  type: WorkEventType,
  actorUserId: string,
  calendarLink: JsonObject,
  occurredAt: Date,
): JsonObject {
  return {
    actor_user_id: actorUserId,
    event_id: randomUUID(),
    occurred_at: occurredAt.toISOString(),
    payload: {
      calendar_link: calendarLink,
      calendar_link_id: stringField(calendarLink, "link_id"),
      sync_status: optionalStringField(calendarLink, "sync_status") ?? null,
    },
    type,
    work_item_id: workItemId,
  };
}

function calendarLinkTimeChanged(current: JsonObject, nextLink: JsonObject): boolean {
  return (
    optionalStringField(current, "starts_at") !== optionalStringField(nextLink, "starts_at") ||
    optionalStringField(current, "ends_at") !== optionalStringField(nextLink, "ends_at")
  );
}

function sortEvents(events: JsonObject[]): JsonObject[] {
  return [...events].sort(
    (left, right) =>
      stringField(left, "occurred_at", "").localeCompare(stringField(right, "occurred_at", "")) ||
      stringField(left, "event_id", "").localeCompare(stringField(right, "event_id", "")),
  );
}

function sortValue(aggregate: WorkItemAggregateDocument, query: WorkItemQueryDocument): number {
  const field =
    query.view === "done_recently"
      ? (optionalStringField(aggregate.item, "completed_at") ??
        optionalStringField(aggregate.item, "updated_at"))
      : query.view === "needs_attention"
        ? (optionalStringField(aggregate.viewerRelation, "next_attention_at") ??
          optionalStringField(aggregate.item, "updated_at"))
        : optionalStringField(aggregate.item, "updated_at");
  return field === undefined ? 0 : new Date(field).getTime();
}

function isBeforeOrEqual(value: string | undefined, compareTo: Date | string): boolean {
  return value !== undefined && new Date(value).getTime() <= new Date(compareTo).getTime();
}

function matchesTextQuery(item: JsonObject, textQuery: string): boolean {
  const query = textQuery.toLocaleLowerCase();
  return (
    stringField(item, "title", "").toLocaleLowerCase().includes(query) ||
    stringField(item, "description", "").toLocaleLowerCase().includes(query) ||
    stringArrayField(item, "tags").some((tag) => tag.toLocaleLowerCase().includes(query))
  );
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

function teamId(payload: JsonObject): string {
  return stringField(payload, "team_id");
}

function workItemId(payload: JsonObject): string {
  return stringField(payload, "work_item_id");
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
  return typeof value === "string" ? value : undefined;
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

function dateValue(value: Date | string | undefined): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
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
