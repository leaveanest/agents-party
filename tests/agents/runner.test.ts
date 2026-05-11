import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { AgentRunner, selectSpecialist } from "../../src/agents/runner.js";
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

describe("AgentRunner", () => {
  it("selects specialists from Slack invocation text", () => {
    expect(
      selectSpecialist({
        channelId: "C1",
        messageTs: "1.0",
        referenceImages: [],
        teamId: "T1",
        text: "please translate this",
        threadMessages: [],
        userId: "U1",
        viewerContextChannelIds: [],
      }).specialist,
    ).toBe("translation");
  });

  it("routes primary Slack mentions through provider-backed specialist runners", async () => {
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
      decision: { specialist: "assistant" },
      message: "Hello from TypeScript AgentRunner",
    });
    expect(router.requests[0]?.history.messages.at(-1)).toMatchObject({
      id: "1.0",
      role: "user",
    });
  });

  it("validates structured work-manager results without pydantic-ai", async () => {
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: new FakeProviderRouter({
        content: JSON.stringify({
          action: "listed",
          message: "1 task needs attention.",
          workItems: [{ title: "Follow up", workItemId: "W1" }],
        }),
      }),
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "list my tasks",
      userId: "U1",
    });

    expect(result.decision.specialist).toBe("work_manager");
    expect(result.structuredResult).toEqual({
      action: "listed",
      message: "1 task needs attention.",
      workItems: [{ title: "Follow up", workItemId: "W1" }],
    });
  });

  it("executes typed tool calls through the AgentToolRegistry", async () => {
    const registry = new AgentToolRegistry([
      {
        description: "Echo a string.",
        execute: async (input) => ({ echoed: readText(input) }),
        name: "echo",
        parameters: {
          additionalProperties: false,
          properties: { text: { type: "string" } },
          required: ["text"],
          type: "object",
        },
        schema: z.object({ text: z.string() }) as never,
      },
    ]);
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: new FakeProviderRouter({
        content: JSON.stringify({ action: "no_op", message: "done" }),
        toolCalls: [{ input: { text: "ok" }, toolCallId: "call-1", toolName: "echo" }],
      }),
      toolRegistry: registry,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "task echo",
      userId: "U1",
    });

    expect(result.toolResults).toEqual([
      { output: { echoed: "ok" }, toolCallId: "call-1", toolName: "echo" },
    ]);
  });
});

class FakeProviderRouter {
  readonly registry = new ModelRegistry([model]);
  readonly requests: LlmRequest[] = [];

  constructor(private readonly result: LlmResult) {}

  async generate(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    return this.result;
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
