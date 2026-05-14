import { z } from "zod";

import type { JsonValue } from "../../domain/messageHistory.js";
import {
  SoracomApiError,
  SoracomClient,
  soracomRateLimitToJson,
  type SoracomCoverageType,
  type SoracomCredential,
  type SoracomResponse,
} from "../../integrations/soracom/index.js";
import type { ProviderCredentialResolver } from "../../providers/credentials.js";
import type { AgentToolDefinition } from "../toolContracts.js";

export type SoracomToolContext = {
  teamId: string;
};

export type SoracomToolOptions = {
  context: SoracomToolContext;
  credentialResolver?: ProviderCredentialResolver;
  fetchFn?: typeof fetch;
};

const soracomGetSimStatusInputSchema = z
  .object({
    idType: z.enum(["auto", "sim_id", "imsi", "iccid"]).default("auto").optional(),
    resourceId: z.string().trim().min(1),
  })
  .strict();

const soracomFindResourcesInputSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(10).optional(),
    query: z.string().trim().min(1),
    resourceTypes: z
      .array(z.enum(["sim", "soracam_device"]))
      .default(["sim", "soracam_device"])
      .optional(),
  })
  .strict();

const soracomGetSimStatusHistoryInputSchema = z
  .object({
    from: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).default(20).optional(),
    simId: z.string().trim().min(1),
    to: z.number().int().nonnegative().optional(),
  })
  .strict();

const soracomListSoraCamDevicesInputSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(20).optional(),
    query: z.string().trim().min(1).optional(),
  })
  .strict();

const soracomListSoraCamEventsInputSchema = z
  .object({
    deviceId: z.string().trim().min(1).optional(),
    from: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).default(20).optional(),
    sort: z.enum(["asc", "desc"]).default("desc").optional(),
    to: z.number().int().nonnegative().optional(),
  })
  .strict();

const soracomGetSoraCamExportUsageInputSchema = z
  .object({
    deviceId: z.string().trim().min(1),
  })
  .strict();

