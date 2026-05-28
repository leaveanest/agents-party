import { createMCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";

import type { JsonValue } from "../../domain/messageHistory.js";
import { DEFAULT_SLACK_MCP_SERVER_URL } from "../../integrations/slackMcp/client.js";

export type SlackMcpTokenLookup = {
  enterpriseId?: string;
  isEnterpriseInstall?: boolean;
  teamId: string;
  userId: string;
};

export type SlackMcpTokenResolution = {
  scopes?: string[];
  token: string;
};

export type SlackMcpTokenResolver = {
  resolve(input: SlackMcpTokenLookup): Promise<SlackMcpTokenResolution | undefined>;
};

export type SlackMcpToolContext = SlackMcpTokenLookup & {
  sourceText: string;
  viewerContextChannelIds: string[];
};

export type SlackMcpCanvasAccessSetter = {
  setCanvasAccess(input: SlackMcpCanvasAccessSetInput): Promise<void>;
};

export type SlackMcpCanvasAccessSetInput = SlackMcpTokenLookup & {
  accessLevel: "read" | "write";
  canvasId: string;
  channelIds: string[];
  token: string;
};

export type SlackMcpToolSetHandle = {
  close(): Promise<void>;
  tools: ToolSet;
};

export type SlackMcpToolSetClient = {
  close(): Promise<void>;
  tools(): Promise<ToolSet>;
};

export type SlackMcpToolSetOptions = {
  canvasAccessSetter?: SlackMcpCanvasAccessSetter;
  clientFactory?: (input: { token: string }) => Promise<SlackMcpToolSetClient>;
  context: SlackMcpToolContext;
  logger?: unknown;
  serverUrl?: string;
  tokenResolver: SlackMcpTokenResolver;
  toolsListTimeoutMs?: number;
};

type SlackMcpToolWrapOptions = {
  canvasAccessSetter?: SlackMcpCanvasAccessSetter;
  logger?: unknown;
  token: string;
};

const DEFAULT_SLACK_MCP_TOOLS_LIST_TIMEOUT_MS = 2500;

const allowedSlackMcpToolNames = [
  "slack_create_canvas",
  "slack_read_canvas",
  "slack_search_public",
  "slack_read_channel",
  "slack_read_thread",
  "slack_read_user_profile",
  "slack_update_canvas",
] as const;

export async function createSlackMcpToolSet(
  options: SlackMcpToolSetOptions,
): Promise<SlackMcpToolSetHandle | undefined> {
  const resolution = await options.tokenResolver.resolve(options.context);
  if (resolution === undefined || resolution.token.trim().length === 0) {
    return undefined;
  }

  const client = await (options.clientFactory ?? defaultSlackMcpClientFactory(options))({
    token: resolution.token,
  });
  try {
    const tools = filterAndWrapSlackMcpTools(
      await withTimeout(
        client.tools(),
        Math.max(1, options.toolsListTimeoutMs ?? DEFAULT_SLACK_MCP_TOOLS_LIST_TIMEOUT_MS),
        "Slack MCP tools list",
      ),
      options.context,
      {
        canvasAccessSetter: options.canvasAccessSetter,
        logger: options.logger,
        token: resolution.token,
      },
    );
    return {
      close: () => client.close(),
      tools,
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

function defaultSlackMcpClientFactory(options: SlackMcpToolSetOptions) {
  return async (input: { token: string }): Promise<SlackMcpToolSetClient> => {
    const client = await createMCPClient({
      clientName: "agents-party-slack-mcp",
      transport: {
        headers: {
          Authorization: `Bearer ${input.token}`,
        },
        redirect: "error",
        type: "http",
        url: options.serverUrl ?? DEFAULT_SLACK_MCP_SERVER_URL,
      },
      version: "0.1.0",
    });
    return {
      close: () => client.close(),
      tools: async () => client.tools() as Promise<ToolSet>,
    };
  };
}

function filterAndWrapSlackMcpTools(
  tools: ToolSet,
  context: SlackMcpToolContext,
  options: SlackMcpToolWrapOptions,
): ToolSet {
  const filtered: ToolSet = {};
  for (const toolName of allowedSlackMcpToolNames) {
    const mcpTool = tools[toolName];
    const execute = mcpTool?.execute;
    if (mcpTool === undefined || execute === undefined) {
      continue;
    }
    filtered[toolName] = {
      ...mcpTool,
      async execute(input, executionOptions) {
        const toolInput = slackMcpToolInput(context, toolName, input, mcpTool);
        const accessFailure = validateSlackMcpToolAccess(
          context,
          toolName,
          toolInput as Record<string, unknown>,
        );
        if (accessFailure !== undefined) {
          return accessFailure;
        }
        const result = await execute(toolInput, executionOptions);
        return shareCreatedCanvasIfPossible(context, toolName, result, options);
      },
    };
  }
  return filtered;
}

async function shareCreatedCanvasIfPossible(
  context: SlackMcpToolContext,
  toolName: string,
  result: unknown,
  options: SlackMcpToolWrapOptions,
): Promise<unknown> {
  if (toolName !== "slack_create_canvas" || options.canvasAccessSetter === undefined) {
    return result;
  }
  const canvasId = extractCanvasId(result, context.teamId);
  if (canvasId === undefined) {
    logWarn(options.logger, "Slack MCP Canvas creation result did not include a Canvas id.", {
      teamId: context.teamId,
      userId: context.userId,
    });
    return appendCanvasShareStatus(
      result,
      "Canvas was created, but Agents Party could not identify the created Canvas id to share it with the current Slack channel.",
    );
  }
  const channelIds = regularChannelIds(context.viewerContextChannelIds);
  if (channelIds.length === 0) {
    return result;
  }
  try {
    await options.canvasAccessSetter.setCanvasAccess({
      accessLevel: "read",
      canvasId,
      channelIds,
      enterpriseId: context.enterpriseId,
      isEnterpriseInstall: context.isEnterpriseInstall,
      teamId: context.teamId,
      token: options.token,
      userId: context.userId,
    });
    return result;
  } catch (error) {
    logWarn(options.logger, "Failed to share Slack MCP-created Canvas with invocation channel.", {
      canvasId,
      channelIds,
      error,
      teamId: context.teamId,
      userId: context.userId,
    });
    return appendCanvasShareStatus(
      result,
      "Canvas was created, but Agents Party could not share it with the current Slack channel. Tell the user that channel sharing failed and include the Canvas link.",
    );
  }
}

function regularChannelIds(channelIds: string[]): string[] {
  return [...new Set(channelIds.map((channelId) => channelId.trim()).filter(isRegularChannelId))];
}

function isRegularChannelId(channelId: string): boolean {
  return /^[CG][A-Z0-9]+$/i.test(channelId);
}

function extractCanvasId(value: unknown, teamId: string): string | undefined {
  const candidates = extractCanvasIdCandidates(value, teamId, 0, new Set<unknown>());
  return candidates.length === 1 ? candidates[0] : undefined;
}

function extractCanvasIdCandidates(
  value: unknown,
  teamId: string,
  depth: number,
  seen: Set<unknown>,
): string[] {
  if (depth > 8) {
    return [];
  }
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return [];
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return uniqueStrings(
      value.flatMap((item) => extractCanvasIdCandidates(item, teamId, depth + 1, seen)),
    );
  }
  const record = value as Record<string, unknown>;
  const candidates: string[] = [];
  for (const key of ["canvas_id", "canvasId", "file_id", "fileId"]) {
    const fieldValue = record[key];
    if (typeof fieldValue === "string" && isCanvasId(fieldValue.trim())) {
      candidates.push(fieldValue.trim());
    }
  }
  for (const key of ["canvas_url", "canvasUrl", "url", "permalink"]) {
    candidates.push(...canvasIdsFromSlackDocsUrls(record[key], teamId));
  }
  for (const nestedValue of Object.values(record)) {
    candidates.push(...extractCanvasIdCandidates(nestedValue, teamId, depth + 1, seen));
  }
  const urlCandidates = canvasIdsFromSlackDocsUrlsInResultText(record, teamId);
  return uniqueStrings([...candidates, ...urlCandidates]);
}

function canvasIdsFromSlackDocsUrls(value: unknown, teamId: string): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return slackDocsUrlCanvasIds(value, teamId);
}

function canvasIdsFromSlackDocsUrlsInResultText(
  result: Record<string, unknown>,
  teamId: string,
): string[] {
  const content = result.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const candidates = content.flatMap((item) => {
    if (!isRecord(item) || typeof item.text !== "string") {
      return [];
    }
    return slackDocsUrlCanvasIds(item.text, teamId);
  });
  return uniqueStrings(candidates).length === 1 ? uniqueStrings(candidates) : [];
}

function slackDocsUrlCanvasIds(value: string, teamId: string): string[] {
  return uniqueStrings(
    [...value.matchAll(/https:\/\/app\.slack\.com\/docs\/([a-z0-9]+)\/(f[a-z0-9]{7,})/gi)]
      .filter((match) => match[1]?.toLowerCase() === teamId.toLowerCase())
      .map((match) => match[2])
      .filter((canvasId): canvasId is string => canvasId !== undefined && isCanvasId(canvasId)),
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Map(values.map((value) => [value.toLowerCase(), value])).values()];
}

function appendCanvasShareStatus(result: unknown, message: string): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return result;
  }
  return {
    ...result,
    content: [
      ...result.content,
      {
        text: message,
        type: "text",
      },
    ],
  };
}

