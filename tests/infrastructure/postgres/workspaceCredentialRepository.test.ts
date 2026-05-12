import { describe, expect, it } from "vite-plus/test";

import { FernetTextCipher } from "../../../src/integrations/oauth/fernet.js";
import { PostgresWorkspaceCredentialRepository } from "../../../src/infrastructure/postgres/workspaceCredentialRepository.js";
import {
  EncryptedWorkspaceCredentialService,
  UnsafeWorkspaceCredentialPayloadError,
  UnsupportedWorkspaceCredentialEncryptionError,
} from "../../../src/repositories/workspaceCredentials.js";

const fernetKey = "TogY-XNU4lqwqpU3n8ugin31axgCOj0bvbxNnWb9f0w=";

describe("workspace credential repository", () => {
  it("stores encrypted workspace credentials in a dedicated secret column", async () => {
    const pool = new RecordingPool();
    const service = new EncryptedWorkspaceCredentialService(
      new PostgresWorkspaceCredentialRepository(pool as never),
      new FernetTextCipher(fernetKey),
    );

    await service.saveProviderApiKey({
      createdAt: new Date("2026-05-12T00:00:00Z"),
      createdByUserId: "U1",
      payload: { base_url: "https://proxy.example" },
      providerKind: "openai",
      secret: "workspace-api-key",
      teamId: "T1",
      updatedAt: new Date("2026-05-12T00:00:00Z"),
    });

    const [query] = pool.queries;
    expect(query?.text).toContain("insert into workspace_credentials");
    expect(query?.values).not.toContain("workspace-api-key");
    expect(query?.values?.[3]).toEqual(expect.any(String));
    expect(query?.values?.[12]).toBe(
      JSON.stringify({
        base_url: "https://proxy.example",
        credential_name: "api_key",
        provider_kind: "openai",
        team_id: "T1",
      }),
    );
  });

  it("decrypts active credentials for provider invocation", async () => {
    const cipher = new FernetTextCipher(fernetKey);
    const service = new EncryptedWorkspaceCredentialService(
      new PostgresWorkspaceCredentialRepository(
        new RecordingPool([
          {
            created_at: new Date("2026-05-12T00:00:00Z"),
            created_by_user_id: "U1",
            credential_name: "api_key",
            encryption_scheme: "fernet",
            key_version: "v1",
            last_error_code: null,
            last_used_at: null,
            payload: { base_url: "https://proxy.example" },
            provider_kind: "openai",
            secret_encrypted: cipher.encrypt("workspace-api-key"),
            status: "active",
            team_id: "T1",
            updated_at: new Date("2026-05-12T00:00:00Z"),
          },
        ]) as never,
      ),
      cipher,
    );

    await expect(
      service.resolveProviderCredential({ provider: "openai", workspaceId: "T1" }),
    ).resolves.toEqual({
      apiKey: "workspace-api-key",
      baseURL: "https://proxy.example",
    });
  });

  it("rejects secret-like payload fields before storing metadata", async () => {
    const pool = new RecordingPool();
    const service = new EncryptedWorkspaceCredentialService(
      new PostgresWorkspaceCredentialRepository(pool as never),
      new FernetTextCipher(fernetKey),
    );

    await expect(
      service.saveProviderApiKey({
        payload: { client_secret: "should-not-be-here" },
        providerKind: "openai",
        secret: "workspace-api-key",
        teamId: "T1",
      }),
    ).rejects.toThrow(UnsafeWorkspaceCredentialPayloadError);
    expect(pool.queries).toHaveLength(0);
  });

  it("rejects unsupported encryption metadata before decrypting", async () => {
    const cipher = new FernetTextCipher(fernetKey);
    const service = new EncryptedWorkspaceCredentialService(
      new PostgresWorkspaceCredentialRepository(
        new RecordingPool([
          {
            created_at: new Date("2026-05-12T00:00:00Z"),
            created_by_user_id: null,
            credential_name: "api_key",
            encryption_scheme: "unknown",
            key_version: "v2",
            last_error_code: null,
            last_used_at: null,
            payload: {},
            provider_kind: "openai",
            secret_encrypted: cipher.encrypt("workspace-api-key"),
            status: "active",
            team_id: "T1",
            updated_at: new Date("2026-05-12T00:00:00Z"),
          },
        ]) as never,
      ),
      cipher,
    );

    await expect(
      service.resolveProviderCredential({ provider: "openai", workspaceId: "T1" }),
    ).rejects.toThrow(UnsupportedWorkspaceCredentialEncryptionError);
  });

  it("rejects unsupported key versions before storing credentials", async () => {
    const pool = new RecordingPool();
    const service = new EncryptedWorkspaceCredentialService(
      new PostgresWorkspaceCredentialRepository(pool as never),
      new FernetTextCipher(fernetKey),
    );

    await expect(
      service.saveProviderApiKey({
        keyVersion: "v2",
        providerKind: "openai",
        secret: "workspace-api-key",
        teamId: "T1",
      }),
    ).rejects.toThrow(UnsupportedWorkspaceCredentialEncryptionError);
    expect(pool.queries).toHaveLength(0);
  });
});

class RecordingPool {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];

  constructor(private readonly rows: unknown[] = []) {}

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text: text.trim().replace(/\s+/gu, " "), values });
    if (text.includes("select")) {
      return { rows: this.rows };
    }
    return { rows: [] };
  }
}
