import type { JsonValue } from "../domain/messageHistory.js";
import type {
  CredentialProviderKind,
  ProviderCredential,
  ProviderCredentialResolver,
} from "../providers/credentials.js";
import { stringPayloadField } from "../providers/credentials.js";
import type { FernetTextCipher } from "../integrations/oauth/fernet.js";

export type WorkspaceCredentialStatus = "active" | "disabled" | "revoked";

export type WorkspaceCredentialPayload = Record<string, JsonValue>;

export type WorkspaceCredentialDocument = {
  createdAt: Date;
  createdByUserId?: string;
  credentialName: string;
  encryptionScheme: string;
  keyVersion: string;
  lastErrorCode?: string;
  lastUsedAt?: Date;
  payload: WorkspaceCredentialPayload;
  providerKind: CredentialProviderKind;
  secretEncrypted: string;
  status: WorkspaceCredentialStatus;
  teamId: string;
  updatedAt: Date;
};

export type SaveWorkspaceCredentialInput = {
  createdAt?: Date;
  createdByUserId?: string;
  credentialName?: string;
  keyVersion?: string;
  payload?: WorkspaceCredentialPayload;
  providerKind: CredentialProviderKind;
  secret: string;
  status?: WorkspaceCredentialStatus;
  teamId: string;
  updatedAt?: Date;
};

export type WorkspaceCredentialRepository = {
  findWorkspaceCredential(input: {
    credentialName: string;
    providerKind: CredentialProviderKind;
    teamId: string;
  }): Promise<WorkspaceCredentialDocument | undefined>;
  saveWorkspaceCredential(document: WorkspaceCredentialDocument): Promise<void>;
};

export class UnsafeWorkspaceCredentialPayloadError extends Error {
  constructor(readonly fieldPath: string) {
    super(`Workspace credential payload must not contain secret-like field '${fieldPath}'.`);
    this.name = "UnsafeWorkspaceCredentialPayloadError";
  }
}

export class UnsupportedWorkspaceCredentialEncryptionError extends Error {
  constructor(
    readonly encryptionScheme: string,
    readonly keyVersion: string,
  ) {
    super(
      `Unsupported workspace credential encryption metadata '${encryptionScheme}' with key version '${keyVersion}'.`,
    );
    this.name = "UnsupportedWorkspaceCredentialEncryptionError";
  }
}

export class EncryptedWorkspaceCredentialService implements ProviderCredentialResolver {
  constructor(
    private readonly repository: WorkspaceCredentialRepository,
    private readonly cipher: FernetTextCipher,
  ) {}

  async saveProviderApiKey(input: SaveWorkspaceCredentialInput): Promise<void> {
    const now = new Date();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    const credentialName = input.credentialName ?? "api_key";
    const keyVersion = input.keyVersion ?? "v1";
    assertSupportedEncryptionMetadata("fernet", keyVersion);
    assertSafePayload(input.payload);
    const payload: WorkspaceCredentialPayload = {
      ...input.payload,
      credential_name: credentialName,
      provider_kind: input.providerKind,
      team_id: input.teamId,
    };
    await this.repository.saveWorkspaceCredential({
      createdAt,
      createdByUserId: input.createdByUserId,
      credentialName,
      encryptionScheme: "fernet",
      keyVersion,
      payload,
      providerKind: input.providerKind,
      secretEncrypted: this.cipher.encrypt(input.secret),
      status: input.status ?? "active",
      teamId: input.teamId,
      updatedAt,
    });
  }

  async resolveProviderCredential(input: {
    credentialName?: string;
    provider: CredentialProviderKind;
    workspaceId: string;
  }): Promise<ProviderCredential | undefined> {
    const document = await this.repository.findWorkspaceCredential({
      credentialName: input.credentialName ?? "api_key",
      providerKind: input.provider,
      teamId: input.workspaceId,
    });
    if (document === undefined || document.status !== "active") {
      return undefined;
    }
    assertSupportedEncryption(document);
    return {
      apiKey: this.cipher.decrypt(document.secretEncrypted),
      baseURL: stringPayloadField(document.payload, "base_url"),
    };
  }
}

function assertSupportedEncryption(document: WorkspaceCredentialDocument): void {
  assertSupportedEncryptionMetadata(document.encryptionScheme, document.keyVersion);
}

function assertSupportedEncryptionMetadata(encryptionScheme: string, keyVersion: string): void {
  if (encryptionScheme !== "fernet" || keyVersion !== "v1") {
    throw new UnsupportedWorkspaceCredentialEncryptionError(encryptionScheme, keyVersion);
  }
}

function assertSafePayload(payload: WorkspaceCredentialPayload | undefined): void {
  if (payload === undefined) {
    return;
  }
  for (const [key, value] of Object.entries(payload)) {
    assertSafePayloadValue(key, value);
  }
}

function assertSafePayloadValue(path: string, value: JsonValue): void {
  if (SECRET_LIKE_PAYLOAD_FIELD_PATTERN.test(path.split(".").at(-1) ?? path)) {
    throw new UnsafeWorkspaceCredentialPayloadError(path);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafePayloadValue(`${path}.${index}`, item));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertSafePayloadValue(`${path}.${key}`, child);
    }
  }
}

const SECRET_LIKE_PAYLOAD_FIELD_PATTERN =
  /(^|_)(api_?key|access_?token|auth_?token|client_?secret|password|refresh_?token|secret|token)(_|$)/iu;
