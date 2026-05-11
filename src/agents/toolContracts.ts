import type { z } from "zod";

import type { JsonValue } from "../domain/messageHistory.js";
import type { LlmToolCall, LlmToolDefinition } from "../providers/contracts.js";

export type AgentToolDefinition<
  TInput extends JsonValue = JsonValue,
  TResult extends JsonValue = JsonValue,
> = {
  description: string;
  execute(input: TInput): Promise<TResult>;
  name: string;
  parameters: JsonValue;
  schema: z.ZodType<TInput>;
};

export type AgentToolResult = {
  output?: JsonValue;
  toolCallId: string;
  toolName: string;
};

export class UnknownAgentToolError extends Error {
  constructor(readonly toolName: string) {
    super(`Unknown agent tool '${toolName}'.`);
    this.name = "UnknownAgentToolError";
  }
}

export class InvalidAgentToolInputError extends Error {
  constructor(
    readonly toolName: string,
    message: string,
  ) {
    super(`Invalid input for agent tool '${toolName}': ${message}`);
    this.name = "InvalidAgentToolInputError";
  }
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition>();

  constructor(tools: readonly AgentToolDefinition[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: AgentToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  definitions(): LlmToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      description: tool.description,
      name: tool.name,
      parameters: tool.parameters,
    }));
  }

  async execute(toolCall: LlmToolCall): Promise<AgentToolResult> {
    const tool = this.tools.get(toolCall.toolName);
    if (tool === undefined) {
      throw new UnknownAgentToolError(toolCall.toolName);
    }
    const parsed = tool.schema.safeParse(toolCall.input);
    if (!parsed.success) {
      throw new InvalidAgentToolInputError(tool.name, parsed.error.message);
    }
    return {
      output: await tool.execute(parsed.data),
      toolCallId: toolCall.toolCallId,
      toolName: tool.name,
    };
  }

  async executeAll(toolCalls: readonly LlmToolCall[]): Promise<AgentToolResult[]> {
    const results: AgentToolResult[] = [];
    for (const toolCall of toolCalls) {
      results.push(await this.execute(toolCall));
    }
    return results;
  }
}
