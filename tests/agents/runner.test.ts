import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { AgentRunner, selectAgentAction } from "../../src/agents/runner.js";
import { AgentToolRegistry } from "../../src/agents/toolContracts.js";
import type { JsonValue } from "../../src/domain/messageHistory.js";
import type { LlmRequest, LlmResult, ModelInfo } from "../../src/providers/contracts.js";
import { ModelRegistry } from "../../src/providers/modelRegistry.js";

const model: ModelInfo = {
  capabilities: ["text", "tool_calling"],
  id: "google:gemini-2.5-flash",
  provider: "google",
  providerModelId: "gemini-2.5-flash",
};
const explicitModel: ModelInfo = {
  capabilities: ["text", "tool_calling"],
  id: "anthropic:claude-3-5-sonnet-latest",
  provider: "anthropic",
  providerModelId: "claude-3-5-sonnet-latest",
};
const textOnlyModel: ModelInfo = {
  capabilities: ["text"],
  id: "plamo:plamo-2.0-mini",
  provider: "plamo",
  providerModelId: "plamo-2.0-mini",
};

describe("AgentRunner", () => {
  it("uses a single agent action instead of specialist routing", () => {
    expect(selectAgentAction()).toEqual({
      action: "respond",
      reason: "agent_invocation",
    });
  });

  it("routes primary Slack mentions through the provider-backed agent runner", async () => {
    const router = new FakeProviderRouter({
      content: "Hello from TypeScript AgentRunner",
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "hello",
      userId: "U1",
    });

    expect(result).toMatchObject({
      decision: { action: "respond" },
      message: "Hello from TypeScript AgentRunner",
      model: { id: "google:gemini-2.5-flash", provider: "google" },
    });
    expect(router.requests[0]?.history.messages.at(-1)).toMatchObject({
      id: "1.0",
      role: "user",
    });
    expect(router.requests[0]?.context).toEqual({ workspaceId: "T1" });
  });

  it("uses an explicit invocation model before the default model", async () => {
    const router = new FakeProviderRouter({
      content: "model override",
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      modelId: explicitModel.id,
      teamId: "T1",
      text: "hello",
      userId: "U1",
    });

    expect(result.model).toEqual({
      id: "anthropic:claude-3-5-sonnet-latest",
      provider: "anthropic",
    });
    expect(router.requests[0]?.model.id).toBe(explicitModel.id);
  });

  it("adds transient audio transcripts to provider history without persistence types", async () => {
    const router = new FakeProviderRouter({
      content: "heard it",
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "summarize this",
      transientAttachments: [
        {
          filename: "voice.mp3",
          id: "F1",
          kind: "audio",
          mediaType: "audio/mpeg",
          messageTs: "1.0",
          transcript: "audio transcript",
        },
      ],
      userId: "U1",
    });

    expect(router.requests[0]?.history.messages.at(-1)).toMatchObject({
      content: [
        { text: "summarize this", type: "text" },
        { text: "[audio: voice.mp3]\naudio transcript", type: "text" },
      ],
      role: "user",
    });
  });

  it("ignores blank invocation model ids", async () => {
    const router = new FakeProviderRouter({
      content: "default model",
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      modelId: "   ",
      teamId: "T1",
      text: "hello",
      userId: "U1",
    });

    expect(result.model).toEqual({ id: model.id, provider: "google" });
    expect(router.requests[0]?.model.id).toBe(model.id);
  });

  it("runs a final provider turn after typed tool calls", async () => {
    const registry = new AgentToolRegistry([
      {
        description: "Echo a string.",
        execute: async (input) => ({ echoed: readText(input) }),
        name: "echo",
        outputSchema: z.object({ echoed: z.string() }) as never,
        parameters: {
          additionalProperties: false,
          properties: { text: { type: "string" } },
          required: ["text"],
          type: "object",
        },
        schema: z.object({ text: z.string() }) as never,
      },
    ]);
    const router = new SequencedProviderRouter([
      {
        content: "",
        finishReason: "tool_call",
        toolCalls: [{ input: { text: "ok" }, toolCallId: "call-1", toolName: "echo" }],
      },
      {
        content: "final",
      },
    ]);
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
      toolRegistry: registry,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "echo",
      userId: "U1",
    });

    expect(result.message).toBe("final");
    expect(result.toolResults).toEqual([
      {
        input: { text: "ok" },
        output: { echoed: "ok" },
        toolCallId: "call-1",
        toolName: "echo",
      },
    ]);
    expect(router.requests[0]?.tools).toEqual([
      expect.objectContaining({
        name: "echo",
      }),
    ]);
    expect(router.requests).toHaveLength(2);
    expect(router.requests[1]?.history.messages.map((message) => message.role)).toContain("tool");
    expect(router.requests[1]?.history.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: [
            expect.objectContaining({
              input: { text: "ok" },
              toolCallId: "call-1",
              type: "tool-call",
            }),
          ],
          role: "assistant",
        }),
      ]),
    );
  });

  it("lets tool registry factories gate tools by resolved model capability", async () => {
    const router = new FakeProviderRouter({
      content: "text only",
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
      toolRegistryFactory: (_invocation, resolvedModel) =>
        resolvedModel.capabilities.includes("tool_calling")
          ? new AgentToolRegistry([
              {
                description: "Echo a string.",
                execute: async (input) => ({ echoed: readText(input) }),
                name: "echo",
                outputSchema: z.object({ echoed: z.string() }) as never,
                parameters: { type: "object" },
                schema: z.object({ text: z.string() }) as never,
              },
            ])
          : new AgentToolRegistry(),
    });

    await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      modelId: textOnlyModel.id,
      teamId: "T1",
      text: "hello",
      userId: "U1",
    });

    expect(router.requests[0]?.tools).toEqual([]);
  });

  it("rejects invalid tool output", async () => {
    const registry = new AgentToolRegistry([
      {
        description: "Return invalid data.",
        execute: async () => ({ echoed: 123 }),
        name: "echo",
        outputSchema: z.object({ echoed: z.string() }) as never,
        parameters: { type: "object" },
        schema: z.object({ text: z.string() }) as never,
      },
    ]);
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: new FakeProviderRouter({
        content: "done",
        toolCalls: [{ input: { text: "ok" }, toolCallId: "call-1", toolName: "echo" }],
      }),
      toolRegistry: registry,
    });

    await expect(
      runner.run({
        channelId: "C1",
        messageTs: "1.0",
        teamId: "T1",
        text: "echo",
        userId: "U1",
      }),
    ).rejects.toThrow("Invalid output from agent tool");
  });

  it("wraps default model lookup failures with attempted model id", async () => {
    const runner = new AgentRunner({
      defaultModelId: "missing:default-model",
      providerRouter: new FakeProviderRouter({ content: "will not run" }),
    });

    await expect(
      runner.run({
        channelId: "C1",
        messageTs: "1.0",
        teamId: "T1",
        text: "hello",
        userId: "U1",
      }),
    ).rejects.toMatchObject({
      model: { id: "missing:default-model" },
    });
  });
});

class FakeProviderRouter {
  readonly registry = new ModelRegistry([model, explicitModel, textOnlyModel]);
  readonly requests: LlmRequest[] = [];

  constructor(private readonly result: LlmResult) {}

  async generate(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    return this.result;
  }
}

class SequencedProviderRouter {
  readonly registry = new ModelRegistry([model, explicitModel, textOnlyModel]);
  readonly requests: LlmRequest[] = [];

  constructor(private readonly results: LlmResult[]) {}

  async generate(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error("No fake result configured.");
    }
    return result;
  }
}

function readText(value: JsonValue): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const text = value.text;
    if (typeof text === "string") {
      return text;
    }
  }
  throw new Error("Expected text input.");
}
