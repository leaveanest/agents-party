import { ErrorCode, WebClient, type WebAPICallResult } from "@slack/web-api";

import type { JsonValue } from "../domain/messageHistory.js";

export const slackRealTimeSearchContentTypes = ["messages", "files", "channels", "users"] as const;
export const slackRealTimeSearchChannelTypes = [
  "public_channel",
  "private_channel",
  "mpim",
  "im",
] as const;

export type SlackRealTimeSearchContentType = (typeof slackRealTimeSearchContentTypes)[number];
export type SlackRealTimeSearchChannelType = (typeof slackRealTimeSearchChannelTypes)[number];

export type SlackRealTimeSearchContextInput = {
  after?: number;
  before?: number;
  channelTypes?: readonly SlackRealTimeSearchChannelType[];
  contentTypes?: readonly SlackRealTimeSearchContentType[];
  contextChannelId?: string;
  cursor?: string;
  includeContextMessages?: boolean;
  includeMessageBlocks?: boolean;
  limit?: number;
  query: string;
};

export type SlackRealTimeSearchInfoResult = {
  errorCode?: string;
  isAiSearchEnabled?: boolean;
  ok: boolean;
};

export type SlackRealTimeSearchContextResult = {
  channels: SlackRealTimeSearchChannelResult[];
  errorCode?: string;
  files: SlackRealTimeSearchFileResult[];
  messages: SlackRealTimeSearchMessageResult[];
  nextCursor?: string;
  ok: boolean;
  users: SlackRealTimeSearchUserResult[];
};

export type SlackRealTimeSearchMessageResult = {
  authorName?: string;
  authorUserId?: string;
  blocks?: JsonValue;
  channelId: string;
  channelName?: string;
  content?: string;
  contextMessages?: SlackRealTimeSearchContextMessageResult[];
  isAuthorBot?: boolean;
  messageTs: string;
  permalink?: string;
  teamId: string;
};

export type SlackRealTimeSearchContextMessageResult = {
  blocks?: JsonValue;
  authorUserId?: string;
  content?: string;
  messageTs?: string;
  position: "after" | "before";
};

export type SlackRealTimeSearchFileResult = {
  authorName?: string;
  authorUserId?: string;
  content?: string;
  dateCreated?: number;
  dateUpdated?: number;
  fileId: string;
  fileType?: string;
  permalink?: string;
  teamId: string;
  title?: string;
  uploaderUserId?: string;
};

export type SlackRealTimeSearchChannelResult = {
  creatorName?: string;
  creatorUserId?: string;
  dateCreated?: number;
  dateUpdated?: number;
  name: string;
  permalink?: string;
  purpose?: string;
  teamId: string;
  topic?: string;
};

export type SlackRealTimeSearchUserResult = {
  email?: string;
  fullName?: string;
  profilePicPermalink?: string;
  teamId?: string;
  timezone?: string;
  title?: string;
  userId: string;
};

export type SlackRealTimeSearchGateway = {
  info(): Promise<SlackRealTimeSearchInfoResult>;
  searchContext(input: SlackRealTimeSearchContextInput): Promise<SlackRealTimeSearchContextResult>;
};

type SlackWebApiCaller = Pick<WebClient, "apiCall">;

export function createSlackRealTimeSearchGateway(
  token: string,
  client: SlackWebApiCaller = new WebClient(token),
): SlackRealTimeSearchGateway {
  return {
    async info() {
      try {
        return normalizeInfoResponse(await client.apiCall("assistant.search.info"));
      } catch (error) {
        const errorCode = slackWebApiErrorCode(error);
        if (errorCode !== undefined) {
          return {
            errorCode,
            ok: false,
          };
        }
        throw error;
      }
    },
    async searchContext(input) {
      try {
        return normalizeSearchContextResponse(
          await client.apiCall("assistant.search.context", searchContextApiOptions(input)),
        );
      } catch (error) {
        const errorCode = slackWebApiErrorCode(error);
        if (errorCode !== undefined) {
          return emptySearchContextResult({
            errorCode,
            ok: false,
          });
        }
        throw error;
      }
    },
  };
}

function searchContextApiOptions(input: SlackRealTimeSearchContextInput): Record<string, unknown> {
  return cleanRecord({
    after: input.after,
    before: input.before,
    channel_types: input.channelTypes,
    content_types: input.contentTypes,
    context_channel_id: input.contextChannelId,
    cursor: input.cursor,
    include_context_messages: input.includeContextMessages,
    include_message_blocks: input.includeMessageBlocks,
    limit: input.limit,
    query: input.query,
  });
}

function normalizeInfoResponse(response: WebAPICallResult): SlackRealTimeSearchInfoResult {
  const record = asRecord(response);
  if (record.ok !== true) {
    return cleanRecord({
      errorCode: readString(record.error),
      ok: false,
    });
  }
  return cleanRecord({
    isAiSearchEnabled: readBoolean(record.is_ai_search_enabled),
    ok: true,
  });
}

