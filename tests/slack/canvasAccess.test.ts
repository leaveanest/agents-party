import { describe, expect, it } from "vite-plus/test";

import { createSlackCanvasAccessSetter } from "../../src/slack/canvasAccess.js";

describe("createSlackCanvasAccessSetter", () => {
  it("sets Canvas access for Slack channels and users with the user token", async () => {
    const apiCalls: unknown[] = [];
    const setter = createSlackCanvasAccessSetter((token) => ({
      async apiCall(method, options) {
        apiCalls.push({ method, options, token });
        return { ok: true };
      },
    }));

    await setter.setCanvasAccess({
      canvasId: "F0B6PN7YQZ",
      channelAccessLevel: "read",
      channelIds: ["C1"],
      teamId: "T1",
      token: "xoxp-token",
      userAccessLevel: "write",
      userId: "U1",
      userIds: ["U1"],
    });

    expect(apiCalls).toEqual([
      {
        method: "canvases.access.set",
        options: {
          access_level: "read",
          canvas_id: "F0B6PN7YQZ",
          channel_ids: ["C1"],
        },
        token: "xoxp-token",
      },
      {
        method: "canvases.access.set",
        options: {
          access_level: "write",
          canvas_id: "F0B6PN7YQZ",
          user_ids: ["U1"],
        },
        token: "xoxp-token",
      },
    ]);
  });

  it("skips Slack API calls when no channel or user ids are available", async () => {
    const apiCalls: unknown[] = [];
    const setter = createSlackCanvasAccessSetter(() => ({
      async apiCall(method, options) {
        apiCalls.push({ method, options });
        return { ok: true };
      },
    }));

    await setter.setCanvasAccess({
      canvasId: "F0B6PN7YQZ",
      channelAccessLevel: "read",
      channelIds: [],
      teamId: "T1",
      token: "xoxp-token",
      userAccessLevel: "write",
      userId: "U1",
      userIds: [],
    });

    expect(apiCalls).toEqual([]);
  });

  it("throws when Slack reports Canvas access failure without raising", async () => {
    const setter = createSlackCanvasAccessSetter(() => ({
      async apiCall() {
        return { error: "restricted_action", ok: false };
      },
    }));

    await expect(
      setter.setCanvasAccess({
        canvasId: "F0B6PN7YQZ",
        channelAccessLevel: "read",
        channelIds: ["C1"],
        teamId: "T1",
        token: "xoxp-token",
        userAccessLevel: "write",
        userId: "U1",
        userIds: [],
      }),
    ).rejects.toThrow("restricted_action");
  });
});
