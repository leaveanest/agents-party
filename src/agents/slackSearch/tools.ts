import { z } from "zod";

import type { JsonValue } from "../../domain/messageHistory.js";
import {
  createSlackRealTimeSearchGateway,
  slackRealTimeSearchChannelTypes,
  slackRealTimeSearchContentTypes,
  type SlackRealTimeSearchGateway,
} from "../../slack/realTimeSearch.js";
import type { SlackMcpTokenLookup, SlackMcpTokenResolver } from "../slackMcp/index.js";
import type { AgentToolDefinition } from "../toolContracts.js";

export type SlackRealTimeSearchToolContext = SlackMcpTokenLookup & {
  channelId: string;
};

export type SlackRealTimeSearchToolOptions = {
  context: SlackRealTimeSearchToolContext;
  gatewayFactory?: (input: { token: string }) => SlackRealTimeSearchGateway;
  tokenResolver: SlackMcpTokenResolver;
};

const contentTypeSchema = z.enum(slackRealTimeSearchContentTypes);
const channelTypeSchema = z.enum(slackRealTimeSearchChannelTypes);
const jsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(isJsonValue);

const slackRealTimeSearchInputSchema = z
  .object({
    after: z.number().int().positive().optional(),
    before: z.number().int().positive().optional(),
    channelTypes: z.array(channelTypeSchema).min(1).max(4).optional(),
    contentTypes: z.array(contentTypeSchema).min(1).max(4).optional(),
    contextChannelId: z.string().trim().min(1).optional(),
    cursor: z.string().trim().min(1).optional(),
    includeContextMessages: z.boolean().default(true).optional(),
    includeMessageBlocks: z.boolean().default(false).optional(),
    limit: z.number().int().min(1).max(20).default(10).optional(),
    query: z.string().trim().min(1).max(4000),
  })
  .strict();

const contextMessageOutputSchema = z
  .object({
    authorUserId: z.string().optional(),
    blocks: jsonValueSchema.optional(),
    content: z.string().optional(),
    messageTs: z.string().optional(),
    position: z.enum(["after", "before"]),
  })
  .strict();

