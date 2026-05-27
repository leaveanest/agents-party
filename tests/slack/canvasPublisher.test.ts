import { ErrorCode } from "@slack/web-api";
import { describe, expect, it } from "vite-plus/test";

import {
  SlackCanvasPublishError,
  publishGeneratedCanvas,
} from "../../src/slack/canvasPublisher.js";

describe("publishGeneratedCanvas", () => {
  it("creates a standalone Slack Canvas and grants read access to the current channel", async () => {
    const createCalls: unknown[] = [];
    const accessCalls: unknown[] = [];

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
              createCalls.push(payload);
              return { canvas_id: "F123", ok: true };
            },
            access: {
              set: async (payload: unknown) => {
                accessCalls.push(payload);
                return { ok: true };
              },
            },
          },
        } as never,
        teamId: "T1",
        threadTs: "1712345678.000100",
      }),
    ).resolves.toEqual({ access: { ok: true }, canvasId: "F123" });

    expect(createCalls).toEqual([
      {
        document_content: {
          markdown: "# Summary\n\n- Done",
          type: "markdown",
        },
        title: "Summary",
      },
    ]);
    expect(accessCalls).toEqual([
      {
        access_level: "read",
        canvas_id: "F123",
        channel_ids: ["C1"],
      },
    ]);
  });

  it("returns the created Canvas id when channel sharing fails after creation", async () => {
    const createCalls: unknown[] = [];

    await expect(
      publishGeneratedCanvas({
        canvas: {
          markdown: "# Summary",
          title: "Summary",
        },
        channelId: "C1",
        client: {
          canvases: {
            create: async (payload: unknown) => {
              createCalls.push(payload);
              return { canvas_id: "F123", ok: true };
            },
            access: {
              set: async () => {
                throw {
                  code: ErrorCode.PlatformError,
                  data: { error: "no_permission" },
                };
              },
            },
          },
        } as never,
        teamId: "T1",
        threadTs: "1712345678.000100",
      }),
    ).resolves.toEqual({
      access: { code: "no_permission", ok: false },
      canvasId: "F123",
    });
    expect(createCalls).toHaveLength(1);
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