const soracomToolOutputSchema = z
  .object({
    code: z.string().optional(),
    message: z.string(),
    ok: z.boolean(),
    rateLimit: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

type SoracomToolOutput = Record<string, JsonValue> & {
  code?: string;
  message: string;
  ok: boolean;
  rateLimit?: JsonValue;
};

export function createSoracomAgentTools(options: SoracomToolOptions): AgentToolDefinition[] {
  return [
    {
      description:
        "Get the current read-only status of a SORACOM SIM by SIM ID, IMSI, or ICCID. Use this for questions like whether a SIM is active or currently online.",
      execute: async (input) =>
        withSoracomClient(options, async (client) => {
          const parsed = input as z.infer<typeof soracomGetSimStatusInputSchema>;
          const resolved = await resolveSim(client, parsed.resourceId, parsed.idType ?? "auto");
          if (resolved === undefined) {
            return failure("not_found", "No matching SORACOM SIM was found.");
          }
          return success("SORACOM SIM status retrieved.", {
            sim: normalizeSim(resolved.body),
            rateLimit: soracomRateLimitToJson(resolved.rateLimit),
          });
        }),
      name: "soracom_get_sim_status",
      outputSchema: soracomToolOutputSchema as z.ZodType<JsonValue>,
      parameters: z.toJSONSchema(soracomGetSimStatusInputSchema) as JsonValue,
      schema: soracomGetSimStatusInputSchema as z.ZodType<JsonValue>,
    },
    {
      description:
        "Find SORACOM SIMs or SoraCam devices by ID, name, or tag. Use this before a more specific tool when the user's wording is ambiguous.",
      execute: async (input) =>
        withSoracomClient(options, async (client) => {
          const parsed = input as z.infer<typeof soracomFindResourcesInputSchema>;
          const resourceTypes = parsed.resourceTypes ?? ["sim", "soracam_device"];
          const limit = parsed.limit ?? 10;
          const resources: JsonValue[] = [];
          if (resourceTypes.includes("sim")) {
            const sims = await listAllSims(client);
            resources.push(
              ...sims.items
                .map((sim) => resourceCandidate("sim", normalizeSim(sim), parsed.query))
                .filter((candidate): candidate is JsonValue => candidate !== undefined),
            );
          }
          if (resourceTypes.includes("soracam_device")) {
            const devices = await client.listSoraCamDevices();
            resources.push(
              ...normalizeCollection(devices.body)
                .map((device) =>
                  resourceCandidate("soracam_device", normalizeSoraCamDevice(device), parsed.query),
                )
                .filter((candidate): candidate is JsonValue => candidate !== undefined),
            );
          }
          return success("SORACOM resources searched.", {
            resources: resources.slice(0, limit),
          });
        }),
      name: "soracom_find_resources",
      outputSchema: soracomToolOutputSchema as z.ZodType<JsonValue>,
      parameters: z.toJSONSchema(soracomFindResourcesInputSchema) as JsonValue,
      schema: soracomFindResourcesInputSchema as z.ZodType<JsonValue>,
    },
    {
      description:
        "List recent SORACOM SIM status and session history. Use this for questions such as whether a SIM recently disconnected.",
      execute: async (input) =>
        withSoracomClient(options, async (client) => {
          const parsed = input as z.infer<typeof soracomGetSimStatusHistoryInputSchema>;
          const [statusHistory, sessionEvents] = await Promise.all([
            client.listSimStatusHistory(parsed),
            client.listSimSessionEvents(parsed),
          ]);
          return success("SORACOM SIM history retrieved.", {
            rateLimit: soracomRateLimitToJson(statusHistory.rateLimit ?? sessionEvents.rateLimit),
            sessionEvents: normalizeCollection(sessionEvents.body).map(normalizeEvent),
            statusHistory: normalizeCollection(statusHistory.body).map(normalizeEvent),
          });
        }),
      name: "soracom_get_sim_status_history",
      outputSchema: soracomToolOutputSchema as z.ZodType<JsonValue>,
      parameters: z.toJSONSchema(soracomGetSimStatusHistoryInputSchema) as JsonValue,
      schema: soracomGetSimStatusHistoryInputSchema as z.ZodType<JsonValue>,
    },
    {
      description:
        "List SORACOM SoraCam compatible camera devices. This is read-only and does not start live image, stream, or export operations.",
      execute: async (input) =>
        withSoracomClient(options, async (client) => {
          const parsed = input as z.infer<typeof soracomListSoraCamDevicesInputSchema>;
          const response = await client.listSoraCamDevices();
          const query = parsed.query?.toLowerCase();
          const devices = normalizeCollection(response.body)
            .map(normalizeSoraCamDevice)
            .filter((device) => query === undefined || jsonMatchesQuery(device, query))
            .slice(0, parsed.limit ?? 20);
          return success("SoraCam devices retrieved.", {
            devices,
            rateLimit: soracomRateLimitToJson(response.rateLimit),
          });
        }),
      name: "soracom_list_soracam_devices",
      outputSchema: soracomToolOutputSchema as z.ZodType<JsonValue>,
      parameters: z.toJSONSchema(soracomListSoraCamDevicesInputSchema) as JsonValue,
      schema: soracomListSoraCamDevicesInputSchema as z.ZodType<JsonValue>,
    },
    {
      description: "List SoraCam events. This is read-only and does not export images or videos.",
      execute: async (input) =>
        withSoracomClient(options, async (client) => {
          const parsed = input as z.infer<typeof soracomListSoraCamEventsInputSchema>;
          const response = await client.listSoraCamDeviceEvents(parsed);
          return success("SoraCam events retrieved.", {
            events: normalizeCollection(response.body).map(normalizeEvent),
            rateLimit: soracomRateLimitToJson(response.rateLimit),
          });
        }),
      name: "soracom_list_soracam_events",
      outputSchema: soracomToolOutputSchema as z.ZodType<JsonValue>,
      parameters: z.toJSONSchema(soracomListSoraCamEventsInputSchema) as JsonValue,
      schema: soracomListSoraCamEventsInputSchema as z.ZodType<JsonValue>,
    },
    {
      description:
        "Get read-only SoraCam image/video export usage for one device. This never starts an export.",
      execute: async (input) =>
        withSoracomClient(options, async (client) => {
          const parsed = input as z.infer<typeof soracomGetSoraCamExportUsageInputSchema>;
          const response = await client.getSoraCamDeviceExportUsage(parsed.deviceId);
          return success("SoraCam export usage retrieved.", {
            rateLimit: soracomRateLimitToJson(response.rateLimit),
            usage: normalizeJson(response.body),
          });
        }),
      name: "soracom_get_soracam_export_usage",
      outputSchema: soracomToolOutputSchema as z.ZodType<JsonValue>,
      parameters: z.toJSONSchema(soracomGetSoraCamExportUsageInputSchema) as JsonValue,
      schema: soracomGetSoraCamExportUsageInputSchema as z.ZodType<JsonValue>,
    },
  ];
}

async function withSoracomClient(
  options: SoracomToolOptions,
  callback: (client: SoracomClient) => Promise<SoracomToolOutput>,
): Promise<SoracomToolOutput> {
  const credential = await resolveSoracomCredential(options);
  if (credential === undefined) {
    return failure(
      "missing_soracom_credential",
      "SORACOM AuthKey is not configured for this Slack workspace.",
    );
  }
  try {
    return await callback(new SoracomClient({ credential, fetchFn: options.fetchFn }));
  } catch (error) {
    if (error instanceof SoracomApiError) {
      return failure(error.details.code ?? `http_${error.details.status}`, error.message, {
        rateLimit: soracomRateLimitToJson(error.details.rateLimit),
        retriable: error.details.retriable,
        status: error.details.status,
      });
    }
    throw error;
  }
}

async function resolveSoracomCredential(
  options: SoracomToolOptions,
): Promise<SoracomCredential | undefined> {
  const credential = await options.credentialResolver?.resolveProviderCredential({
    credentialName: "auth_key",
    provider: "soracom",
    workspaceId: options.context.teamId,
  });
  if (credential === undefined) {
    return undefined;
  }
  const authKeyId = stringField(credential.payload, "auth_key_id");
  if (authKeyId === undefined) {
    return undefined;
  }
  return {
    authKey: credential.apiKey,
    authKeyId,
    coverageType: coverageField(credential.payload) ?? "global",
    operatorId: stringField(credential.payload, "operator_id"),
  };
}

async function resolveSim(
  client: SoracomClient,
  resourceId: string,
  idType: "auto" | "sim_id" | "imsi" | "iccid",
): Promise<SoracomResponse | undefined> {
  const value = resourceId.trim();
  if (idType === "sim_id" || (idType === "auto" && /^sim-/iu.test(value))) {
    return client.getSim(value);
  }
  const sims = await listAllSims(client);
  const match = sims.items.find((sim) => {
    const normalized = normalizeSim(sim);
    if (idType === "imsi") {
      return normalized.imsi === value;
    }
    if (idType === "iccid") {
      return normalized.iccid === value;
    }
    return normalized.simId === value || normalized.imsi === value || normalized.iccid === value;
  });
  return match === undefined ? undefined : { body: match, rateLimit: sims.rateLimit };
}

async function listAllSims(
  client: SoracomClient,
  input: { limit?: number } = {},
): Promise<{ items: unknown[]; rateLimit?: SoracomResponse["rateLimit"] }> {
  const items: unknown[] = [];
  let lastEvaluatedKey: string | undefined;
  let rateLimit: SoracomResponse["rateLimit"];
  let hasNextPage = true;
  while (hasNextPage) {
    const response = await client.listSims({
      lastEvaluatedKey,
      limit: input.limit ?? 100,
    });
    items.push(...normalizeCollection(response.body));
    rateLimit = response.rateLimit;
    lastEvaluatedKey = response.pagination?.nextKey;
    hasNextPage = lastEvaluatedKey !== undefined;
  }
  return { items, rateLimit };
}

function normalizeSim(input: unknown): Record<string, JsonValue> {
  const record = recordOrEmpty(input);
  const tags = recordField(record, "tags");
  const status = stringField(record, "status") ?? stringField(record, "subscriptionStatus");
  const sessionStatusRecord =
    recordField(record, "sessionStatus") ?? recordField(record, "session_status");
  const sessionOnlineValue = sessionOnline(record, sessionStatusRecord);
  const sessionStatus =
    stringField(record, "sessionStatus") ??
    stringField(record, "session_status") ??
    (sessionOnlineValue === undefined ? undefined : sessionOnlineValue ? "online" : "offline");
  return compactRecord({
    diagnosticHints: diagnosticHints(status, sessionStatus),
    groupId: stringField(record, "groupId") ?? stringField(record, "group_id"),
    iccid: stringField(record, "iccid"),
    imsi: stringField(record, "imsi"),
    lastModifiedTime:
      numberField(record, "lastModifiedTime") ??
      numberField(record, "last_modified_time") ??
      numberField(sessionStatusRecord ?? {}, "lastUpdatedAt"),
    sessionOnline: sessionOnlineValue,
    sessionStatus,
    simId: stringField(record, "simId") ?? stringField(record, "sim_id"),
    status,
    tags: normalizeJson(tags ?? {}),
  });
}

function normalizeSoraCamDevice(input: unknown): Record<string, JsonValue> {
  const record = recordOrEmpty(input);
  return compactRecord({
    connected: booleanField(record, "connected"),
    deviceId: stringField(record, "deviceId") ?? stringField(record, "device_id"),
    firmwareVersion:
      stringField(record, "firmwareVersion") ?? stringField(record, "firmware_version"),
    lastModifiedTime:
      numberField(record, "lastModifiedTime") ?? numberField(record, "last_modified_time"),
    name: stringField(record, "name"),
    productDisplayName:
      stringField(record, "productDisplayName") ?? stringField(record, "product_display_name"),
    tags: normalizeJson(recordField(record, "tags") ?? {}),
  });
}

function normalizeEvent(input: unknown): Record<string, JsonValue> {
  const record = recordOrEmpty(input);
  return compactRecord({
    deviceId: stringField(record, "deviceId") ?? stringField(record, "device_id"),
    event:
      stringField(record, "event") ??
      stringField(record, "eventType") ??
      stringField(record, "type"),
    eventId: stringField(record, "eventId") ?? stringField(record, "event_id"),
    message: stringField(record, "message"),
    time: numberField(record, "time") ?? numberField(record, "timestamp"),
  });
}

function normalizeCollection(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }
  const record = recordOrEmpty(input);
  for (const key of ["items", "sims", "devices", "events", "results"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function resourceCandidate(
  resourceType: "sim" | "soracam_device",
  normalized: Record<string, JsonValue>,
  query: string,
): JsonValue | undefined {
  const lowerQuery = query.toLowerCase();
  if (!jsonMatchesQuery(normalized, lowerQuery)) {
    return undefined;
  }
  return compactRecord({
    confidenceHint: "matched_id_name_or_tag",
    displayName:
      typeof normalized.name === "string"
        ? normalized.name
        : typeof normalized.simId === "string"
          ? normalized.simId
          : normalized.deviceId,
    id:
      typeof normalized.simId === "string"
        ? normalized.simId
        : typeof normalized.deviceId === "string"
          ? normalized.deviceId
          : undefined,
    resourceType,
    tags: normalized.tags,
  });
}

function diagnosticHints(
  status: string | undefined,
  sessionStatus: string | undefined,
): JsonValue[] {
  const hints: string[] = [];
  if (status !== undefined && /suspend|terminated|inactive/iu.test(status)) {
    hints.push(`SIM status is ${status}.`);
  }
  if (sessionStatus !== undefined && !/online|active/iu.test(sessionStatus)) {
    hints.push(`Session status is ${sessionStatus}.`);
  }
  return hints;
}

function sessionOnline(
  record: Record<string, unknown>,
  sessionStatusRecord: Record<string, unknown> | undefined,
): boolean | undefined {
  const explicit = booleanField(record, "sessionOnline") ?? booleanField(record, "session_online");
  if (explicit !== undefined) {
    return explicit;
  }
  return booleanField(sessionStatusRecord ?? {}, "online");
}

function success(
  message: string,
  fields: Record<string, JsonValue | undefined>,
): SoracomToolOutput {
  return compactRecord({ ...fields, message, ok: true }) as SoracomToolOutput;
}

function failure(
  code: string,
  message: string,
  fields: Record<string, JsonValue | undefined> = {},
): SoracomToolOutput {
  return compactRecord({ ...fields, code, message, ok: false }) as SoracomToolOutput;
}

function compactRecord(input: Record<string, JsonValue | undefined>): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function jsonMatchesQuery(value: JsonValue, lowerQuery: string): boolean {
  return JSON.stringify(value).toLowerCase().includes(lowerQuery);
}

function normalizeJson(input: unknown): JsonValue {
  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return input;
  }
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : null;
  }
  if (Array.isArray(input)) {
    return input.map(normalizeJson);
  }
  if (typeof input === "object" && input !== null) {
    const output: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(input)) {
      output[key] = normalizeJson(value);
    }
    return output;
  }
  return null;
}

function recordOrEmpty(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function recordField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = record[field];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  return typeof value === "boolean" ? value : undefined;
}

function coverageField(
  payload: Record<string, unknown> | undefined,
): SoracomCoverageType | undefined {
  const value = stringField(payload, "coverage_type");
  return value === "global" || value === "japan" ? value : undefined;
}
