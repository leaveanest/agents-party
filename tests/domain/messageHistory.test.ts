import { describe, expect, it } from "vite-plus/test";

import type { ConversationHistory } from "../../src/domain/messageHistory.js";

describe("ConversationHistory", () => {
  it("represents text, image, file, audio, assistant, and tool-result messages", () => {
    const history: ConversationHistory = {
      messages: [
        {
          content: "You are helpful.",
          id: "system-1",
          role: "system",
        },
        {
          author: { id: "U1", kind: "user" },
          content: [
            { text: "Please summarize these.", type: "text" },
            {
              id: "image-1",
              mediaType: "image/png",
              source: { type: "url", url: "https://example.com/image.png" },
              type: "image",
            },
            {
              filename: "brief.pdf",
              id: "file-1",
              mediaType: "application/pdf",
              source: { data: "base64-pdf", type: "base64" },
              type: "file",
            },
            {
              id: "audio-1",
              mediaType: "audio/mpeg",
              source: { data: new Uint8Array([1, 2, 3]), type: "bytes" },
              transcript: "Meeting transcript",
              type: "audio",
            },
          ],
          id: "user-1",
          role: "user",
        },
        {
          content: [
            { text: "I will call a tool.", type: "text" },
            {
              input: { query: "calendar" },
              toolCallId: "call-1",
              toolName: "search",
              type: "tool-call",
            },
          ],
          id: "assistant-1",
          role: "assistant",
        },
        {
          content: [
            {
              output: { type: "json", value: { ok: true } },
              toolCallId: "call-1",
              toolName: "search",
              type: "tool-result",
            },
          ],
          id: "tool-1",
          role: "tool",
        },
      ],
    };

    expect(history.messages).toHaveLength(4);
  });
});
