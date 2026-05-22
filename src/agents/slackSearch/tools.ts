import { createHash } from "node:crypto";

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
  fallbackQuery?: string;
  gatewayFactory?: (input: { token: string }) => SlackRealTimeSearchGateway;
  logger?: unknown;
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
    contextChannelId: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).optional()),
    cursor: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).optional()),
    includeContextMessages: z.boolean().default(false).optional(),
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
type SlackRealTimeSearchContextRequest = Parameters<SlackRealTimeSearchGateway["searchContext"]>[0];
type SlackRealTimeSearchContextResponse = Awaited<
  ReturnType<SlackRealTimeSearchGateway["searchContext"]>
>;

export function createSlackRealTimeSearchAgentTools(
  options: SlackRealTimeSearchToolOptions,
): AgentToolDefinition[] {
  return [
    {
      description:
        "Search Slack with Slack's Real-time Search API. Use this as the first choice for Slack workspace search. Use it when the user asks about prior Slack messages, files, channels, or people beyond the current thread. Default to public_channel messages search; only request private_channel, mpim, im, files, channels, or users when the user explicitly asks for those targets. Prefer this over slack_search_public. Use slack_read_channel or slack_read_thread instead when you only need the current channel or current thread.",
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
    const query = resolveSearchQuery(input.query, options);
    if (query === undefined) {
      return failure(
        "slack_rts_query_too_short",
        "Slack Real-time Search needs a more specific search query. Retry with substantive keywords or a natural language question.",
      );
    }
    const searchInput = {
      after: input.after,
      before: input.before,
      channelTypes: input.channelTypes ?? defaultChannelTypes(),
      contentTypes: input.contentTypes ?? ["messages"],
      contextChannelId: nonEmptyString(input.contextChannelId),
      cursor: nonEmptyString(input.cursor),
      includeContextMessages: input.includeContextMessages ?? false,
      includeMessageBlocks: input.includeMessageBlocks ?? false,
      limit: input.limit ?? 10,
      query,
    };
    let effectiveSearchInput = searchInput;
    logInfo(options.logger, "Calling Slack Real-time Search.", {
      channelTypes: effectiveSearchInput.channelTypes,
      contentTypes: effectiveSearchInput.contentTypes,
      hasCursor: effectiveSearchInput.cursor !== undefined,
      limit: effectiveSearchInput.limit,
      queryHash: hashValue(effectiveSearchInput.query),
      queryLength: effectiveSearchInput.query.length,
      teamId: options.context.teamId,
      tokenFingerprint: tokenFingerprint(resolution.token),
    });
    result = await gateway.searchContext(effectiveSearchInput);
    if (result.errorCode === "invalid_cursor" && searchInput.cursor !== undefined) {
      logWarn(options.logger, "Retrying Slack Real-time Search without invalid cursor.", {
        channelTypes: searchInput.channelTypes,
        contentTypes: searchInput.contentTypes,
        limit: searchInput.limit,
        teamId: options.context.teamId,
      });
      effectiveSearchInput = {
        ...searchInput,
        cursor: undefined,
      };
      result = await gateway.searchContext(effectiveSearchInput);
    }
    result = await retryMessagesOnlyAfterInternalError({
      gateway,
      options,
      result,
      searchInput: effectiveSearchInput,
    });
    result = await retryPublicMessagesAfterInternalError({
      gateway,
      options,
      result,
      searchInput: effectiveSearchInput,
    });
  } catch (error) {
    return failure(
      "slack_rts_call_failed",
      `Slack Real-time Search request failed: ${errorMessage(error)}.`,
    );
  }

  if (!result.ok) {
    logWarn(options.logger, "Slack Real-time Search failed.", {
      errorCode: result.errorCode ?? "unknown_error",
      teamId: options.context.teamId,
    });
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

function resolveSearchQuery(
  query: string,
  options: SlackRealTimeSearchToolOptions,
): string | undefined {
  const trimmedQuery = query.trim();
  if (hasEnoughSubstantiveSearchText(trimmedQuery)) {
    return trimmedQuery;
  }
  const fallbackQuery = normalizeFallbackSearchQuery(options.fallbackQuery);
  if (fallbackQuery !== undefined && hasEnoughSubstantiveSearchText(fallbackQuery)) {
    logWarn(options.logger, "Expanding short Slack Real-time Search query from invocation text.", {
      fallbackQueryLength: fallbackQuery.length,
      queryLength: trimmedQuery.length,
      teamId: options.context.teamId,
    });
    return fallbackQuery;
  }
  return trimmedQuery.length === 0 ? undefined : trimmedQuery;
}

function hasEnoughSubstantiveSearchText(query: string): boolean {
  return query.replaceAll(/\s+/g, "").length >= 3;
}

function normalizeFallbackSearchQuery(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  const latinTerms = trimmed.match(/[A-Za-z0-9][A-Za-z0-9._+:/-]*/g);
  const latinQuery = latinTerms?.join(" ").trim();
  return latinQuery !== undefined && hasEnoughSubstantiveSearchText(latinQuery)
    ? latinQuery
    : trimmed;
}

async function retryMessagesOnlyAfterInternalError(input: {
  gateway: SlackRealTimeSearchGateway;
  options: SlackRealTimeSearchToolOptions;
  result: SlackRealTimeSearchContextResponse;
  searchInput: SlackRealTimeSearchContextRequest;
}): Promise<SlackRealTimeSearchContextResponse> {
  if (
    input.result.errorCode !== "internal_error" ||
    !shouldRetryMessagesOnly(input.searchInput.contentTypes ?? [])
  ) {
    return input.result;
  }

  logWarn(input.options.logger, "Retrying Slack Real-time Search after internal_error.", {
    channelTypes: input.searchInput.channelTypes,
    contentTypes: input.searchInput.contentTypes,
    fallbackContentTypes: ["messages"],
    hasCursor: input.searchInput.cursor !== undefined,
    limit: input.searchInput.limit,
    teamId: input.options.context.teamId,
  });
  return await input.gateway.searchContext({
    ...input.searchInput,
    contentTypes: ["messages"],
  });
}

async function retryPublicMessagesAfterInternalError(input: {
  gateway: SlackRealTimeSearchGateway;
  options: SlackRealTimeSearchToolOptions;
  result: SlackRealTimeSearchContextResponse;
  searchInput: SlackRealTimeSearchContextRequest;
}): Promise<SlackRealTimeSearchContextResponse> {
  if (
    input.result.errorCode !== "internal_error" ||
    isMinimalPublicMessagesRequest(input.searchInput)
  ) {
    return input.result;
  }

  logWarn(
    input.options.logger,
    "Retrying Slack Real-time Search with a minimal public message request.",
    {
      channelTypes: input.searchInput.channelTypes,
      contentTypes: input.searchInput.contentTypes,
      fallbackChannelTypes: ["public_channel"],
      fallbackContentTypes: ["messages"],
      fallbackIncludeContextMessages: false,
      fallbackUsesContextChannel: false,
      limit: input.searchInput.limit,
      teamId: input.options.context.teamId,
    },
  );
  return await input.gateway.searchContext({
    ...input.searchInput,
    channelTypes: ["public_channel"],
    contentTypes: ["messages"],
    contextChannelId: undefined,
    cursor: undefined,
    includeContextMessages: false,
    includeMessageBlocks: false,
  });
}

function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim().length === 0 ? undefined : value;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function shouldRetryMessagesOnly(contentTypes: readonly string[]): boolean {
  return contentTypes.length !== 1 || contentTypes[0] !== "messages";
}

function isMinimalPublicMessagesRequest(input: SlackRealTimeSearchContextRequest): boolean {
  const channelTypes = input.channelTypes ?? [];
  const contentTypes = input.contentTypes ?? [];
  return (
    channelTypes.length === 1 &&
    channelTypes[0] === "public_channel" &&
    contentTypes.length === 1 &&
    contentTypes[0] === "messages" &&
    input.contextChannelId === undefined &&
    input.cursor === undefined &&
    input.includeContextMessages === false &&
    input.includeMessageBlocks === false
  );
}

function logInfo(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.info === "function") {
    logger.info(message, metadata);
  }
}

function logWarn(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.warn === "function") {
    logger.warn(message, metadata);
  }
}

function tokenFingerprint(token: string): string {
  return hashValue(token);
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultChannelTypes(): Array<"public_channel"> {
  return ["public_channel"];
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
