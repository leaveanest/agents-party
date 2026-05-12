import type { JsonValue } from "../domain/messageHistory.js";
import type { LlmProvider, LlmRequest } from "./contracts.js";

export type CredentialProviderKind = LlmProvider | "google_maps";

export type ProviderCredential = {
  apiKey: string;
  baseURL?: string;
};

export type ProviderCredentialLookup = {
  credentialName?: string;
  provider: CredentialProviderKind;
  workspaceId: string;
};

export type ProviderCredentialResolver = {
  resolveProviderCredential(
    input: ProviderCredentialLookup,
  ): Promise<ProviderCredential | undefined>;
};

export class MissingWorkspaceCredentialError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly provider: CredentialProviderKind,
    readonly credentialName = "api_key",
  ) {
    super(
      `No active workspace credential '${credentialName}' is configured for provider '${provider}' in workspace '${workspaceId}'.`,
    );
    this.name = "MissingWorkspaceCredentialError";
  }
}

export class MissingWorkspaceContextError extends Error {
  constructor(readonly provider: CredentialProviderKind) {
    super(`Workspace context is required before resolving credentials for provider '${provider}'.`);
    this.name = "MissingWorkspaceContextError";
  }
}

export async function resolveCredentialForRequest(
  resolver: ProviderCredentialResolver | undefined,
  request: Pick<LlmRequest, "context">,
  provider: CredentialProviderKind,
  credentialName = "api_key",
): Promise<ProviderCredential | undefined> {
  if (resolver === undefined) {
    return undefined;
  }
  if (request.context?.workspaceId === undefined) {
    throw new MissingWorkspaceContextError(provider);
  }
  const credential = await resolver.resolveProviderCredential({
    credentialName,
    provider,
    workspaceId: request.context.workspaceId,
  });
  if (credential === undefined) {
    throw new MissingWorkspaceCredentialError(
      request.context.workspaceId,
      provider,
      credentialName,
    );
  }
  return credential;
}

export function stringPayloadField(
  payload: Record<string, JsonValue> | undefined,
  field: string,
): string | undefined {
  const value = payload?.[field];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
