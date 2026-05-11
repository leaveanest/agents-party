import type {
  AttachmentSource,
  ConversationActor,
  MessageProvenance,
  UserConversationMessage,
  UserMessagePart,
} from "../domain/messageHistory.js";

export type SlackThreadMessageInput = {
  channelId: string;
  files?: SlackFileInput[];
  messageTs: string;
  teamId: string;
  text?: string;
  threadTs?: string;
  userId?: string;
  username?: string;
};

export type SlackFileInput = {
  id: string;
  data?: Uint8Array;
  extractedText?: string;
  filename?: string;
  mediaType?: string;
  transcript?: string;
};

export function normalizeSlackThreadMessage(
  input: SlackThreadMessageInput,
): UserConversationMessage {
  return {
    author: buildActor(input),
    content: buildMessageParts(input),
    id: `slack:${input.teamId}:${input.channelId}:${input.messageTs}`,
    provenance: buildProvenance(input),
    role: "user",
  };
}

function buildActor(input: SlackThreadMessageInput): ConversationActor {
  return {
    displayName: input.username,
    id: input.userId ?? "unknown",
    kind: input.userId === undefined ? "bot" : "user",
  };
}

function buildMessageParts(input: SlackThreadMessageInput): UserMessagePart[] {
  const parts: UserMessagePart[] = [];
  if (input.text !== undefined && input.text.trim().length > 0) {
    parts.push({
      text: input.text,
      type: "text",
    });
  }

  for (const file of input.files ?? []) {
    parts.push(normalizeSlackFile(file));
  }

  if (parts.length === 0) {
    parts.push({
      text: "",
      type: "text",
    });
  }
  return parts;
}

function normalizeSlackFile(file: SlackFileInput): UserMessagePart {
  const mediaType = file.mediaType ?? "application/octet-stream";
  const base = {
    extractedText: file.extractedText,
    filename: file.filename,
    id: file.id,
    mediaType,
    source: buildAttachmentSource(file),
  };

  if (mediaType.startsWith("image/")) {
    return {
      ...base,
      type: "image",
    };
  }
  if (mediaType.startsWith("audio/")) {
    return {
      ...base,
      transcript: file.transcript,
      type: "audio",
    };
  }
  return {
    ...base,
    type: "file",
  };
}

function buildAttachmentSource(file: SlackFileInput): AttachmentSource {
  if (file.data !== undefined) {
    return {
      data: file.data,
      type: "bytes",
    };
  }
  return {
    reason: "Slack file has not been downloaded into application-controlled bytes.",
    type: "unavailable",
  };
}

function buildProvenance(input: SlackThreadMessageInput): MessageProvenance {
  return {
    externalMessageId: input.messageTs,
    source: "slack",
    threadId: `${input.teamId}:${input.channelId}:${input.threadTs ?? input.messageTs}`,
  };
}
