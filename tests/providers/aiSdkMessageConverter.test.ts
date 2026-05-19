import { describe, expect, it } from "vite-plus/test";

import type { ConversationHistory } from "../../src/domain/messageHistory.js";
import {
  convertHistoryToAiSdkMessages,
  nativeMultimodalCapabilities,
  textOnlyCapabilities,
  UnsupportedAttachmentError,
} from "../../src/providers/aiSdkMessageConverter.js";

describe("convertHistoryToAiSdkMessages", () => {
  it("rejects system instructions in conversation history", () => {
    const history = {
      messages: [
        {
          content: "You are helpful.",
          id: "system-1",
          role: "system",
        },
      ],
    } as unknown as ConversationHistory;

    expect(() => convertHistoryToAiSdkMessages(history, nativeMultimodalCapabilities)).toThrow(
      "Pass system instructions via LlmRequest.system instead",
    );
  });

  it("converts native multimodal user parts into AI SDK model messages", () => {
    const messages = convertHistoryToAiSdkMessages(
      {
        messages: [
          {
            author: { id: "U1", kind: "user" },
            content: [
              { text: "Read these", type: "text" },
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
                source: { data: new Uint8Array([1, 2, 3]), type: "bytes" },
                type: "file",
              },
            ],
            id: "user-1",
            role: "user",
          },
        ],
      },
      nativeMultimodalCapabilities,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toEqual([
      { text: "Read these", type: "text" },
      {
        image: new URL("https://example.com/image.png"),
        mediaType: "image/png",
        type: "image",
      },
      {
        data: new Uint8Array([1, 2, 3]),
        filename: "brief.pdf",
        mediaType: "application/pdf",
        type: "file",
      },
    ]);
  });

  it("converts attachments to extracted text for text-only providers", () => {
    const messages = convertHistoryToAiSdkMessages(
      {
        messages: [
          {
            author: { id: "U1", kind: "user" },
            content: [
              {
                extractedText: "Chart shows growth.",
                filename: "chart.png",
                id: "image-1",
                mediaType: "image/png",
                source: { type: "url", url: "https://example.com/chart.png" },
                type: "image",
              },
              {
                id: "audio-1",
                mediaType: "audio/mpeg",
                source: { data: "base64-audio", type: "base64" },
                transcript: "Call transcript",
                type: "audio",
              },
            ],
            id: "user-1",
            role: "user",
          },
        ],
      },
      textOnlyCapabilities,
    );

    expect(messages[0]?.content).toEqual([
      { text: "[image: chart.png]\nChart shows growth.", type: "text" },
      { text: "[audio: audio-1]\nCall transcript", type: "text" },
    ]);
  });

  it("throws a clear error when unsupported attachments cannot degrade", () => {
    const history: ConversationHistory = {
      messages: [
        {
          author: { id: "U1", kind: "user" },
          content: [
            {
              filename: "unknown.bin",
              id: "file-1",
              mediaType: "application/octet-stream",
              source: { data: "", type: "base64" },
              type: "file",
            },
          ],
          id: "user-1",
          role: "user",
        },
      ],
    };

    expect(() => convertHistoryToAiSdkMessages(history, textOnlyCapabilities)).toThrow(
      UnsupportedAttachmentError,
    );
    expect(() => convertHistoryToAiSdkMessages(history, textOnlyCapabilities)).toThrow(
      "not supported by the selected model and no extracted text is available",
    );
  });

  it("throws a clear error when native conversion has no attachment source", () => {
    const history: ConversationHistory = {
      messages: [
        {
          author: { id: "U1", kind: "user" },
          content: [
            {
              id: "image-1",
              mediaType: "image/png",
              source: { reason: "Slack file was not downloaded.", type: "unavailable" },
              type: "image",
            },
          ],
          id: "user-1",
          role: "user",
        },
      ],
    };

    expect(() => convertHistoryToAiSdkMessages(history, nativeMultimodalCapabilities)).toThrow(
      "is unavailable and cannot be sent",
    );
  });

  it("converts assistant tool calls and tool results", () => {
    const messages = convertHistoryToAiSdkMessages(
      {
        messages: [
          {
            content: [
              { text: "Checking.", type: "text" },
              {
                input: { query: "weather" },
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
                output: { type: "json", value: { result: "sunny" } },
                toolCallId: "call-1",
                toolName: "search",
                type: "tool-result",
              },
            ],
            id: "tool-1",
            role: "tool",
          },
        ],
      },
      nativeMultimodalCapabilities,
    );

    expect(messages).toEqual([
      {
        content: [
          { text: "Checking.", type: "text" },
          {
            input: { query: "weather" },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "json", value: { result: "sunny" } },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);
  });
});
