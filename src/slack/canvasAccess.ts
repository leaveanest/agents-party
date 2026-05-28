import { WebClient } from "@slack/web-api";

import type { SlackMcpCanvasAccessSetter } from "../agents/slackMcp/index.js";

type SlackWebApiCaller = Pick<WebClient, "apiCall">;

export function createSlackCanvasAccessSetter(
  clientFactory: (token: string) => SlackWebApiCaller = (token) => new WebClient(token),
): SlackMcpCanvasAccessSetter {
  return {
    async setCanvasAccess(input) {
      if (input.channelIds.length === 0) {
        return;
      }
      const response = await clientFactory(input.token).apiCall("canvases.access.set", {
        access_level: input.accessLevel,
        canvas_id: input.canvasId,
        channel_ids: input.channelIds,
      });
      if (response.ok === false) {
        throw new Error(
          `Slack canvases.access.set failed: ${typeof response.error === "string" ? response.error : "unknown_error"}`,
        );
      }
    },
  };
}
