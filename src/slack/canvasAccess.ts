import { WebClient } from "@slack/web-api";

import type { SlackMcpCanvasAccessSetter } from "../agents/slackMcp/index.js";

type SlackWebApiCaller = Pick<WebClient, "apiCall">;

export function createSlackCanvasAccessSetter(
  clientFactory: (token: string) => SlackWebApiCaller = (token) => new WebClient(token),
): SlackMcpCanvasAccessSetter {
  return {
    async setCanvasAccess(input) {
      if (input.channelIds.length > 0) {
        await setAccess(clientFactory(input.token), {
          accessLevel: input.channelAccessLevel,
          canvasId: input.canvasId,
          channelIds: input.channelIds,
        });
      }
      if (input.userIds.length > 0) {
        await setAccess(clientFactory(input.token), {
          accessLevel: input.userAccessLevel,
          canvasId: input.canvasId,
          userIds: input.userIds,
        });
      }
    },
  };
}

async function setAccess(
  client: SlackWebApiCaller,
  input:
    | {
        accessLevel: "read" | "write";
        canvasId: string;
        channelIds: string[];
      }
    | {
        accessLevel: "read" | "write";
        canvasId: string;
        userIds: string[];
      },
): Promise<void> {
  const response = await client.apiCall("canvases.access.set", {
    access_level: input.accessLevel,
    canvas_id: input.canvasId,
    ...("channelIds" in input ? { channel_ids: input.channelIds } : { user_ids: input.userIds }),
  });
  if (response.ok === false) {
    throw new Error(
      `Slack canvases.access.set failed: ${typeof response.error === "string" ? response.error : "unknown_error"}`,
    );
  }
}
