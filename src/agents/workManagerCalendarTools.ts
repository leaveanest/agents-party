import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { JsonValue } from "../domain/messageHistory.js";
import type { CalendarProviderKind } from "../domain/workItemCalendar.js";
import type { WorkItemCalendarLinkRepository } from "../repositories/workItemCalendarLinks.js";
import type { AgentToolDefinition } from "./toolContracts.js";

type JsonObject = { [key: string]: JsonValue };

const syncStatusSchema = z.enum(["active", "canceled", "not_found"]);

const linkGoogleCalendarEventInputSchema = z
  .object({
    actorUserId: z.string().min(1),
    applyStartsAtToDueAt: z.boolean().default(false),
    applyStartsAtToNextAttentionAtForUserId: z.string().min(1).optional(),
    endsAt: z.string().datetime().optional(),
    eventTitleSnapshot: z.string().optional(),
    googleCalendarId: z.string().min(1),
    googleEventId: z.string().min(1),
    isAllDay: z.boolean().default(false),
    linkId: z.string().min(1).optional(),
    responseStatus: z.string().optional(),
    startsAt: z.string().datetime().optional(),
    syncStatus: syncStatusSchema.default("active"),
    teamId: z.string().min(1),
    workItemId: z.string().min(1),
  })
  .strict();

const unlinkGoogleCalendarEventInputSchema = z
  .object({
    actorUserId: z.string().min(1),
    linkId: z.string().min(1),
    teamId: z.string().min(1),
    workItemId: z.string().min(1),
  })
  .strict();

const calendarToolOutputSchema = z
  .object({
    action: z.enum(["linked", "unlinked"]),
    linkId: z.string().min(1),
    message: z.string().min(1),
    workItemId: z.string().min(1),
  })
  .strict();

type CalendarToolOutput = z.infer<typeof calendarToolOutputSchema>;
type LinkGoogleCalendarEventInput = z.infer<typeof linkGoogleCalendarEventInputSchema>;
type UnlinkGoogleCalendarEventInput = z.infer<typeof unlinkGoogleCalendarEventInputSchema>;

export function createWorkManagerCalendarTools(
  repository: WorkItemCalendarLinkRepository,
): AgentToolDefinition<
  LinkGoogleCalendarEventInput | UnlinkGoogleCalendarEventInput,
  CalendarToolOutput
>[] {
  return [
    {
      description:
        "Link a work item to a Google Calendar event snapshot. Does not change due_at or next_attention_at unless explicitly requested.",
      execute: async (input) => {
        const parsed = linkGoogleCalendarEventInputSchema.parse(input);
        const linkId = parsed.linkId ?? randomUUID();
        await repository.linkCalendarEvent({
          actorUserId: parsed.actorUserId,
          applyStartsAtToDueAt: parsed.applyStartsAtToDueAt,
          ...(parsed.applyStartsAtToNextAttentionAtForUserId === undefined
            ? {}
            : {
                applyStartsAtToNextAttentionAtForUserId:
                  parsed.applyStartsAtToNextAttentionAtForUserId,
              }),
          calendarLink: calendarLinkFromInput(parsed, linkId),
          teamId: parsed.teamId,
          workItemId: parsed.workItemId,
        });
        return {
          action: "linked",
          linkId,
          message: `Linked work item ${parsed.workItemId} to Google Calendar event ${parsed.googleEventId}.`,
          workItemId: parsed.workItemId,
        };
      },
      name: "link_google_calendar_event",
      outputSchema: calendarToolOutputSchema,
      parameters: {
        additionalProperties: false,
        properties: {
          actorUserId: { type: "string" },
          applyStartsAtToDueAt: { default: false, type: "boolean" },
          applyStartsAtToNextAttentionAtForUserId: { type: "string" },
          endsAt: { format: "date-time", type: "string" },
          eventTitleSnapshot: { type: "string" },
          googleCalendarId: { type: "string" },
          googleEventId: { type: "string" },
          isAllDay: { default: false, type: "boolean" },
          linkId: { type: "string" },
          responseStatus: { type: "string" },
          startsAt: { format: "date-time", type: "string" },
          syncStatus: {
            default: "active",
            enum: ["active", "canceled", "not_found"],
            type: "string",
          },
          teamId: { type: "string" },
          workItemId: { type: "string" },
        },
        required: ["actorUserId", "googleCalendarId", "googleEventId", "teamId", "workItemId"],
        type: "object",
      },
      schema: linkGoogleCalendarEventInputSchema,
    },
    {
      description: "Unlink a Google Calendar event snapshot from a work item.",
      execute: async (input) => {
        const parsed = unlinkGoogleCalendarEventInputSchema.parse(input);
        await repository.unlinkCalendarEvent(parsed);
        return {
          action: "unlinked",
          linkId: parsed.linkId,
          message: `Unlinked Google Calendar event ${parsed.linkId} from work item ${parsed.workItemId}.`,
          workItemId: parsed.workItemId,
        };
      },
      name: "unlink_google_calendar_event",
      outputSchema: calendarToolOutputSchema,
      parameters: {
        additionalProperties: false,
        properties: {
          actorUserId: { type: "string" },
          linkId: { type: "string" },
          teamId: { type: "string" },
          workItemId: { type: "string" },
        },
        required: ["actorUserId", "linkId", "teamId", "workItemId"],
        type: "object",
      },
      schema: unlinkGoogleCalendarEventInputSchema,
    },
  ];
}

function calendarLinkFromInput(input: LinkGoogleCalendarEventInput, linkId: string): JsonObject {
  return dropUndefined({
    created_at: new Date().toISOString(),
    ends_at: input.endsAt,
    event_title_snapshot: input.eventTitleSnapshot,
    external_calendar_id: input.googleCalendarId,
    external_event_id: input.googleEventId,
    is_all_day: input.isAllDay,
    link_id: linkId,
    provider_kind: "google_calendar" satisfies CalendarProviderKind,
    response_status: input.responseStatus,
    starts_at: input.startsAt,
    sync_status: input.syncStatus,
    team_id: input.teamId,
    updated_at: new Date().toISOString(),
    work_item_id: input.workItemId,
  });
}

function dropUndefined(input: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as JsonObject;
}
