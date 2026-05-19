import { z } from "zod";

import type { JsonValue } from "../../domain/messageHistory.js";
import { SlackMcpClient, type SlackMcpCallToolOutput } from "../../integrations/slackMcp/client.js";
import type { AgentToolDefinition } from "../toolContracts.js";

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
  viewerContextChannelIds: string[];
};

export type SlackMcpToolOptions = {
  client?: Pick<SlackMcpClient, "callTool">;
  context: SlackMcpToolContext;
  tokenResolver: SlackMcpTokenResolver;
};

const searchMessagesInputSchema = z
  .object({
    cursor: z.string().trim().min(1).optional(),
    query: z.string().trim().min(1),
  })
  .passthrough();

const readChannelInputSchema = z
  .object({
    channel_id: z.string().trim().min(1),
    cursor: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    message_ts: z.string().trim().min(1).optional(),
  })
  .passthrough();

const readThreadInputSchema = z
  .object({
    channel_id: z.string().trim().min(1),
    cursor: z.string().trim().min(1).optional(),
    thread_ts: z.string().trim().min(1),
  })
  .passthrough();

const readUserProfileInputSchema = z
  .object({
    user_id: z.string().trim().min(1),
  })
  .passthrough();

const slackMcpToolOutputSchema = z
  .object({
    code: z.string().optional(),
    content: z.array(z.unknown()).optional(),
    isError: z.boolean().optional(),
    message: z.string(),
    ok: z.boolean(),
    reconnectRequired: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
    toolName: z.string(),
  })
  .passthrough();

type SlackMcpToolSpec = {
  description: string;
  name: string;
  schema: z.ZodType<JsonValue>;
};

const slackMcpToolSpecs: SlackMcpToolSpec[] = [
  {
    description:
      "Search public Slack messages visible to the authenticated user. Use Slack search syntax such as from:<@USERID>, in:#channel, before:, after:, or on:.",
    name: "slack_search_public",
    schema: searchMessagesInputSchema as z.ZodType<JsonValue>,
  },
  {
    description:
      "Read messages from the Slack channel where this agent invocation is running. Use channel_id and optionally message_ts to fetch nearby context.",
    name: "slack_read_channel",
    schema: readChannelInputSchema as z.ZodType<JsonValue>,
  },
  {
    description:
      "Read a Slack thread in the channel where this agent invocation is running. Use this when a current-channel message has a thread_ts or replies.",
    name: "slack_read_thread",
    schema: readThreadInputSchema as z.ZodType<JsonValue>,
  },
  {
    description:
      "Read a Slack user profile visible to the authenticated user. Use this to resolve user details when IDs are not enough.",
    name: "slack_read_user_profile",
    schema: readUserProfileInputSchema as z.ZodType<JsonValue>,
  },
];

export function createSlackMcpAgentTools(options: SlackMcpToolOptions): AgentToolDefinition[] {
  return slackMcpToolSpecs.map((spec) => ({
    description: spec.description,
    execute: async (input) =>
      executeSlackMcpTool(options, spec.name, input as Record<string, unknown>),
    name: spec.name,
    outputSchema: slackMcpToolOutputSchema as z.ZodType<JsonValue>,
    parameters: z.toJSONSchema(spec.schema) as JsonValue,
    schema: spec.schema,
  }));
}

async function executeSlackMcpTool(
  options: SlackMcpToolOptions,
  toolName: string,
  input: Record<string, unknown>,
): Promise<JsonValue> {
  const accessFailure = validateSlackMcpToolAccess(options.context, toolName, input);
  if (accessFailure !== undefined) {
    return accessFailure;
  }

  const resolution = await options.tokenResolver.resolve(options.context);
  if (resolution === undefined || resolution.token.trim().length === 0) {
    return failure(
      toolName,
      "slack_mcp_user_token_missing",
      "Slack user authorization is required before Slack MCP tools can access this workspace.",
      true,
    );
  }

  try {
    const result = await (options.client ?? new SlackMcpClient()).callTool({
      arguments: input,
      name: toolName,
      token: resolution.token,
    });
    return success(toolName, result);
  } catch (error) {
    return failure(
      toolName,
      "slack_mcp_call_failed",
      `Slack MCP tool call failed: ${errorMessage(error)}`,
      true,
    );
  }
}

function validateSlackMcpToolAccess(
  context: SlackMcpToolContext,
  toolName: string,
  input: Record<string, unknown>,
): JsonValue | undefined {
  if (toolName !== "slack_read_channel" && toolName !== "slack_read_thread") {
    return undefined;
  }
  const channelId = typeof input.channel_id === "string" ? input.channel_id.trim() : "";
  if (channelId.length === 0 || context.viewerContextChannelIds.includes(channelId)) {
    return undefined;
  }
  return failure(
    toolName,
    "slack_mcp_channel_not_allowed",
    "Slack MCP channel reads are limited to the channel that started this agent invocation.",
    false,
  );
}

function success(toolName: string, result: SlackMcpCallToolOutput): JsonValue {
  const output: Record<string, JsonValue> = {
    content: result.content,
    message:
      result.isError === true ? "Slack MCP tool returned an error." : "Slack MCP tool completed.",
    ok: result.isError !== true,
    toolName,
  };
  if (result.isError !== undefined) {
    output.isError = result.isError;
  }
  if (result.structuredContent !== undefined) {
    output.structuredContent = result.structuredContent;
  }
  return output;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
