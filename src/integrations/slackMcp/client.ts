import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { JsonValue } from "../../domain/messageHistory.js";

export const DEFAULT_SLACK_MCP_SERVER_URL = "https://mcp.slack.com/mcp";

export type SlackMcpCallToolInput = {
  arguments?: Record<string, unknown>;
  name: string;
  token: string;
};

export type SlackMcpCallToolOutput = {
  content: JsonValue[];
  isError?: boolean;
  structuredContent?: JsonValue;
};

export class SlackMcpClient {
  constructor(
    private readonly options: {
      fetchFn?: typeof fetch;
      serverUrl?: string;
    } = {},
  ) {}

  async callTool(input: SlackMcpCallToolInput): Promise<SlackMcpCallToolOutput> {
    const client = new Client({
      name: "agents-party-slack-mcp",
      version: "0.1.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(this.options.serverUrl ?? DEFAULT_SLACK_MCP_SERVER_URL),
      {
        fetch: this.options.fetchFn,
        requestInit: {
          headers: {
            Authorization: `Bearer ${input.token}`,
          },
        },
      },
    );

    try {
      await client.connect(transport);
      const result = await client.callTool({
        arguments: input.arguments,
        name: input.name,
      });
      return normalizeToolResult(result as CallToolResult);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }
}

function normalizeToolResult(result: CallToolResult): SlackMcpCallToolOutput {
  return {
    content: result.content.map((block) => toJsonValue(block)),
    isError: result.isError,
    structuredContent:
      result.structuredContent === undefined ? undefined : toJsonValue(result.structuredContent),
  };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        toJsonValue(entry),
      ]),
    );
  }
  return String(value);
}
