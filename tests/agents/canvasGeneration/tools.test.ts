import { describe, expect, it } from "vite-plus/test";

import { createCanvasGenerationAgentTools } from "../../../src/agents/canvasGeneration/tools.js";

describe("createCanvasGenerationAgentTools", () => {
  it("returns a generated Canvas artifact scoped to the Slack context", async () => {
    const tool = createCanvasGenerationAgentTools({
      context: { channelId: "C1", teamId: "T1", threadTs: "1712345678.000100" },
    })[0];

    await expect(
      tool.execute({
        markdown: "# 議事録\n\n- 決定事項",
        title: "議事録",
      }),
    ).resolves.toEqual({
      canvas: {
        kind: "canvas",
        markdown: "# 議事録\n\n- 決定事項",
        status: "generated",
        target: {
          channelId: "C1",
          teamId: "T1",
          threadTs: "1712345678.000100",
        },
        title: "議事録",
      },
      message: "Canvas generated.",
      ok: true,
    });
  });

  it("rejects oversized Canvas markdown before execution", () => {
    const tool = createCanvasGenerationAgentTools({
      context: { channelId: "C1", teamId: "T1", threadTs: "1712345678.000100" },
    })[0];

    expect(
      tool.schema.safeParse({
        markdown: "a".repeat(100_001),
        title: "Too large",
      }).success,
    ).toBe(false);
  });

  it("keeps Canvas markdown out of the model-visible tool output", async () => {
    const tool = createCanvasGenerationAgentTools({
      context: { channelId: "C1", teamId: "T1", threadTs: "1712345678.000100" },
    })[0];
    const output = await tool.execute({
      markdown: "# Private draft details",
      title: "Draft",
    });

    await expect(
      tool.toModelOutput?.({
        input: {
          markdown: "# Private draft details",
          title: "Draft",
        },
        output,
        toolCallId: "call-1",
      }),
    ).resolves.toEqual({
      type: "json",
      value: {
        canvas: {
          kind: "canvas",
          status: "generated",
          title: "Draft",
        },
        message: "Canvas generated.",
        ok: true,
      },
    });
  });
});