function slackMcpToolInput(
  context: SlackMcpToolContext,
  toolName: string,
  input: unknown,
  tool: ToolSet[string],
): unknown {
  if (toolName !== "slack_create_canvas" || !isRecord(input)) {
    return input;
  }
  const channelId = context.viewerContextChannelIds[0];
  if (channelId === undefined) {
    return input;
  }
  const withChannel = { ...input };
  if (schemaHasProperty(tool, "channel_ids") && withChannel.channel_ids === undefined) {
    withChannel.channel_ids = [channelId];
  }
  if (schemaHasProperty(tool, "channel_id") && withChannel.channel_id === undefined) {
    withChannel.channel_id = channelId;
  }
  if (schemaHasProperty(tool, "channelIds") && withChannel.channelIds === undefined) {
    withChannel.channelIds = [channelId];
  }
  if (schemaHasProperty(tool, "channelId") && withChannel.channelId === undefined) {
    withChannel.channelId = channelId;
  }
  return withChannel;
}

function schemaHasProperty(tool: ToolSet[string], propertyName: string): boolean {
  return JSON.stringify(tool.inputSchema ?? {}).includes(`"${propertyName}"`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSlackMcpToolAccess(
  context: SlackMcpToolContext,
  toolName: string,
  input: Record<string, unknown>,
): JsonValue | undefined {
  if (toolName !== "slack_read_channel" && toolName !== "slack_read_thread") {
    return (
      validateSlackMcpCreateCanvasAccess(context, toolName, input) ??
      validateSlackMcpCanvasAccess(context, toolName, input)
    );
  }
  const channelId = typeof input.channel_id === "string" ? input.channel_id.trim() : "";
  if (channelId.length > 0 && context.viewerContextChannelIds.includes(channelId)) {
    return undefined;
  }
  return failure(
    toolName,
    "slack_mcp_channel_not_allowed",
    "Slack MCP channel reads are limited to the channel that started this agent invocation.",
    false,
  );
}

function validateSlackMcpCreateCanvasAccess(
  context: SlackMcpToolContext,
  toolName: string,
  input: Record<string, unknown>,
): JsonValue | undefined {
  if (toolName !== "slack_create_canvas") {
    return undefined;
  }
  const channelIds = readCanvasShareChannelIds(input);
  if (channelIds.every((channelId) => context.viewerContextChannelIds.includes(channelId))) {
    return undefined;
  }
  return failure(
    toolName,
    "slack_mcp_channel_not_allowed",
    "Slack MCP Canvas creation can only share to the channel that started this agent invocation.",
    false,
  );
}

function readCanvasShareChannelIds(input: Record<string, unknown>): string[] {
  const channelIds = [
    ...readChannelIdList(input.channel_ids),
    ...readChannelIdList(input.channelIds),
    ...readChannelIdList(input.channel_id),
    ...readChannelIdList(input.channelId),
  ];
  return [...new Set(channelIds.map((channelId) => channelId.trim()).filter(Boolean))];
}

function readChannelIdList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function validateSlackMcpCanvasAccess(
  context: SlackMcpToolContext,
  toolName: string,
  input: Record<string, unknown>,
): JsonValue | undefined {
  if (toolName !== "slack_update_canvas") {
    return undefined;
  }
  const canvasId = readCanvasId(input);
  const explicitUpdateTarget = explicitCanvasUpdateTarget(context.sourceText);
  if (
    canvasId !== undefined &&
    explicitUpdateTarget !== undefined &&
    explicitUpdateTarget.toLowerCase() === canvasId.toLowerCase()
  ) {
    return undefined;
  }
  return failure(
    toolName,
    "slack_mcp_canvas_not_explicit",
    "Slack MCP Canvas updates require an explicit Canvas id or Slack Canvas URL in the user request.",
    false,
  );
}

function readCanvasId(input: Record<string, unknown>): string | undefined {
  const canvasId = input.canvas_id ?? input.canvasId;
  if (typeof canvasId !== "string") {
    return undefined;
  }
  const trimmed = canvasId.trim();
  return isCanvasId(trimmed) ? trimmed : undefined;
}

function explicitCanvasUpdateTarget(sourceText: string): string | undefined {
  const canvasIds = uniqueCanvasIds(sourceText);
  return canvasIds.length === 1 ? canvasIds[0] : undefined;
}

function uniqueCanvasIds(sourceText: string): string[] {
  return [
    ...new Map(
      (sourceText.match(/(?<![a-z0-9])f[a-z0-9]{7,}(?![a-z0-9])/gi) ?? [])
        .filter(isCanvasId)
        .map((id) => [id.toLowerCase(), id]),
    ).values(),
  ];
}

function isCanvasId(value: string): boolean {
  return /^f(?=.*\d)[a-z0-9]{7,}$/i.test(value);
}

function failure(
  toolName: string,
  code: string,
  message: string,
  reconnectRequired: boolean,
): JsonValue {
  return {
    code,
    message,
    ok: false,
    reconnectRequired,
    toolName,
  };
}

function logWarn(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.warn === "function") {
    logger.warn(message, metadata);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