function normalizeSearchContextResponse(
  response: WebAPICallResult,
): SlackRealTimeSearchContextResult {
  const record = asRecord(response);
  if (record.ok !== true) {
    return emptySearchContextResult({
      errorCode: readString(record.error),
      ok: false,
    });
  }
  const results = asRecord(record.results);
  const responseMetadata = asRecord(record.response_metadata);
  return {
    channels: readArray(results.channels).flatMap(normalizeChannelResult),
    files: readArray(results.files).flatMap(normalizeFileResult),
    messages: readArray(results.messages).flatMap(normalizeMessageResult),
    nextCursor: readString(responseMetadata.next_cursor),
    ok: true,
    users: readArray(results.users).flatMap(normalizeUserResult),
  };
}

function emptySearchContextResult(
  input: Pick<SlackRealTimeSearchContextResult, "ok"> & { errorCode?: string },
): SlackRealTimeSearchContextResult {
  return {
    channels: [],
    errorCode: input.errorCode,
    files: [],
    messages: [],
    ok: input.ok,
    users: [],
  };
}

function normalizeMessageResult(value: unknown): SlackRealTimeSearchMessageResult[] {
  const record = asRecord(value);
  const teamId = readString(record.team_id);
  const channelId = readString(record.channel_id);
  const messageTs = readString(record.message_ts);
  if (teamId === undefined || channelId === undefined || messageTs === undefined) {
    return [];
  }
  return [
    cleanRecord({
      authorName: readString(record.author_name),
      authorUserId: readString(record.author_user_id),
      blocks: toJsonValue(record.blocks),
      channelId,
      channelName: readString(record.channel_name),
      content: readString(record.content),
      contextMessages: normalizeContextMessages(record.context_messages),
      isAuthorBot: readBoolean(record.is_author_bot),
      messageTs,
      permalink: readString(record.permalink),
      teamId,
    }),
  ];
}

function normalizeContextMessages(value: unknown): SlackRealTimeSearchContextMessageResult[] {
  const record = asRecord(value);
  return [
    ...readArray(record.before).flatMap((message) =>
      normalizeContextMessageResult(message, "before"),
    ),
    ...readArray(record.after).flatMap((message) =>
      normalizeContextMessageResult(message, "after"),
    ),
  ];
}

function normalizeContextMessageResult(
  value: unknown,
  position: SlackRealTimeSearchContextMessageResult["position"],
): SlackRealTimeSearchContextMessageResult[] {
  const record = asRecord(value);
  return [
    cleanRecord({
      authorUserId:
        readString(record.author_user_id) ??
        readString(record.user_id) ??
        readString(record["user_id:"]),
      blocks: toJsonValue(record.blocks),
      content: readString(record.content) ?? readString(record.text),
      messageTs: readString(record.message_ts) ?? readString(record.ts),
      position,
    }),
  ];
}

function normalizeFileResult(value: unknown): SlackRealTimeSearchFileResult[] {
  const record = asRecord(value);
  const teamId = readString(record.team_id);
  const fileId = readString(record.file_id);
  if (teamId === undefined || fileId === undefined) {
    return [];
  }
  return [
    cleanRecord({
      authorName: readString(record.author_name),
      authorUserId: readString(record.author_user_id),
      content: readString(record.content),
      dateCreated: readNumber(record.date_created),
      dateUpdated: readNumber(record.date_updated),
      fileId,
      fileType: readString(record.file_type),
      permalink: readString(record.permalink),
      teamId,
      title: readString(record.title),
      uploaderUserId: readString(record.uploader_user_id),
    }),
  ];
}

function normalizeChannelResult(value: unknown): SlackRealTimeSearchChannelResult[] {
  const record = asRecord(value);
  const teamId = readString(record.team_id);
  const name = readString(record.name);
  if (teamId === undefined || name === undefined) {
    return [];
  }
  return [
    cleanRecord({
      creatorName: readString(record.creator_name),
      creatorUserId: readString(record.creator_user_id),
      dateCreated: readNumber(record.date_created),
      dateUpdated: readNumber(record.date_updated),
      name,
      permalink: readString(record.permalink),
      purpose: readString(record.purpose),
      teamId,
      topic: readString(record.topic),
    }),
  ];
}

function normalizeUserResult(value: unknown): SlackRealTimeSearchUserResult[] {
  const record = asRecord(value);
  const userId = readString(record.user_id);
  if (userId === undefined) {
    return [];
  }
  return [
    cleanRecord({
      email: readString(record.email),
      fullName: readString(record.full_name),
      profilePicPermalink: readString(record.profile_pic_permalink),
      teamId: readString(record.team_id),
      timezone: readString(record.timezone),
      title: readString(record.title),
      userId,
    }),
  ];
}

function cleanRecord<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, Exclude<unknown, undefined>] => {
      const [, value] = entry;
      return value !== undefined;
    }),
  ) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function slackWebApiErrorCode(error: unknown): string | undefined {
  const record = asRecord(error);
  if (record.code === ErrorCode.PlatformError) {
    return readString(asRecord(record.data).error);
  }
  if (record.code === ErrorCode.RateLimitedError) {
    return "rate_limited";
  }
  return undefined;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  return isJsonValue(value) ? value : undefined;
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
