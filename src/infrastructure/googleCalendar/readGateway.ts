import {
  googleAuthConnectionSchema,
  toJsonObject,
  type GoogleAuthConnection,
} from "../../integrations/oauth/domain.js";
import type { FernetTextCipher } from "../../integrations/oauth/fernet.js";
import type { GoogleAuthConnectionDocument } from "../postgres/appRepositories.js";
import type { JsonObject } from "../postgres/jsonDocumentRepository.js";
import type {
  GoogleCalendarCalendar,
  GoogleCalendarEvent,
  GoogleCalendarEventAttendee,
  GoogleCalendarEventDateTime,
  GoogleCalendarEventQuery,
} from "../../domain/googleCalendar.js";
import {
  GoogleCalendarGatewayError,
  GoogleCalendarReconnectRequiredError,
  type GoogleCalendarReadGateway,
  type GoogleCalendarUserContext,
} from "../../repositories/googleCalendar.js";

export type GoogleCalendarConnectionStore = {
  listGoogleConnections(teamId: string, slackUserId?: string): Promise<JsonObject[]>;
  saveGoogleConnection(document: GoogleAuthConnectionDocument): Promise<void>;
};

export type GoogleCalendarApiClient = {
  getEvent(input: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<GoogleCalendarEvent>;
  listCalendars(input: { accessToken: string }): Promise<GoogleCalendarCalendar[]>;
  listEvents(input: {
    accessToken: string;
    calendarId: string;
    limit: number;
    query?: string;
    timeMax?: Date | string;
    timeMin?: Date | string;
  }): Promise<GoogleCalendarEvent[]>;
};

const GOOGLE_CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export class RepositoryBackedGoogleCalendarReadGateway implements GoogleCalendarReadGateway {
  private readonly apiClient: GoogleCalendarApiClient;
  private readonly connectionStore: GoogleCalendarConnectionStore;
  private readonly now: () => Date;
  private readonly tokenCipher: FernetTextCipher;

  constructor(input: {
    apiClient?: GoogleCalendarApiClient;
    connectionStore: GoogleCalendarConnectionStore;
    now?: () => Date;
    tokenCipher: FernetTextCipher;
  }) {
    this.apiClient = input.apiClient ?? new FetchGoogleCalendarApiClient();
    this.connectionStore = input.connectionStore;
    this.now = input.now ?? (() => new Date());
    this.tokenCipher = input.tokenCipher;
  }

  async listCalendars(context: GoogleCalendarUserContext): Promise<GoogleCalendarCalendar[]> {
    const connection = await this.requireConnection(context);
    const accessToken = this.decryptAccessToken(connection);
    return this.withAuthErrorHandling(connection, () =>
      this.apiClient.listCalendars({ accessToken }),
    );
  }

  async getEvent(
    context: GoogleCalendarUserContext,
    input: { calendarId: string; eventId: string },
  ): Promise<GoogleCalendarEvent> {
    const connection = await this.requireConnection(context);
    const accessToken = this.decryptAccessToken(connection);
    return this.withAuthErrorHandling(connection, () =>
      this.apiClient.getEvent({
        accessToken,
        calendarId: input.calendarId,
        eventId: input.eventId,
      }),
    );
  }

  async searchEvents(
    context: GoogleCalendarUserContext,
    query: GoogleCalendarEventQuery,
  ): Promise<GoogleCalendarEvent[]> {
    const connection = await this.requireConnection(context);
    const accessToken = this.decryptAccessToken(connection);
    return this.withAuthErrorHandling(connection, () =>
      this.apiClient.listEvents({
        accessToken,
        calendarId: query.calendarId ?? "primary",
        limit: normalizeLimit(query.limit),
        query: query.query,
        timeMax: query.timeMax,
        timeMin: query.timeMin,
      }),
    );
  }

  async listUpcomingEvents(
    context: GoogleCalendarUserContext,
    input: { calendarId?: string; limit?: number; timeMin?: Date | string } = {},
  ): Promise<GoogleCalendarEvent[]> {
    return this.searchEvents(context, {
      calendarId: input.calendarId,
      limit: input.limit,
      timeMin: input.timeMin ?? this.now(),
    });
  }

  private async requireConnection(
    context: GoogleCalendarUserContext,
  ): Promise<GoogleAuthConnection> {
    const connections: GoogleAuthConnection[] = [];
    let sawMalformedConnection = false;
    for (const payload of await this.connectionStore.listGoogleConnections(
      context.teamId,
      context.slackUserId,
    )) {
      const parsed = googleAuthConnectionSchema.safeParse(payload);
      if (!parsed.success) {
        sawMalformedConnection = true;
        continue;
      }
      if (
        context.googleAccountSubject === undefined
          ? true
          : parsed.data.google_account_subject === context.googleAccountSubject
      ) {
        connections.push(parsed.data);
      }
    }
    connections.sort((left, right) =>
      left.google_account_subject.localeCompare(right.google_account_subject),
    );
    if (connections.length === 0) {
      if (sawMalformedConnection) {
        throw new GoogleCalendarReconnectRequiredError(
          "broken_connection",
          "Google Calendar connection data is malformed; reconnect is required.",
        );
      }
      throw new GoogleCalendarReconnectRequiredError(
        "missing_connection",
        "Google Calendar is not connected for this Slack user.",
      );
    }
    const connection =
      connections.find((candidate) => candidate.connection_status === "active") ?? connections[0];
    if (connection.connection_status !== "active") {
      throw new GoogleCalendarReconnectRequiredError(
        "revoked_or_unauthorized",
        `Google Calendar connection is ${connection.connection_status}; reconnect is required.`,
      );
    }
    if (!hasCalendarReadScope(connection.granted_scopes)) {
      await this.markConnection(connection, "expired", "missing_calendar_readonly_scope");
      throw new GoogleCalendarReconnectRequiredError(
        "revoked_or_unauthorized",
        "Google Calendar read scope is missing; reconnect is required.",
      );
    }
    const tokenExpiresAt = connection.token_expires_at;
    if (tokenExpiresAt !== null && tokenExpiresAt !== undefined && tokenExpiresAt <= this.now()) {
      await this.markConnection(connection, "expired", "access_token_expired");
      throw new GoogleCalendarReconnectRequiredError(
        "expired_connection",
        "Google Calendar access token has expired; reconnect is required.",
      );
    }
    return connection;
  }

  private decryptAccessToken(connection: GoogleAuthConnection): string {
    try {
      return this.tokenCipher.decrypt(connection.access_token_encrypted);
    } catch {
      throw new GoogleCalendarReconnectRequiredError(
        "unavailable_token",
        "Google Calendar access token cannot be decrypted; reconnect is required.",
      );
    }
  }

  private async withAuthErrorHandling<T>(
    connection: GoogleAuthConnection,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await operation();
      await this.markConnection(connection, "active", null, { successfulAccess: true });
      return result;
    } catch (error) {
      if (error instanceof GoogleCalendarGatewayError && isAuthorizationFailure(error)) {
        await this.markConnection(connection, "expired", error.code);
        throw new GoogleCalendarReconnectRequiredError(
          "revoked_or_unauthorized",
          "Google Calendar authorization failed; reconnect is required.",
        );
      }
      throw error;
    }
  }

  private async markConnection(
    connection: GoogleAuthConnection,
    status: string,
    errorCode: string | null,
    options: { successfulAccess?: boolean } = {},
  ): Promise<void> {
    const now = this.now();
    await this.connectionStore.saveGoogleConnection(
      toStoredGoogleConnection({
        ...connection,
        connection_status: status,
        last_refresh_error_at: errorCode === null ? null : now,
        last_refresh_error_code: errorCode,
        last_successful_access_at:
          options.successfulAccess === true ? now : connection.last_successful_access_at,
        updated_at: now,
      }),
    );
  }
}

