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
    const result = await this.pool.query<JsonDocumentRow<TPayload>>(
      `select ${selectDocumentColumns(this.table, this.payloadColumn)}
       from ${quoteIdentifier(this.table.tableName)}
       where ${whereClause(this.table.keyColumns)}`,
      this.table.keyColumns.map((column) => requiredValue(key, column)),
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mergeDocumentRow(row, this.table, this.payloadColumn);
  }

  async findByKeyPrefix(where: PostgresColumnValues): Promise<TPayload[]> {
    return this.list(where);
  }

  async deleteWhere(where: PostgresColumnValues): Promise<void> {
    const entries = Object.entries(where);
    if (entries.length === 0) {
      throw new Error("deleteWhere requires at least one predicate.");
    }
    const clauses = entries.map(([column], index) => `${quoteIdentifier(column)} = $${index + 1}`);
    await this.pool.query(
      `delete from ${quoteIdentifier(this.table.tableName)}
       where ${clauses.join(" and ")}`,
      entries.map(([, value]) => value),
    );
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
    const result = await this.pool.query<JsonDocumentRow<TPayload>>(
      `select ${selectDocumentColumns(this.table, this.payloadColumn)}
       from ${quoteIdentifier(this.table.tableName)}
       ${clauses.length > 0 ? `where ${clauses.join(" and ")}` : ""}`,
      entries.map(([, value]) => value),
    );
    return result.rows.map((row) => mergeDocumentRow(row, this.table, this.payloadColumn));
  }
}

type JsonDocumentRow<TPayload extends JsonObject> = {
  payload: TPayload;
} & Record<string, PostgresColumnValue | null | undefined>;

export const postgresDocumentTables = {
  agent: {
    columns: ["enabled", "updated_at"],
    keyColumns: ["agent_id"],
    tableName: "agents",
  },
  channelAppSettings: {
    columns: ["default_agent_id", "default_model_id", "thread_auto_reply", "updated_at"],
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
  salesforcePdfTemplate: {
    columns: ["action", "status", "updated_at"],
    keyColumns: ["team_id", "salesforce_org_id", "template_id"],
    tableName: "salesforce_pdf_templates",
  },
  salesforcePdfWorkflowSetting: {
    columns: ["enabled", "template_id", "updated_at"],
    keyColumns: ["team_id", "salesforce_org_id", "action"],
    tableName: "salesforce_pdf_workflow_settings",
  },
  slackThread: {
    columns: [
      "agent_id",
      "model_id",
      "root_message_ts",
      "last_message_ts",
      "status",
      "created_at",
      "updated_at",
    ],
    keyColumns: ["team_id", "channel_id", "thread_ts"],
    tableName: "slack_threads",
  },
  workspaceAppSettings: {
    columns: [
      "default_agent_id",
      "default_model_id",
      "enabled_model_ids",
      "thread_auto_reply",
      "updated_at",
    ],
    keyColumns: ["team_id"],
    tableName: "workspace_app_settings",
  },
} as const satisfies Record<string, JsonDocumentTable>;

function whereClause(columns: readonly string[]): string {
  return columns.map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`).join(" and ");
}

function selectDocumentColumns(table: JsonDocumentTable, payloadColumn: string): string {
  const columns = [payloadColumn, ...table.keyColumns, ...(table.columns ?? [])];
  return [...new Set(columns)]
    .map((column) => `${quoteIdentifier(column)} as ${quoteIdentifier(column)}`)
    .join(", ");
}

function mergeDocumentRow<TPayload extends JsonObject>(
  row: JsonDocumentRow<TPayload>,
  table: JsonDocumentTable,
  payloadColumn: string,
): TPayload {
  const payload: JsonObject = { ...row.payload };
  for (const column of [...table.keyColumns, ...(table.columns ?? [])]) {
    if (column === payloadColumn) {
      continue;
    }
    if (!Object.hasOwn(row, column)) {
      continue;
    }
    const value = row[column];
    if (value === null || value === undefined) {
      delete payload[column];
      continue;
    }
    payload[column] = toJsonValue(value);
  }
  return payload as TPayload;
}

function toJsonValue(value: PostgresColumnValue): JsonValue {
  return value instanceof Date ? value.toISOString() : value;
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
