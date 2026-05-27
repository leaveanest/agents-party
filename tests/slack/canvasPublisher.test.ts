import { ErrorCode } from "@slack/web-api";
import { describe, expect, it } from "vite-plus/test";

import {
  SlackCanvasPublishError,
  publishGeneratedCanvas,
} from "../../src/slack/canvasPublisher.js";

describe("publishGeneratedCanvas", () => {
  it("creates a Slack Canvas with markdown content in the current channel", async () => {
    const calls: unknown[] = [];

    await expect(
      publishGeneratedCanvas({
        canvas: {
          markdown: "# Summary\n\n- Done",
          title: "Summary",
        },
        channelId: "C1",
        client: {
          canvases: {
            create: async (payload: unknown) => {
              calls.push(payload);
              return { canvas_id: "F123", ok: true };
            },
          },
        } as never,
        teamId: "T1",
        threadTs: "1712345678.000100",
      }),
    ).resolves.toEqual({ canvasId: "F123" });

    expect(calls).toEqual([
      {
        channel_id: "C1",
        document_content: {
          markdown: "# Summary\n\n- Done",
          type: "markdown",
        },
        title: "Summary",
      },
    ]);
  });

  it("normalizes Slack API errors into user-facing Canvas publish errors", async () => {
    await expect(
      publishGeneratedCanvas({
        canvas: {
          markdown: "# Summary",
          title: "Summary",
        },
        channelId: "C1",
        client: {
          canvases: {
            create: async () => {
              throw {
                code: ErrorCode.PlatformError,
                data: { error: "missing_scope" },
              };
            },
          },
        } as never,
        teamId: "T1",
        threadTs: "1712345678.000100",
      }),
    ).rejects.toMatchObject({
      code: "missing_scope",
      message: "Slack Canvas publish failed.",
      name: "SlackCanvasPublishError",
    } satisfies Partial<SlackCanvasPublishError>);
  });
});
