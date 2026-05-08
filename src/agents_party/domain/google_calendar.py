"""SDK-free Google Calendar read models and query values."""

from __future__ import annotations

from datetime import date as Date
from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class GoogleCalendarReconnectReason(StrEnum):
    """Stable reasons that require a user to reconnect Google Calendar."""

    CONNECTION_NOT_FOUND = "connection_not_found"
    CONNECTION_REVOKED = "connection_revoked"
    CONNECTION_EXPIRED = "connection_expired"
    CONNECTION_ERROR = "connection_error"
    MISSING_ACCESS_TOKEN = "missing_access_token"
    MISSING_REFRESH_TOKEN = "missing_refresh_token"
    MISSING_CALENDAR_SCOPE = "missing_calendar_scope"
    TOKEN_DECRYPT_FAILED = "token_decrypt_failed"
    TOKEN_REFRESH_FAILED = "token_refresh_failed"
    API_AUTH_REJECTED = "api_auth_rejected"


class GoogleCalendarReconnectRequiredError(RuntimeError):
    """Raised when Google Calendar reads require a fresh OAuth connection."""

    def __init__(
        self,
        message: str,
        *,
        reason: GoogleCalendarReconnectReason,
        team_id: str,
        slack_user_id: str,
        google_account_subject: str,
    ) -> None:
        """Initialize a reconnect-required Calendar read error.

        Args:
            message: Human-readable failure message.
            reason: Stable machine-readable reconnect reason.
            team_id: Slack workspace id that owns the connection.
            slack_user_id: Slack user id that owns the connection.
            google_account_subject: Stable Google account subject for the connection.

        Returns:
            None.
        """
        super().__init__(message)
        self.reason = reason
        self.team_id = team_id
        self.slack_user_id = slack_user_id
        self.google_account_subject = google_account_subject


class GoogleCalendarConnection(BaseModel):
    """SDK-free reference to a user's stored Google Calendar connection."""

    model_config = ConfigDict(extra="forbid")

    team_id: str
    slack_user_id: str
    google_account_subject: str


class GoogleCalendarCalendar(BaseModel):
    """Calendar list entry returned by the Google Calendar read gateway."""

    model_config = ConfigDict(extra="forbid")

    calendar_id: str
    summary: str | None = None
    description: str | None = None
    time_zone: str | None = None
    primary: bool = False
    access_role: str | None = None


class GoogleCalendarEventTime(BaseModel):
    """Start or end value for a Google Calendar event."""

    model_config = ConfigDict(extra="forbid")

    date: Date | None = None
    date_time: datetime | None = None
    time_zone: str | None = None


class GoogleCalendarEvent(BaseModel):
    """SDK-free read model for a Google Calendar event."""

    model_config = ConfigDict(extra="forbid")

    calendar_id: str
    event_id: str
    status: str | None = None
    summary: str | None = None
    description: str | None = None
    location: str | None = None
    html_link: str | None = None
    start: GoogleCalendarEventTime
    end: GoogleCalendarEventTime
    is_all_day: bool = False
    organizer_email: str | None = None
    creator_email: str | None = None
    updated_at: datetime | None = None
    recurring_event_id: str | None = None


class GoogleCalendarEventQuery(BaseModel):
    """Query parameters for read-only Google Calendar event searches."""

    model_config = ConfigDict(extra="forbid")

    calendar_id: str = "primary"
    text: str | None = None
    time_min: datetime | None = None
    time_max: datetime | None = None
    max_results: int = Field(default=10, ge=1, le=2500)
    single_events: bool = True
    include_deleted: bool = False
    order_by: Literal["startTime", "updated"] | None = None
    time_zone: str | None = None


__all__ = [
    "GoogleCalendarCalendar",
    "GoogleCalendarConnection",
    "GoogleCalendarEvent",
    "GoogleCalendarEventQuery",
    "GoogleCalendarEventTime",
    "GoogleCalendarReconnectReason",
    "GoogleCalendarReconnectRequiredError",
]
