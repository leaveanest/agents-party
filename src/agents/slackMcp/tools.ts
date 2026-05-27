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
  viewerContextChannelIds: string[];
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
  clientFactory?: (input: { token: string }) => Promise<SlackMcpToolSetClient>;
  context: SlackMcpToolContext;
  serverUrl?: string;
  tokenResolver: SlackMcpTokenResolver;
  toolsListTimeoutMs?: number;
};

const DEFAULT_SLACK_MCP_TOOLS_LIST_TIMEOUT_MS = 2500;

const allowedSlackMcpToolNames = [
  "slack_create_canvas",
  "slack_read_canvas",
  "slack_search_public",
  "slack_read_channel",
  "slack_read_thread",
  "slack_read_user_profile",
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

function filterAndWrapSlackMcpTools(tools: ToolSet, context: SlackMcpToolContext): ToolSet {
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
        const accessFailure = validateSlackMcpToolAccess(
          context,
          toolName,
          input as Record<string, unknown>,
        );
        if (accessFailure !== undefined) {
          return accessFailure;
        }
        return execute(input, executionOptions);
      },
    };
  }
  return filtered;
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
