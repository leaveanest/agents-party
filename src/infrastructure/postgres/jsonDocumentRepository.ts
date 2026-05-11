import { Pool } from "pg";

import type { JsonValue } from "../../domain/messageHistory.js";

export type JsonObject = {
  [key: string]: JsonValue;
};

export type PostgresColumnValue = JsonValue | Date;

export type PostgresColumnValues = {
  [key: string]: PostgresColumnValue;
};

export type JsonDocumentTable = {
  columns?: readonly string[];
  keyColumns: readonly string[];
  payloadColumn?: string;
  tableName: string;
};

export type JsonDocumentRecord<TKey extends PostgresColumnValues, TPayload extends JsonObject> = {
  key: TKey;
  payload: TPayload;
  values?: PostgresColumnValues;
};

export class PostgresJsonDocumentRepository<
  TKey extends PostgresColumnValues,
  TPayload extends JsonObject,
> {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly payloadColumn: string;

  constructor(
    private readonly table: JsonDocumentTable,
    options: { databaseUrl?: string; pool?: Pool },
  ) {
    validateIdentifier(table.tableName);
    for (const column of [...table.keyColumns, ...(table.columns ?? [])]) {
      validateIdentifier(column);
    }
    this.payloadColumn = table.payloadColumn ?? "payload";
    validateIdentifier(this.payloadColumn);

    if (options.pool === undefined && options.databaseUrl === undefined) {
      throw new Error("databaseUrl or pool is required for PostgreSQL document repositories.");
    }
    this.pool = options.pool ?? new Pool({ connectionString: options.databaseUrl });
    this.ownsPool = options.pool === undefined;
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async upsert(record: JsonDocumentRecord<TKey, TPayload>): Promise<void> {
    const keyColumns = [...this.table.keyColumns];
    const valueColumns = this.table.columns ?? [];
    const columns = [...keyColumns, ...valueColumns, this.payloadColumn];
    const values = [
      ...keyColumns.map((column) => requiredValue(record.key, column)),
      ...valueColumns.map((column) => record.values?.[column] ?? null),
      JSON.stringify(record.payload),
    ];
    const placeholders = values.map((_, index) => `$${index + 1}`);
    const updateAssignments = [...valueColumns, this.payloadColumn].map(
      (column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`,
    );

    await this.pool.query(
      `insert into ${quoteIdentifier(this.table.tableName)}
       (${columns.map(quoteIdentifier).join(", ")})
       values (${placeholders.join(", ")})
       on conflict (${keyColumns.map(quoteIdentifier).join(", ")})
       do update set ${updateAssignments.join(", ")}`,
      values,
    );
  }

  async find(key: TKey): Promise<TPayload | undefined> {
    const result = await this.pool.query<{ payload: TPayload }>(
      `select ${quoteIdentifier(this.payloadColumn)} as payload
       from ${quoteIdentifier(this.table.tableName)}
       where ${whereClause(this.table.keyColumns)}`,
      this.table.keyColumns.map((column) => requiredValue(key, column)),
    );
    return result.rows[0]?.payload;
  }

  async findByKeyPrefix(where: PostgresColumnValues): Promise<TPayload[]> {
    return this.list(where);
  }

  async delete(key: TKey): Promise<void> {
    await this.pool.query(
      `delete from ${quoteIdentifier(this.table.tableName)}
       where ${whereClause(this.table.keyColumns)}`,
      this.table.keyColumns.map((column) => requiredValue(key, column)),
    );
  }

  async consume(key: TKey): Promise<TPayload | undefined> {
    const result = await this.pool.query<{ payload: TPayload }>(
      `delete from ${quoteIdentifier(this.table.tableName)}
       where ${whereClause(this.table.keyColumns)}
       returning ${quoteIdentifier(this.payloadColumn)} as payload`,
      this.table.keyColumns.map((column) => requiredValue(key, column)),
    );
    return result.rows[0]?.payload;
  }

  async list(where: PostgresColumnValues = {}): Promise<TPayload[]> {
    const entries = Object.entries(where);
    const clauses = entries.map(([column], index) => `${quoteIdentifier(column)} = $${index + 1}`);
    const result = await this.pool.query<{ payload: TPayload }>(
      `select ${quoteIdentifier(this.payloadColumn)} as payload
       from ${quoteIdentifier(this.table.tableName)}
       ${clauses.length > 0 ? `where ${clauses.join(" and ")}` : ""}`,
      entries.map(([, value]) => value),
    );
    return result.rows.map((row) => row.payload);
  }
}

export const postgresDocumentTables = {
  agent: {
    columns: ["enabled", "updated_at"],
    keyColumns: ["agent_id"],
    tableName: "agents",
  },
  channelAppSettings: {
    columns: ["default_agent_id", "thread_auto_reply", "updated_at"],
    keyColumns: ["team_id", "channel_id"],
    tableName: "channel_app_settings",
  },
  googleAuthConnection: {
    columns: [
      "google_account_email",
      "connection_status",
      "token_expires_at",
      "refresh_token_expires_at",
      "updated_at",
    ],
    keyColumns: ["team_id", "slack_user_id", "google_account_subject"],
    tableName: "google_auth_connections",
  },
  googleOAuthState: {
    columns: ["slack_user_id", "expires_at", "created_at"],
    keyColumns: ["team_id", "state_id"],
    tableName: "google_oauth_states",
  },
  salesforceAuthConfig: {
    columns: ["salesforce_my_domain_host", "oauth_client_id", "status", "updated_at"],
    keyColumns: ["team_id", "salesforce_org_id"],
    tableName: "salesforce_auth_configs",
  },
  salesforceConnection: {
    columns: [
      "salesforce_user_id",
      "salesforce_username",
      "connection_status",
      "token_expires_at",
      "updated_at",
    ],
    keyColumns: ["team_id", "slack_user_id", "salesforce_org_id"],
    tableName: "salesforce_connections",
  },
  salesforceOAuthState: {
    columns: ["slack_user_id", "salesforce_org_id", "expires_at", "created_at"],
    keyColumns: ["team_id", "state_id"],
    tableName: "salesforce_oauth_states",
  },
  slackThread: {
    columns: [
      "agent_id",
      "root_message_ts",
      "last_message_ts",
      "status",
      "created_at",
      "updated_at",
    ],
    keyColumns: ["team_id", "channel_id", "thread_ts"],
    tableName: "slack_threads",
  },
  workItem: {
    columns: [
      "title",
      "status",
      "visibility_kind",
      "audience_channel_id",
      "primary_assignee_user_id",
      "due_at",
      "updated_at",
      "completed_at",
    ],
    keyColumns: ["team_id", "work_item_id"],
    tableName: "work_items",
  },
  workItemCalendarLink: {
    columns: [
      "provider_kind",
      "external_calendar_id",
      "external_event_id",
      "event_title_snapshot",
      "starts_at",
      "ends_at",
      "is_all_day",
      "response_status",
      "sync_status",
      "last_synced_at",
      "created_at",
      "updated_at",
    ],
    keyColumns: ["team_id", "work_item_id", "link_id"],
    tableName: "work_item_calendar_links",
  },
  workItemAttentionIndex: {
    columns: [
      "needs_attention_now",
      "status",
      "visibility_kind",
      "audience_channel_id",
      "primary_assignee_user_id",
      "updated_at",
    ],
    keyColumns: ["team_id", "user_id", "work_item_id"],
    tableName: "work_item_attention_index",
  },
  workItemEvent: {
    columns: ["type", "occurred_at"],
    keyColumns: ["team_id", "work_item_id", "event_id"],
    tableName: "work_item_events",
  },
  workItemParticipant: {
    columns: [
      "role",
      "attention_profile",
      "next_attention_at",
      "muted_until",
      "last_seen_event_id",
      "updated_at",
    ],
    keyColumns: ["team_id", "work_item_id", "user_id"],
    tableName: "work_item_participants",
  },
  workspaceAppSettings: {
    columns: ["default_agent_id", "thread_auto_reply", "updated_at"],
    keyColumns: ["team_id"],
    tableName: "workspace_app_settings",
  },
} as const satisfies Record<string, JsonDocumentTable>;

function whereClause(columns: readonly string[]): string {
  return columns.map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`).join(" and ");
}

function requiredValue(values: PostgresColumnValues, column: string): PostgresColumnValue {
  const value = values[column];
  if (value === undefined) {
    throw new Error(`Missing required key column '${column}'.`);
  }
  return value;
}

function validateIdentifier(identifier: string): void {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe SQL identifier '${identifier}'.`);
  }
}

function quoteIdentifier(identifier: string): string {
  validateIdentifier(identifier);
  return `"${identifier}"`;
}