const slackRealTimeSearchOutputSchema = z
  .object({
    code: z.string().optional(),
    message: z.string(),
    nextCursor: z.string().optional(),
    ok: z.boolean(),
    results: z
      .object({
        channels: z.array(
          z
            .object({
              creatorName: z.string().optional(),
              creatorUserId: z.string().optional(),
              dateCreated: z.number().optional(),
              dateUpdated: z.number().optional(),
              name: z.string(),
              permalink: z.string().optional(),
              purpose: z.string().optional(),
              teamId: z.string(),
              topic: z.string().optional(),
            })
            .strict(),
        ),
        files: z.array(
          z
            .object({
              authorName: z.string().optional(),
              authorUserId: z.string().optional(),
              content: z.string().optional(),
              dateCreated: z.number().optional(),
              dateUpdated: z.number().optional(),
              fileId: z.string(),
              fileType: z.string().optional(),
              permalink: z.string().optional(),
              teamId: z.string(),
              title: z.string().optional(),
              uploaderUserId: z.string().optional(),
            })
            .strict(),
        ),
        messages: z.array(
          z
            .object({
              authorName: z.string().optional(),
              authorUserId: z.string().optional(),
              blocks: jsonValueSchema.optional(),
              channelId: z.string(),
              channelName: z.string().optional(),
              content: z.string().optional(),
              contextMessages: z.array(contextMessageOutputSchema).optional(),
              isAuthorBot: z.boolean().optional(),
              messageTs: z.string(),
              permalink: z.string().optional(),
              teamId: z.string(),
            })
            .strict(),
        ),
        users: z.array(
          z
            .object({
              email: z.string().optional(),
              fullName: z.string().optional(),
              profilePicPermalink: z.string().optional(),
              teamId: z.string().optional(),
              timezone: z.string().optional(),
              title: z.string().optional(),
              userId: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

type SlackRealTimeSearchToolInput = z.infer<typeof slackRealTimeSearchInputSchema>;
type SlackRealTimeSearchToolOutput = z.infer<typeof slackRealTimeSearchOutputSchema>;

export function createSlackRealTimeSearchAgentTools(
  options: SlackRealTimeSearchToolOptions,
): AgentToolDefinition[] {
  return [
    {
      description:
        "Search Slack with Slack's Real-time Search API. Use this as the first choice for Slack workspace search. Use it when the user asks about prior Slack messages, files, channels, or people beyond the current thread. Prefer this over slack_search_public. Use slack_read_channel or slack_read_thread instead when you only need the current channel or current thread.",
      execute: async (input) => searchSlack(input as SlackRealTimeSearchToolInput, options),
      name: "slack_real_time_search",
      outputSchema: slackRealTimeSearchOutputSchema as z.ZodType<JsonValue>,
      parameters: z.toJSONSchema(slackRealTimeSearchInputSchema) as JsonValue,
      schema: slackRealTimeSearchInputSchema as z.ZodType<JsonValue>,
    },
  ];
}

async function searchSlack(
  input: SlackRealTimeSearchToolInput,
  options: SlackRealTimeSearchToolOptions,
): Promise<SlackRealTimeSearchToolOutput> {
  const resolution = await options.tokenResolver.resolve(options.context);
  if (resolution === undefined || resolution.token.trim().length === 0) {
    return failure(
      "slack_rts_user_token_missing",
      "Slack user authorization is required before Slack Real-time Search can access this workspace.",
    );
  }

  let result: Awaited<ReturnType<SlackRealTimeSearchGateway["searchContext"]>>;
  try {
    const gateway = (options.gatewayFactory ?? defaultGatewayFactory)({ token: resolution.token });
    result = await gateway.searchContext({
      after: input.after,
      before: input.before,
      channelTypes: input.channelTypes ?? defaultChannelTypesForScopes(resolution.scopes),
      contentTypes: input.contentTypes ?? ["messages"],
      contextChannelId: input.contextChannelId ?? options.context.channelId,
      cursor: input.cursor,
      includeContextMessages: input.includeContextMessages ?? true,
      includeMessageBlocks: input.includeMessageBlocks ?? false,
      limit: input.limit ?? 10,
      query: input.query,
    });
  } catch (error) {
    return failure(
      "slack_rts_call_failed",
      `Slack Real-time Search request failed: ${errorMessage(error)}.`,
    );
  }

  if (!result.ok) {
    return failure(
      result.errorCode ?? "slack_rts_search_failed",
      `Slack Real-time Search failed: ${result.errorCode ?? "unknown_error"}.`,
    );
  }
  const resultCount =
    result.messages.length + result.files.length + result.channels.length + result.users.length;
  return cleanOutput({
    message:
      resultCount === 0
        ? "Slack Real-time Search completed with no results."
        : `Slack Real-time Search returned ${resultCount} result${resultCount === 1 ? "" : "s"}.`,
    nextCursor: result.nextCursor,
    ok: true,
    results: {
      channels: result.channels,
      files: result.files,
      messages: result.messages,
      users: result.users,
    },
  });
}

function defaultGatewayFactory(input: { token: string }): SlackRealTimeSearchGateway {
  return createSlackRealTimeSearchGateway(input.token);
}

function defaultChannelTypesForScopes(
  scopes: readonly string[] | undefined,
): Array<"public_channel" | "private_channel" | "mpim" | "im"> {
  const normalizedScopes = new Set(scopes ?? []);
  return [
    "public_channel",
    ...(normalizedScopes.has("search:read.private") ? (["private_channel"] as const) : []),
    ...(normalizedScopes.has("search:read.mpim") ? (["mpim"] as const) : []),
    ...(normalizedScopes.has("search:read.im") ? (["im"] as const) : []),
  ];
}

function failure(code: string, message: string): SlackRealTimeSearchToolOutput {
  return {
    code,
    message,
    ok: false,
    results: {
      channels: [],
      files: [],
      messages: [],
      users: [],
    },
  };
}

function cleanOutput(output: SlackRealTimeSearchToolOutput): SlackRealTimeSearchToolOutput {
  return Object.fromEntries(
    Object.entries(output).filter(([, value]) => value !== undefined),
  ) as SlackRealTimeSearchToolOutput;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}