export class FetchGoogleCalendarApiClient implements GoogleCalendarApiClient {
  private static readonly apiBaseUrl = "https://www.googleapis.com/calendar/v3";

  private readonly fetchFn: typeof fetch;

  constructor(input: { fetchFn?: typeof fetch } = {}) {
    this.fetchFn = input.fetchFn ?? fetch;
  }

  async listCalendars(input: { accessToken: string }): Promise<GoogleCalendarCalendar[]> {
    const payload = await this.fetchJson(
      `${FetchGoogleCalendarApiClient.apiBaseUrl}/users/me/calendarList`,
      input.accessToken,
    );
    const items = arrayValue(payload.items);
    return items.map(parseCalendar);
  }

  async getEvent(input: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<GoogleCalendarEvent> {
    const payload = await this.fetchJson(
      `${FetchGoogleCalendarApiClient.apiBaseUrl}/calendars/${encodeURIComponent(
        input.calendarId,
      )}/events/${encodeURIComponent(input.eventId)}`,
      input.accessToken,
    );
    return parseEvent(input.calendarId, payload);
  }

  async listEvents(input: {
    accessToken: string;
    calendarId: string;
    limit: number;
    query?: string;
    timeMax?: Date | string;
    timeMin?: Date | string;
  }): Promise<GoogleCalendarEvent[]> {
    const url = new URL(
      `${FetchGoogleCalendarApiClient.apiBaseUrl}/calendars/${encodeURIComponent(
        input.calendarId,
      )}/events`,
    );
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", String(input.limit));
    setDateParam(url, "timeMin", input.timeMin);
    setDateParam(url, "timeMax", input.timeMax);
    if (input.query !== undefined && input.query.trim() !== "") {
      url.searchParams.set("q", input.query);
    }
    const payload = await this.fetchJson(url, input.accessToken);
    return arrayValue(payload.items).map((event) => parseEvent(input.calendarId, event));
  }

  private async fetchJson(
    url: string | URL,
    accessToken: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchFn(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
    });
    const payload = await safeJson(response);
    if (response.ok) {
      return payload;
    }
    throw calendarApiError(response.status, payload);
  }
}

