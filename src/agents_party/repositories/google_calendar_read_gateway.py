"""Repository boundary for read-only Google Calendar operations."""

from __future__ import annotations

from datetime import datetime
from typing import Protocol

from agents_party.domain.google_calendar import (
    GoogleCalendarCalendar,
    GoogleCalendarConnection,
    GoogleCalendarEvent,
    GoogleCalendarEventQuery,
)


class GoogleCalendarReadGateway(Protocol):
    """Boundary around read-only Google Calendar data access."""

    async def list_calendars(
        self,
        *,
        connection: GoogleCalendarConnection,
    ) -> list[GoogleCalendarCalendar]:
        """Return calendars visible to the connected Google account.

        Args:
            connection: Stored Google connection identity to use for the read.

        Returns:
            Calendar list entries visible to the user.
        """

        ...

    async def get_event(
        self,
        *,
        connection: GoogleCalendarConnection,
        calendar_id: str,
        event_id: str,
    ) -> GoogleCalendarEvent:
        """Return one event from a connected Google Calendar.

        Args:
            connection: Stored Google connection identity to use for the read.
            calendar_id: Google Calendar id that owns the event.
            event_id: Google Calendar event id to retrieve.

        Returns:
            SDK-free event read model.
        """

        ...

    async def search_events(
        self,
        *,
        connection: GoogleCalendarConnection,
        query: GoogleCalendarEventQuery,
    ) -> list[GoogleCalendarEvent]:
        """Search events on a connected Google Calendar.

        Args:
            connection: Stored Google connection identity to use for the read.
            query: Calendar event search parameters.

        Returns:
            Matching event read models.
        """

        ...

    async def list_upcoming_events(
        self,
        *,
        connection: GoogleCalendarConnection,
        calendar_id: str = "primary",
        limit: int = 10,
        now: datetime | None = None,
    ) -> list[GoogleCalendarEvent]:
        """Return upcoming events from a connected Google Calendar.

        Args:
            connection: Stored Google connection identity to use for the read.
            calendar_id: Google Calendar id to search.
            limit: Maximum number of upcoming events to return.
            now: Optional lower bound timestamp for deterministic tests.

        Returns:
            Upcoming event read models ordered by start time.
        """

        ...


__all__ = ["GoogleCalendarReadGateway"]
