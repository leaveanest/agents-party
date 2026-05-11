import { describe, expect, it } from "vite-plus/test";

import { normalizeSlackThreadMessage } from "../../src/slack/messageHistory.js";

describe("normalizeSlackThreadMessage", () => {
  it("converts Slack text and files into repository-owned domain parts", () => {
    const message = normalizeSlackThreadMessage({
      channelId: "C1",
      files: [
        {
          id: "F-image",
          mediaType: "image/png",
        },
        {
          extractedText: "PDF text",
          filename: "brief.pdf",
          id: "F-pdf",
          mediaType: "application/pdf",
        },
        {
          id: "F-audio",
          mediaType: "audio/mpeg",
          transcript: "Audio transcript",
        },
      ],
      messageTs: "1710000000.000100",
      teamId: "T1",
      text: "hello",
      threadTs: "1710000000.000000",
      userId: "U1",
      username: "Koizumi",
    });

    expect(message.id).toBe("slack:T1:C1:1710000000.000100");
    expect(message.author).toEqual({
      displayName: "Koizumi",
      id: "U1",
      kind: "user",
    });
    expect(message.provenance).toMatchObject({
      source: "slack",
      threadId: "T1:C1:1710000000.000000",
    });
    expect(message.content.map((part) => part.type)).toEqual(["text", "image", "file", "audio"]);
    expect(message.content[1]).toMatchObject({
      source: { type: "unavailable" },
    });
  });

  it("keeps empty Slack messages representable", () => {
    const message = normalizeSlackThreadMessage({
      channelId: "C1",
      messageTs: "1710000000.000100",
      teamId: "T1",
    });

    expect(message.content).toEqual([{ text: "", type: "text" }]);
  });
});
