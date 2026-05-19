export type ConversationHistory = {
  messages: ConversationMessage[];
};

export type ConversationMessage =
  | UserConversationMessage
  | AssistantConversationMessage
  | ToolConversationMessage;

export type ConversationMessageBase = {
  id: string;
  createdAt?: Date;
  provenance?: MessageProvenance;
};

export type MessageProvenance = {
  source: "slack" | "agent" | "tool" | "system";
  externalMessageId?: string;
  threadId?: string;
};

export type UserConversationMessage = ConversationMessageBase & {
  role: "user";
  author: ConversationActor;
  content: UserMessagePart[];
};

export type AssistantConversationMessage = ConversationMessageBase & {
  role: "assistant";
  content: AssistantMessagePart[];
};

export type ToolConversationMessage = ConversationMessageBase & {
  role: "tool";
  content: ToolResultMessagePart[];
};

export type ConversationActor = {
  id: string;
  displayName?: string;
  kind: "user" | "bot" | "system";
};

export type UserMessagePart =
  | TextMessagePart
  | ImageAttachmentPart
  | FileAttachmentPart
  | AudioAttachmentPart;

export type AssistantMessagePart = TextMessagePart | ToolCallMessagePart;

export type TextMessagePart = {
  type: "text";
  text: string;
};

export type AttachmentBase = {
  id: string;
  filename?: string;
  mediaType: string;
  source: AttachmentSource;
  extractedText?: string;
};

export type ImageAttachmentPart = AttachmentBase & {
  type: "image";
};

export type FileAttachmentPart = AttachmentBase & {
  type: "file";
};

export type AudioAttachmentPart = AttachmentBase & {
  type: "audio";
  transcript?: string;
};

export type AttachmentSource =
  | {
      type: "base64";
      data: string;
    }
  | {
      type: "bytes";
      data: Uint8Array;
    }
  | {
      type: "url";
      url: string;
    }
  | {
      type: "unavailable";
      reason: string;
    };

export type ToolCallMessagePart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export type ToolResultMessagePart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: ToolResultOutput;
};

export type ToolResultOutput =
  | {
      type: "text";
      value: string;
    }
  | {
      type: "json";
      value: JsonValue;
    }
  | {
      type: "execution-denied";
      reason?: string;
    };

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
