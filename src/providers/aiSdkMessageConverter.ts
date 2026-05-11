import type { FilePart, ImagePart, ModelMessage, TextPart, ToolCallPart, ToolResultPart } from "ai";

import type {
  AttachmentSource,
  AudioAttachmentPart,
  ConversationHistory,
  ConversationMessage,
  FileAttachmentPart,
  ImageAttachmentPart,
  ToolResultOutput,
  UserMessagePart,
} from "../domain/messageHistory.js";

export type AttachmentConversionMode = "native" | "text" | "reject";

export type AiSdkMessageConversionCapabilities = {
  audio: AttachmentConversionMode;
  files: AttachmentConversionMode;
  images: AttachmentConversionMode;
};

export const textOnlyCapabilities: AiSdkMessageConversionCapabilities = {
  audio: "text",
  files: "text",
  images: "text",
};

export const nativeMultimodalCapabilities: AiSdkMessageConversionCapabilities = {
  audio: "native",
  files: "native",
  images: "native",
};

export class UnsupportedAttachmentError extends Error {
  constructor(
    readonly attachmentId: string,
    readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = "UnsupportedAttachmentError";
  }
}

export function convertHistoryToAiSdkMessages(
  history: ConversationHistory,
  capabilities: AiSdkMessageConversionCapabilities,
): ModelMessage[] {
  return history.messages.map((message) => convertMessage(message, capabilities));
}

function convertMessage(
  message: ConversationMessage,
  capabilities: AiSdkMessageConversionCapabilities,
): ModelMessage {
  switch (message.role) {
    case "system":
      return {
        content: message.content,
        role: "system",
      };
    case "user":
      return {
        content: convertUserContent(message.content, capabilities),
        role: "user",
      };
    case "assistant":
      return {
        content: message.content.map((part): TextPart | ToolCallPart => {
          if (part.type === "text") {
            return {
              text: part.text,
              type: "text",
            };
          }
          return {
            input: part.input,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            type: "tool-call",
          };
        }),
        role: "assistant",
      };
    case "tool":
      return {
        content: message.content.map(
          (part): ToolResultPart => ({
            output: convertToolOutput(part.output),
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            type: "tool-result",
          }),
        ),
        role: "tool",
      };
  }
}

function convertUserContent(
  parts: UserMessagePart[],
  capabilities: AiSdkMessageConversionCapabilities,
): string | Array<TextPart | ImagePart | FilePart> {
  const convertedParts = parts.flatMap((part): Array<TextPart | ImagePart | FilePart> => {
    switch (part.type) {
      case "text":
        return [
          {
            text: part.text,
            type: "text",
          },
        ];
      case "image":
        return convertImagePart(part, capabilities);
      case "file":
        return convertFilePart(part, capabilities);
      case "audio":
        return convertAudioPart(part, capabilities);
    }
  });

  if (convertedParts.length === 1 && convertedParts[0]?.type === "text") {
    return convertedParts[0].text;
  }
  return convertedParts;
}

function convertImagePart(
  part: ImageAttachmentPart,
  capabilities: AiSdkMessageConversionCapabilities,
): Array<TextPart | ImagePart> {
  switch (capabilities.images) {
    case "native":
      return [
        {
          image: convertAttachmentSource(part.id, part.source),
          mediaType: part.mediaType,
          type: "image",
        },
      ];
    case "text":
      return [attachmentTextPart(part, "image")];
    case "reject":
      throw unsupportedAttachment(part.id, "image");
  }
}

function convertFilePart(
  part: FileAttachmentPart,
  capabilities: AiSdkMessageConversionCapabilities,
): Array<TextPart | FilePart> {
  switch (capabilities.files) {
    case "native":
      return [
        {
          data: convertAttachmentSource(part.id, part.source),
          filename: part.filename,
          mediaType: part.mediaType,
          type: "file",
        },
      ];
    case "text":
      return [attachmentTextPart(part, "file")];
    case "reject":
      throw unsupportedAttachment(part.id, "file");
  }
}

function convertAudioPart(
  part: AudioAttachmentPart,
  capabilities: AiSdkMessageConversionCapabilities,
): Array<TextPart | FilePart> {
  switch (capabilities.audio) {
    case "native":
      return [
        {
          data: convertAttachmentSource(part.id, part.source),
          filename: part.filename,
          mediaType: part.mediaType,
          type: "file",
        },
      ];
    case "text":
      return [
        {
          text: extractedAttachmentText(part, "audio"),
          type: "text",
        },
      ];
    case "reject":
      throw unsupportedAttachment(part.id, "audio");
  }
}

function attachmentTextPart(
  part: ImageAttachmentPart | FileAttachmentPart,
  label: "file" | "image",
): TextPart {
  return {
    text: extractedAttachmentText(part, label),
    type: "text",
  };
}

function extractedAttachmentText(
  part: AudioAttachmentPart | FileAttachmentPart | ImageAttachmentPart,
  label: "audio" | "file" | "image",
): string {
  const text = part.type === "audio" ? (part.transcript ?? part.extractedText) : part.extractedText;
  if (text !== undefined && text.trim().length > 0) {
    return `[${label}: ${part.filename ?? part.id}]\n${text}`;
  }
  throw new UnsupportedAttachmentError(
    part.id,
    `The ${label} attachment '${part.filename ?? part.id}' is not supported by the selected model and no extracted text is available.`,
  );
}

function unsupportedAttachment(id: string, label: "audio" | "file" | "image"): never {
  throw new UnsupportedAttachmentError(
    id,
    `The ${label} attachment '${id}' is not supported by the selected model.`,
  );
}

function convertAttachmentSource(id: string, source: AttachmentSource): string | Uint8Array | URL {
  switch (source.type) {
    case "base64":
      return source.data;
    case "bytes":
      return source.data;
    case "url":
      try {
        return new URL(source.url);
      } catch {
        throw new UnsupportedAttachmentError(
          id,
          `The attachment '${id}' has an invalid URL and cannot be sent to the selected model.`,
        );
      }
    case "unavailable":
      throw new UnsupportedAttachmentError(
        id,
        `The attachment '${id}' is unavailable and cannot be sent to the selected model. ${source.reason}`,
      );
  }
}

function convertToolOutput(output: ToolResultOutput): ToolResultPart["output"] {
  switch (output.type) {
    case "text":
      return {
        type: "text",
        value: output.value,
      };
    case "json":
      return {
        type: "json",
        value: output.value,
      };
    case "execution-denied":
      return {
        reason: output.reason,
        type: "execution-denied",
      };
  }
}
