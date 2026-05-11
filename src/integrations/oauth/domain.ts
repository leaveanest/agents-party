import { createHash, randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import type { JsonObject } from "../../infrastructure/postgres/jsonDocumentRepository.js";

export const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

export const SALESFORCE_OAUTH_SCOPES = ["api", "refresh_token", "id"] as const;

export type GoogleOAuthStartContext = z.infer<typeof googleOAuthStartContextSchema>;
export type GoogleOAuthStateToken = z.infer<typeof googleOAuthStateTokenSchema>;
export type GoogleOAuthState = z.infer<typeof googleOAuthStateSchema>;
export type GoogleOAuthTokens = z.infer<typeof googleOAuthTokensSchema>;
export type GoogleIdentityClaims = z.infer<typeof googleIdentityClaimsSchema>;
export type GoogleAuthConnection = z.infer<typeof googleAuthConnectionSchema>;
export type SalesforceOAuthStartContext = z.infer<typeof salesforceOAuthStartContextSchema>;
export type SalesforceOAuthStateToken = z.infer<typeof salesforceOAuthStateTokenSchema>;
export type SalesforceOAuthState = z.infer<typeof salesforceOAuthStateSchema>;
export type SalesforceOAuthTokens = z.infer<typeof salesforceOAuthTokensSchema>;
export type SalesforceIdentity = z.infer<typeof salesforceIdentitySchema>;
export type SalesforceAuthConfig = z.infer<typeof salesforceAuthConfigSchema>;
export type SalesforceConnection = z.infer<typeof salesforceConnectionSchema>;

export const dateSchema = z.iso.datetime().transform((value) => new Date(value));

export const googleOAuthStartContextSchema = z.object({
  expires_at: dateSchema,
  redirect_after_connect: z.string().nullable().default(null),
  slack_user_id: z.string().min(1),
  team_id: z.string().min(1),
});

export const googleOAuthStateTokenSchema = z.object({
  expires_at: dateSchema,
  state_id: z.string().min(1),
  team_id: z.string().min(1),
});

export const googleOAuthStateSchema = z.object({
  created_at: dateSchema.optional(),
  expires_at: dateSchema,
  redirect_after_connect: z.string().nullable().default(null),
  requested_scopes: z.array(z.string()).default([...GOOGLE_OAUTH_SCOPES]),
  slack_user_id: z.string().min(1),
  state_id: z.string().min(1),
  team_id: z.string().min(1),
});

export const googleOAuthTokensSchema = z.object({
  access_token: z.string().min(1),
  expires_at: dateSchema.optional(),
  granted_scopes: z.array(z.string()).default([]),
  id_token: z.string().optional(),
  refresh_token: z.string().optional(),
  refresh_token_expires_at: dateSchema.optional(),
});

export const googleIdentityClaimsSchema = z.object({
  email: z.string().nullable().optional(),
  email_verified: z.boolean().default(false),
  subject: z.string().min(1),
});

export const googleAuthConnectionSchema = z.object({
  access_token_encrypted: z.string().min(1),
  connection_status: z.string().default("active"),
  created_at: dateSchema,
  google_account_email: z.string().nullable().optional(),
  google_account_email_verified: z.boolean().default(false),
  google_account_subject: z.string().min(1),
  granted_scopes: z.array(z.string()).default([]),
  last_refresh_error_at: dateSchema.nullable().optional(),
  last_refresh_error_code: z.string().nullable().optional(),
  last_refreshed_at: dateSchema.nullable().optional(),
  last_successful_access_at: dateSchema.nullable().optional(),
  refresh_token_encrypted: z.string().nullable().optional(),
  refresh_token_expires_at: dateSchema.nullable().optional(),
  slack_user_id: z.string().min(1),
  team_id: z.string().min(1),
  token_expires_at: dateSchema.nullable().optional(),
  updated_at: dateSchema,
});

export const salesforceOAuthStartContextSchema = z.object({
  expires_at: dateSchema,
  redirect_after_connect: z.string().nullable().default(null),
  salesforce_org_id: z.string().min(1),
  slack_user_id: z.string().min(1),
  team_id: z.string().min(1),
});

export const salesforceOAuthStateTokenSchema = z.object({
  expires_at: dateSchema,
  state_id: z.string().min(1),
  team_id: z.string().min(1),
});

export const salesforceOAuthStateSchema = z.object({
  created_at: dateSchema.optional(),
  expires_at: dateSchema,
  pkce_code_verifier_encrypted: z.string().min(1),
  redirect_after_connect: z.string().nullable().default(null),
  requested_scopes: z.array(z.string()).default([...SALESFORCE_OAUTH_SCOPES]),
  salesforce_org_id: z.string().min(1),
  slack_user_id: z.string().min(1),
  state_id: z.string().min(1),
  team_id: z.string().min(1),
});

export const salesforceAuthConfigSchema = z.object({
  app_type: z.string().default("external_client_app"),
  created_at: dateSchema.optional(),
  default_scopes: z.array(z.string()).default([...SALESFORCE_OAUTH_SCOPES]),
  oauth_client_id: z.string().min(1),
  oauth_client_secret_encrypted: z.string().nullable().optional(),
  redirect_uri: z.string().url(),
  salesforce_my_domain_host: z.string().min(1).transform(normalizeSalesforceHost),
  salesforce_org_id: z.string().min(1),
  salesforce_org_name: z.string().nullable().optional(),
  status: z.string().default("active"),
  team_id: z.string().min(1),
  updated_at: dateSchema.optional(),
});

export const salesforceOAuthTokensSchema = z.object({
  access_token: z.string().min(1),
  expires_at: dateSchema.optional(),
  granted_scopes: z.array(z.string()).default([]),
  identity_url: z.string().url().optional(),
  instance_url: z.string().url().optional(),
  refresh_token: z.string().optional(),
});

export const salesforceIdentitySchema = z.object({
  email: z.string().nullable().optional(),
  identity_url: z.string().url().optional(),
  organization_id: z.string().min(1),
  user_id: z.string().min(1),
  username: z.string().nullable().optional(),
});

export const salesforceConnectionSchema = z.object({
  access_token_encrypted: z.string().min(1),
  connection_status: z.string().default("active"),
  created_at: dateSchema,
  granted_scopes: z.array(z.string()).default([]),
  last_refresh_error_at: dateSchema.nullable().optional(),
  last_refresh_error_code: z.string().nullable().optional(),
  last_refreshed_at: dateSchema.nullable().optional(),
  last_successful_access_at: dateSchema.nullable().optional(),
  refresh_token_encrypted: z.string().nullable().optional(),
  salesforce_identity_url: z.string().url(),
  salesforce_instance_url: z.string().url().optional(),
  salesforce_org_id: z.string().min(1),
  salesforce_user_email: z.string().nullable().optional(),
  salesforce_user_id: z.string().min(1),
  salesforce_username: z.string().nullable().optional(),
  slack_user_id: z.string().min(1),
  team_id: z.string().min(1),
  token_expires_at: dateSchema.nullable().optional(),
  updated_at: dateSchema,
});

export function normalizeRedirectAfterConnect(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === "") {
    return null;
  }
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error("OAuth redirect_after_connect must be a relative path.");
  }
  const url = new URL(value, "https://agents-party.local");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function createStateId(): string {
  return randomUUID();
}

export function createPkceCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

export function buildPkceCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function calculateExpiration(expiresInSeconds: number | undefined): Date | undefined {
  if (expiresInSeconds === undefined || !Number.isFinite(expiresInSeconds)) {
    return undefined;
  }
  return new Date(Date.now() + expiresInSeconds * 1000);
}

export function isSalesforceHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "salesforce.com" ||
    host.endsWith(".salesforce.com") ||
    host.endsWith(".force.com") ||
    host.endsWith(".my.salesforce.com")
  );
}

export function normalizeSalesforceHost(host: string): string {
  const value = host.includes("://") ? host : `https://${host}`;
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname === "" ||
    !isSalesforceHost(parsed.hostname)
  ) {
    throw new Error("Salesforce host must be an HTTPS Salesforce-owned host.");
  }
  return parsed.hostname.toLowerCase();
}

export function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function toIso(value: Date | undefined | null): string | null {
  return value === undefined || value === null ? null : value.toISOString();
}