function toStoredGoogleConnection(connection: GoogleAuthConnection): GoogleAuthConnectionDocument {
  const payload = toJsonObject(serializeDates(connection));
  return {
    connectionStatus: connection.connection_status,
    googleAccountEmail: connection.google_account_email ?? undefined,
    googleAccountSubject: connection.google_account_subject,
    payload,
    refreshTokenExpiresAt: connection.refresh_token_expires_at ?? undefined,
    slackUserId: connection.slack_user_id,
    teamId: connection.team_id,
    tokenExpiresAt: connection.token_expires_at ?? undefined,
    updatedAt: connection.updated_at,
  };
}

function parseCalendar(payload: Record<string, unknown>): GoogleCalendarCalendar {
  const id = requiredText(payload.id, "Google Calendar calendar item did not include id.");
  return {
    accessRole: textValue(payload.accessRole),
    id,
    primary: payload.primary === true,
    summary: textValue(payload.summary) ?? id,
    timeZone: textValue(payload.timeZone),
  };
}

function parseEvent(calendarId: string, payload: Record<string, unknown>): GoogleCalendarEvent {
  const eventId = requiredText(payload.id, "Google Calendar event did not include id.");
  const start = parseEventDateTime(objectValue(payload.start), "start");
  const end = parseEventDateTime(objectValue(payload.end), "end");
  return {
    attendees: arrayValue(payload.attendees).map(parseAttendee),
    calendarId,
    description: textValue(payload.description),
    end,
    eventId,
    htmlLink: textValue(payload.htmlLink),
    isAllDay: start.date !== undefined && start.dateTime === undefined,
    location: textValue(payload.location),
    organizerEmail: textValue(objectValue(payload.organizer)?.email),
    start,
    status: textValue(payload.status),
    summary: textValue(payload.summary),
    updated: textValue(payload.updated),
  };
}

function parseAttendee(payload: Record<string, unknown>): GoogleCalendarEventAttendee {
  return {
    displayName: textValue(payload.displayName),
    email: textValue(payload.email),
    optional: booleanValue(payload.optional),
    responseStatus: textValue(payload.responseStatus),
    self: booleanValue(payload.self),
  };
}

function parseEventDateTime(
  payload: Record<string, unknown> | undefined,
  label: string,
): GoogleCalendarEventDateTime {
  if (payload === undefined) {
    throw new GoogleCalendarGatewayError(`Google Calendar event did not include ${label}.`, {
      code: "invalid_event_response",
    });
  }
  const date = textValue(payload.date);
  const dateTime = textValue(payload.dateTime);
  if (date === undefined && dateTime === undefined) {
    throw new GoogleCalendarGatewayError(
      `Google Calendar event ${label} did not include date or dateTime.`,
      { code: "invalid_event_response" },
    );
  }
  return {
    date,
    dateTime,
    timeZone: textValue(payload.timeZone),
  };
}

function calendarApiError(
  statusCode: number,
  payload: Record<string, unknown>,
): GoogleCalendarGatewayError {
  const errorPayload = objectValue(payload.error);
  const reason = firstGoogleErrorReason(errorPayload);
  const message =
    textValue(errorPayload?.message) ??
    textValue(payload.error_description) ??
    textValue(payload.error) ??
    "Google Calendar API request failed.";
  return new GoogleCalendarGatewayError(message, {
    code:
      reason ??
      textValue(errorPayload?.status) ??
      textValue(errorPayload?.code) ??
      `http_${statusCode}`,
    retriable: statusCode >= 500,
    statusCode,
  });
}

function isAuthorizationFailure(error: GoogleCalendarGatewayError): boolean {
  return (
    error.statusCode === 401 ||
    (error.statusCode === 403 &&
      ["authError", "insufficientPermissions", "invalidCredentials", "invalid_token"].includes(
        error.code,
      ))
  );
}

function hasCalendarReadScope(grantedScopes: readonly string[]): boolean {
  return grantedScopes.some(
    (scope) =>
      scope === GOOGLE_CALENDAR_READONLY_SCOPE ||
      scope === "https://www.googleapis.com/auth/calendar",
  );
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 10;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 250);
}

function setDateParam(url: URL, name: string, value: Date | string | undefined): void {
  if (value === undefined) {
    return;
  }
  url.searchParams.set(name, value instanceof Date ? value.toISOString() : value);
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown;
    return objectValue(value) ?? {};
  } catch {
    return {};
  }
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => objectValue(item) !== undefined)
    : [];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredText(value: unknown, message: string): string {
  const text = textValue(value);
  if (text === undefined) {
    throw new GoogleCalendarGatewayError(message, { code: "invalid_calendar_response" });
  }
  return text;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function firstGoogleErrorReason(payload: Record<string, unknown> | undefined): string | undefined {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  for (const error of errors) {
    const reason = textValue(objectValue(error)?.reason);
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
}

function serializeDates<T>(value: T): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeDates(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeDates(item)]),
    );
  }
  return value;
}
