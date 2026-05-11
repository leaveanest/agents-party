import type { JsonValue } from "../domain/messageHistory.js";

export type JsonObject = { [key: string]: JsonValue };

export type WorkItemCalendarLinkRepository = {
  linkCalendarEvent(input: {
    actorUserId: string;
    applyStartsAtToDueAt?: boolean;
    applyStartsAtToNextAttentionAtForUserId?: string;
    calendarLink: JsonObject;
    teamId: string;
    workItemId: string;
  }): Promise<unknown>;
  unlinkCalendarEvent(input: {
    actorUserId: string;
    linkId: string;
    teamId: string;
    workItemId: string;
  }): Promise<unknown>;
};
