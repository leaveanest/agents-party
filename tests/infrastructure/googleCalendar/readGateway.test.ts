import { describe, expect, it } from "vite-plus/test";

import {
  FetchGoogleCalendarApiClient,
  RepositoryBackedGoogleCalendarReadGateway,
  type GoogleCalendarApiClient,
  type GoogleCalendarConnectionStore,
} from "../../../src/infrastructure/googleCalendar/readGateway.js";
import { FernetTextCipher } from "../../../src/integrations/oauth/fernet.js";
import type { GoogleAuthConnectionDocument } from "../../../src/infrastructure/postgres/appRepositories.js";
import type { JsonObject } from "../../../src/infrastructure/postgres/jsonDocumentRepository.js";
import {
  GoogleCalendarGatewayError,
  GoogleCalendarReconnectRequiredError,
} from "../../../src/repositories/googleCalendar.js";

const fernetKey = "TogY-XNU4lqwqpU3n8ugin31axgCOj0bvbxNnWb9f0w=";

describe("RepositoryBackedGoogleCalendarReadGateway", () => {
  it("lists upcoming events with a decrypted Google OAuth access token", async () => {
    const cipher = new FernetTextCipher(fernetKey);
    const store = new MemoryGoogleConnectionStore([
      googleConnectionPayload({
        accessTokenEncrypted: cipher.encrypt("google-access-token"),
        tokenExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ]);
    const apiClient = new FakeGoogleCalendarApiClient();
    const gateway = new RepositoryBackedGoogleCalendarReadGateway({
      apiClient,
      connectionStore: store,
      now: () => new Date("2026-05-11T00:00:00.000Z"),
      tokenCipher: cipher,
    });

    const events = await gateway.listUpcomingEvents(
      { slackUserId: "U123", teamId: "T123" },
      { calendarId: "primary", limit: 5 },
    );

    expect(apiClient.lastListEventsInput).toMatchObject({
      accessToken: "google-access-token",
      calendarId: "primary",
      limit: 5,
    });
    expect(events).toEqual([
      {
        attendees: [],
        calendarId: "primary",
        end: { dateTime: "2026-05-11T10:30:00Z" },
        eventId: "evt-1",
        htmlLink: "https://calendar.google.com/event?eid=evt-1",
        isAllDay: false,
        organizerEmail: "organizer@example.com",
        start: { dateTime: "2026-05-11T10:00:00Z" },
        status: "confirmed",
        summary: "Planning",
      },
    ]);
    expect(store.saved.at(-1)?.payload).toMatchObject({
      connection_status: "active",
      last_successful_access_at: "2026-05-11T00:00:00.000Z",
    });
  });

  it("returns deterministic reconnect guidance when no Google connection exists", async () => {
    const gateway = new RepositoryBackedGoogleCalendarReadGateway({
      apiClient: new FakeGoogleCalendarApiClient(),
      connectionStore: new MemoryGoogleConnectionStore([]),
      tokenCipher: new FernetTextCipher(fernetKey),
    });

    await expect(gateway.listCalendars({ slackUserId: "U123", teamId: "T123" })).rejects.toThrow(
      GoogleCalendarReconnectRequiredError,
    );
    await expect(
      gateway.listCalendars({ slackUserId: "U123", teamId: "T123" }),
    ).rejects.toMatchObject({
      guidance: "Reconnect Google Calendar from the app before using calendar features.",
      reason: "missing_connection",
    });
  });

  it("marks expired access tokens and asks the user to reconnect", async () => {
    const cipher = new FernetTextCipher(fernetKey);
    const store = new MemoryGoogleConnectionStore([
      googleConnectionPayload({
        accessTokenEncrypted: cipher.encrypt("expired-token"),
        tokenExpiresAt: "2026-05-10T23:59:00.000Z",
      }),
    ]);
    const gateway = new RepositoryBackedGoogleCalendarReadGateway({
      apiClient: new FakeGoogleCalendarApiClient(),
      connectionStore: store,
      now: () => new Date("2026-05-11T00:00:00.000Z"),
      tokenCipher: cipher,
    });

    await expect(
      gateway.listCalendars({ slackUserId: "U123", teamId: "T123" }),
    ).rejects.toMatchObject({
      reason: "expired_connection",
    });
    expect(store.saved.at(-1)?.payload).toMatchObject({
      connection_status: "expired",
      last_refresh_error_code: "access_token_expired",
    });
  });

  it("maps Google authorization failures to reconnect-required errors", async () => {
    const cipher = new FernetTextCipher(fernetKey);
    const store = new MemoryGoogleConnectionStore([
      googleConnectionPayload({
        accessTokenEncrypted: cipher.encrypt("revoked-token"),
        tokenExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ]);
    const apiClient = new FakeGoogleCalendarApiClient({
      error: new GoogleCalendarGatewayError("Invalid credentials.", {
        code: "UNAUTHENTICATED",
        statusCode: 401,
      }),
    });
    const gateway = new RepositoryBackedGoogleCalendarReadGateway({
      apiClient,
      connectionStore: store,
      now: () => new Date("2026-05-11T00:00:00.000Z"),
      tokenCipher: cipher,
    });

    await expect(
      gateway.listCalendars({ slackUserId: "U123", teamId: "T123" }),
    ).rejects.toMatchObject({
      reason: "revoked_or_unauthorized",
    });
    expect(store.saved.at(-1)?.payload).toMatchObject({
      connection_status: "expired",
      last_refresh_error_code: "UNAUTHENTICATED",
    });
  });

  it("requires the stored Google connection to include Calendar read scope", async () => {
    const cipher = new FernetTextCipher(fernetKey);
    const store = new MemoryGoogleConnectionStore([
      googleConnectionPayload({
        accessTokenEncrypted: cipher.encrypt("profile-only-token"),
        grantedScopes: ["openid", "email", "profile"],
        tokenExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ]);
    const gateway = new RepositoryBackedGoogleCalendarReadGateway({
      apiClient: new FakeGoogleCalendarApiClient(),
      connectionStore: store,
      now: () => new Date("2026-05-11T00:00:00.000Z"),
      tokenCipher: cipher,
    });

    await expect(
      gateway.listCalendars({ slackUserId: "U123", teamId: "T123" }),
    ).rejects.toMatchObject({
      reason: "revoked_or_unauthorized",
    });
    expect(store.saved.at(-1)?.payload).toMatchObject({
      connection_status: "expired",
      last_refresh_error_code: "missing_calendar_readonly_scope",
    });
  });

  it("keeps non-token 403 errors as gateway errors without expiring the connection", async () => {
    const cipher = new FernetTextCipher(fernetKey);
    const store = new MemoryGoogleConnectionStore([
      googleConnectionPayload({
        accessTokenEncrypted: cipher.encrypt("valid-token"),
        tokenExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ]);
    const apiClient = new FakeGoogleCalendarApiClient({
      error: new GoogleCalendarGatewayError("Calendar ACL denied.", {
        code: "forbiddenForNonOrganizer",
        statusCode: 403,
      }),
    });
    const gateway = new RepositoryBackedGoogleCalendarReadGateway({
      apiClient,
      connectionStore: store,
      now: () => new Date("2026-05-11T00:00:00.000Z"),
      tokenCipher: cipher,
    });

    await expect(gateway.listCalendars({ slackUserId: "U123", teamId: "T123" })).rejects.toThrow(
      GoogleCalendarGatewayError,
    );
    expect(store.saved).toEqual([]);
  });

  it("reports malformed stored connections through the broken-connection reconnect path", async () => {
    const gateway = new RepositoryBackedGoogleCalendarReadGateway({
      apiClient: new FakeGoogleCalendarApiClient(),
      connectionStore: new MemoryGoogleConnectionStore([
        {
          connection_status: "active",
          slack_user_id: "U123",
          team_id: "T123",
        },
      ]),
      tokenCipher: new FernetTextCipher(fernetKey),
    });

    await expect(
      gateway.listCalendars({ slackUserId: "U123", teamId: "T123" }),
    ).rejects.toMatchObject({
      reason: "broken_connection",
    });
  });
});

describe("FetchGoogleCalendarApiClient", () => {
  it("keeps Google Calendar REST details inside the infrastructure client", async () => {
    const requests: Array<{ init?: RequestInit; url: string }> = [];
    const client = new FetchGoogleCalendarApiClient({
      fetchFn: async (input, init) => {
        requests.push({ init, url: String(input) });
        return new Response(
          JSON.stringify({
            items: [
              {
                end: { date: "2026-05-12" },
                id: "all-day",
                start: { date: "2026-05-11" },
                summary: "Offsite",
              },
            ],
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      },
    });

    const events = await client.listEvents({
      accessToken: "token",
      calendarId: "primary",
      limit: 3,
      query: "offsite",
      timeMin: new Date("2026-05-11T00:00:00.000Z"),
    });

    expect(requests[0]?.url).toContain("/calendar/v3/calendars/primary/events");
    expect(requests[0]?.url).toContain("maxResults=3");
    expect(requests[0]?.url).toContain("q=offsite");
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: "Bearer token",
    });
    expect(events[0]).toMatchObject({
      calendarId: "primary",
      eventId: "all-day",
      isAllDay: true,
      summary: "Offsite",
    });
  });
});

class FakeGoogleCalendarApiClient implements GoogleCalendarApiClient {
  lastListEventsInput:
    | {
        accessToken: string;
        calendarId: string;
        limit: number;
        query?: string;
        timeMax?: Date | string;
        timeMin?: Date | string;
      }
    | undefined;

  constructor(private readonly options: { error?: Error } = {}) {}

  async getEvent(): Promise<never> {
    throw new Error("not implemented");
  }

  async listCalendars() {
    if (this.options.error !== undefined) {
      throw this.options.error;
    }
    return [{ id: "primary", primary: true, summary: "Primary" }];
  }

  async listEvents(input: {
    accessToken: string;
    calendarId: string;
    limit: number;
    query?: string;
    timeMax?: Date | string;
    timeMin?: Date | string;
  }) {
    if (this.options.error !== undefined) {
      throw this.options.error;
    }
    this.lastListEventsInput = input;
    return [
      {
        attendees: [],
        calendarId: input.calendarId,
        end: { dateTime: "2026-05-11T10:30:00Z" },
        eventId: "evt-1",
        htmlLink: "https://calendar.google.com/event?eid=evt-1",
        isAllDay: false,
        organizerEmail: "organizer@example.com",
        start: { dateTime: "2026-05-11T10:00:00Z" },
        status: "confirmed",
        summary: "Planning",
      },
    ];
  }
}

class MemoryGoogleConnectionStore implements GoogleCalendarConnectionStore {
  readonly saved: GoogleAuthConnectionDocument[] = [];

  constructor(private readonly connections: JsonObject[]) {}

  async listGoogleConnections(teamId: string, slackUserId?: string): Promise<JsonObject[]> {
    return this.connections.filter(
      (connection) =>
        connection.team_id === teamId &&
        (slackUserId === undefined || connection.slack_user_id === slackUserId),
    );
  }

  async saveGoogleConnection(document: GoogleAuthConnectionDocument): Promise<void> {
    this.saved.push(document);
  }
}

function googleConnectionPayload(input: {
  accessTokenEncrypted: string;
  connectionStatus?: string;
  grantedScopes?: string[];
  tokenExpiresAt?: string;
}): JsonObject {
  return {
    access_token_encrypted: input.accessTokenEncrypted,
    connection_status: input.connectionStatus ?? "active",
    created_at: "2026-05-01T00:00:00.000Z",
    google_account_email: "user@example.com",
    google_account_email_verified: true,
    google_account_subject: "google-subject",
    granted_scopes: input.grantedScopes ?? ["https://www.googleapis.com/auth/calendar.readonly"],
    last_refresh_error_at: null,
    last_refresh_error_code: null,
    last_refreshed_at: null,
    last_successful_access_at: null,
    refresh_token_encrypted: null,
    refresh_token_expires_at: null,
    slack_user_id: "U123",
    team_id: "T123",
    token_expires_at: input.tokenExpiresAt ?? "2099-01-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
  };
}
