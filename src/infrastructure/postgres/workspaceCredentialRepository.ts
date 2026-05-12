import type { Pool } from "pg";

import type { JsonValue } from "../../domain/messageHistory.js";
import type {
  WorkspaceCredentialDocument,
  WorkspaceCredentialRepository,
} from "../../repositories/workspaceCredentials.js";
import type { CredentialProviderKind } from "../../providers/credentials.js";

export class PostgresWorkspaceCredentialRepository implements WorkspaceCredentialRepository {
  constructor(private readonly pool: Pool) {}

  async saveWorkspaceCredential(document: WorkspaceCredentialDocument): Promise<void> {
    await this.pool.query(
      `
        insert into workspace_credentials
          (team_id, provider_kind, credential_name, secret_encrypted, status,
           encryption_scheme, key_version, created_at, updated_at, created_by_user_id,
           last_used_at, last_error_code, payload)
        values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        on conflict (team_id, provider_kind, credential_name)
        do update set
          secret_encrypted = excluded.secret_encrypted,
          status = excluded.status,
          encryption_scheme = excluded.encryption_scheme,
          key_version = excluded.key_version,
          updated_at = excluded.updated_at,
          created_by_user_id = excluded.created_by_user_id,
          last_used_at = excluded.last_used_at,
          last_error_code = excluded.last_error_code,
          payload = excluded.payload
      `,
      [
        document.teamId,
        document.providerKind,
        document.credentialName,
        document.secretEncrypted,
        document.status,
        document.encryptionScheme,
        document.keyVersion,
        document.createdAt,
        document.updatedAt,
        document.createdByUserId ?? null,
        document.lastUsedAt ?? null,
        document.lastErrorCode ?? null,
        JSON.stringify(document.payload),
      ],
    );
  }

  async findWorkspaceCredential(input: {
    credentialName: string;
    providerKind: CredentialProviderKind;
    teamId: string;
  }): Promise<WorkspaceCredentialDocument | undefined> {
    const result = await this.pool.query<WorkspaceCredentialRow>(
      `
        select team_id, provider_kind, credential_name, secret_encrypted, status,
               encryption_scheme, key_version, created_at, updated_at, created_by_user_id,
               last_used_at, last_error_code, payload
        from workspace_credentials
        where team_id = $1
          and provider_kind = $2
          and credential_name = $3
      `,
      [input.teamId, input.providerKind, input.credentialName],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapWorkspaceCredential(row);
  }
}

type WorkspaceCredentialRow = {
  created_at: Date;
  created_by_user_id: string | null;
  credential_name: string;
  encryption_scheme: string;
  key_version: string;
  last_error_code: string | null;
  last_used_at: Date | null;
  payload: Record<string, JsonValue>;
  provider_kind: CredentialProviderKind;
  secret_encrypted: string;
  status: WorkspaceCredentialDocument["status"];
  team_id: string;
  updated_at: Date;
};

function mapWorkspaceCredential(row: WorkspaceCredentialRow): WorkspaceCredentialDocument {
  return {
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id ?? undefined,
    credentialName: row.credential_name,
    encryptionScheme: row.encryption_scheme,
    keyVersion: row.key_version,
    lastErrorCode: row.last_error_code ?? undefined,
    lastUsedAt: row.last_used_at ?? undefined,
    payload: row.payload,
    providerKind: row.provider_kind,
    secretEncrypted: row.secret_encrypted,
    status: row.status,
    teamId: row.team_id,
    updatedAt: row.updated_at,
  };
}
