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
    expect(
      selectSpecialist({
        channelId: "C1",
        messageTs: "1.0",
        referenceImages: [],
        teamId: "T1",
        text: "タスクを確認して",
        threadMessages: [],
        userId: "U1",
        viewerContextChannelIds: [],
      }).specialist,
    ).toBe("work_manager");
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
      model: { id: "google:gemini-2.5-flash", provider: "google" },
    });
    expect(router.requests[0]?.history.messages.at(-1)).toMatchObject({
      id: "1.0",
      role: "user",
    });
  });

  it("validates structured work-manager results without an external agent framework", async () => {
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
        content: JSON.stringify({ action: "no_op", message: "final" }),
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
      text: "task echo",
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
        content: JSON.stringify({ action: "no_op", message: "done" }),
        toolCalls: [{ input: { text: "ok" }, toolCallId: "call-1", toolName: "echo" }],
      }),
      toolRegistry: registry,
    });

    await expect(
      runner.run({
        channelId: "C1",
        messageTs: "1.0",
        teamId: "T1",
        text: "task echo",
        userId: "U1",
      }),
    ).rejects.toThrow("Invalid output from agent tool");
  });

  it("wraps structured output validation failures with specialist and model context", async () => {
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: new FakeProviderRouter({
        content: JSON.stringify({ action: "listed", workItems: [] }),
      }),
    });

    await expect(
      runner.run({
        channelId: "C1",
        messageTs: "1.0",
        teamId: "T1",
        text: "list my tasks",
        userId: "U1",
      }),
    ).rejects.toMatchObject({
      model: { id: "google:gemini-2.5-flash", provider: "google" },
      specialist: "work_manager",
    });
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
      specialist: "assistant",
    });
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

class SequencedProviderRouter {
  readonly registry = new ModelRegistry([model]);
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
