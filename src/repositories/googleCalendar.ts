import type {
  GoogleCalendarCalendar,
  GoogleCalendarEvent,
  GoogleCalendarEventQuery,
} from "../domain/googleCalendar.js";

export type GoogleCalendarUserContext = {
  googleAccountSubject?: string;
  slackUserId: string;
  teamId: string;
};

export type GoogleCalendarReadGateway = {
  getEvent(
    context: GoogleCalendarUserContext,
    input: { calendarId: string; eventId: string },
  ): Promise<GoogleCalendarEvent>;
  listCalendars(context: GoogleCalendarUserContext): Promise<GoogleCalendarCalendar[]>;
  listUpcomingEvents(
    context: GoogleCalendarUserContext,
    input?: { calendarId?: string; limit?: number; timeMin?: Date | string },
  ): Promise<GoogleCalendarEvent[]>;
  searchEvents(
    context: GoogleCalendarUserContext,
    query: GoogleCalendarEventQuery,
  ): Promise<GoogleCalendarEvent[]>;
};

export type GoogleCalendarReconnectReason =
  | "broken_connection"
  | "expired_connection"
  | "missing_connection"
  | "revoked_or_unauthorized"
  | "unavailable_token";

export class GoogleCalendarReconnectRequiredError extends Error {
  readonly guidance: string;
  readonly reason: GoogleCalendarReconnectReason;

  constructor(reason: GoogleCalendarReconnectReason, message: string) {
    super(message);
    this.name = "GoogleCalendarReconnectRequiredError";
    this.reason = reason;
    this.guidance = "Reconnect Google Calendar from the app before using calendar features.";
  }
}

export class GoogleCalendarGatewayError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    input: { code: string; retriable?: boolean; statusCode?: number | undefined },
  ) {
    super(message);
    this.name = "GoogleCalendarGatewayError";
    this.code = input.code;
    this.retriable = input.retriable ?? false;
    this.statusCode = input.statusCode;
  }
}
