"""HTTP-backed Google Calendar read gateway implementation."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from datetime import UTC, date as Date
from datetime import datetime, timedelta
from typing import Any, NoReturn, Protocol, cast
from urllib.parse import quote

import httpx
from pydantic import ValidationError

from agents_party.domain.google_auth import (
    GoogleAuthConnectionDocument,
    GoogleConnectionStatus,
)
from agents_party.domain.google_calendar import (
    GoogleCalendarCalendar,
    GoogleCalendarConnection,
    GoogleCalendarEvent,
    GoogleCalendarEventQuery,
    GoogleCalendarEventTime,
    GoogleCalendarReconnectReason,
    GoogleCalendarReconnectRequiredError,
)
from agents_party.domain.slack_documents import utc_now
from agents_party.infrastructure.google_auth import (
    GoogleOAuthGatewayError,
    TokenCipherError,
)
from agents_party.repositories.google_auth_connection_repository import (
    GoogleAuthConnectionRepository,
)
from agents_party.repositories.google_oauth_gateway import GoogleOAuthGateway


_CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
_REFRESH_SKEW = timedelta(minutes=5)


class GoogleCalendarGatewayError(RuntimeError):
    """Raised when a Google Calendar API read fails without requiring reconnect."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        error_code: str | None = None,
        retriable: bool = False,
    ) -> None:
        """Initialize a Google Calendar gateway error.

        Args:
            message: Human-readable failure message.
            status_code: Optional HTTP status code returned by Google Calendar.
            error_code: Optional machine-readable error code.
            retriable: Whether retrying the same operation may succeed.

        Returns:
            None.
        """
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code
        self.retriable = retriable


class TokenCipherProtocol(Protocol):
    """Protocol for encrypting and decrypting stored OAuth tokens."""

    def encrypt(self, value: str) -> str:
        """Encrypt a plaintext token string.

        Args:
            value: Plaintext token to encrypt.

        Returns:
            Encrypted token string.
        """

        ...

    def decrypt(self, value: str) -> str:
        """Decrypt an encrypted token string.

        Args:
            value: Encrypted token string to decrypt.

        Returns:
            Decrypted token string.
        """

        ...


class HttpxGoogleCalendarReadGateway:
    """Read Google Calendar data through REST using stored OAuth connections."""

    _BASE_URL = "https://www.googleapis.com/calendar/v3"

    def __init__(
        self,
        *,
        connection_repository: GoogleAuthConnectionRepository,
        oauth_gateway: GoogleOAuthGateway,
        token_cipher: TokenCipherProtocol,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        """Initialize the Google Calendar read gateway.

        Args:
            connection_repository: Repository for stored Google OAuth connections.
            oauth_gateway: OAuth gateway used to refresh access tokens.
            token_cipher: Token encryption helper for stored OAuth tokens.
            http_client: Optional injected HTTPX client for tests.

        Returns:
            None.
        """
        self._connection_repository = connection_repository
        self._oauth_gateway = oauth_gateway
        self._token_cipher = token_cipher
        self._http_client = http_client or httpx.AsyncClient(timeout=10.0)

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
        calendars: list[GoogleCalendarCalendar] = []
        page_token: str | None = None
        while True:
            params = {"pageToken": page_token} if page_token is not None else {}
            payload = await self._request_json(
                connection=connection,
                method_path="/users/me/calendarList",
                params=params,
            )
            items = payload.get("items", [])
            if not isinstance(items, list):
                raise GoogleCalendarGatewayError(
                    "Google Calendar calendarList response was invalid",
                    error_code="invalid_calendar_list_response",
                )
            calendars.extend(
                self._parse_calendar(item) for item in items if isinstance(item, dict)
            )
            raw_page_token = payload.get("nextPageToken")
            page_token = raw_page_token if isinstance(raw_page_token, str) else None
            if page_token is None:
                break
        return calendars

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
        payload = await self._request_json(
            connection=connection,
            method_path=(
                f"/calendars/{quote(calendar_id, safe='')}"
                f"/events/{quote(event_id, safe='')}"
            ),
            params={},
        )
        return self._parse_event(calendar_id=calendar_id, payload=payload)

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
        return await self._list_events(connection=connection, query=query)

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
        query = GoogleCalendarEventQuery(
            calendar_id=calendar_id,
            time_min=now or utc_now(),
            max_results=limit,
            single_events=True,
            include_deleted=False,
            order_by="startTime",
        )
        return await self._list_events(connection=connection, query=query)

    async def aclose(self) -> None:
        """Close the owned HTTP client and release network resources.

        Returns:
            None.
        """
        await self._http_client.aclose()

    async def _list_events(
        self,
        *,
        connection: GoogleCalendarConnection,
        query: GoogleCalendarEventQuery,
    ) -> list[GoogleCalendarEvent]:
        """List Calendar events with pagination.

        Args:
            connection: Stored Google connection identity to use for the read.
            query: Calendar event query parameters.

        Returns:
            Event read models up to the requested limit.
        """
        events: list[GoogleCalendarEvent] = []
        page_token: str | None = None
        while len(events) < query.max_results:
            remaining = query.max_results - len(events)
            params = self._build_event_query_params(
                query=query,
                page_token=page_token,
                page_size=min(remaining, 2500),
            )
            payload = await self._request_json(
                connection=connection,
                method_path=f"/calendars/{quote(query.calendar_id, safe='')}/events",
                params=params,
            )
            items = payload.get("items", [])
            if not isinstance(items, list):
                raise GoogleCalendarGatewayError(
                    "Google Calendar events response was invalid",
                    error_code="invalid_events_response",
                )
            events.extend(
                self._parse_event(calendar_id=query.calendar_id, payload=item)
                for item in items
                if isinstance(item, dict)
            )
            raw_page_token = payload.get("nextPageToken")
            page_token = raw_page_token if isinstance(raw_page_token, str) else None
            if page_token is None:
                break
        return events[: query.max_results]

    async def _request_json(
        self,
        *,
        connection: GoogleCalendarConnection,
        method_path: str,
        params: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        """Execute an authenticated Calendar GET request and parse JSON.

        Args:
            connection: Stored Google connection identity to use for the read.
            method_path: Calendar API path below the base URL.
            params: Query parameters for the GET request.

        Returns:
            Decoded JSON mapping response.

        Raises:
            GoogleCalendarReconnectRequiredError: If the user must reconnect.
            GoogleCalendarGatewayError: If the request or response fails otherwise.
        """
        access_token = await self._get_access_token(connection=connection)
        response = await self._get(
            method_path=method_path,
            access_token=access_token,
            params=params,
        )
        if response.status_code == 401:
            access_token = await self._refresh_access_token(
                connection=connection,
                reason=GoogleCalendarReconnectReason.API_AUTH_REJECTED,
            )
            response = await self._get(
                method_path=method_path,
                access_token=access_token,
                params=params,
            )
            if response.status_code == 401:
                await self._mark_connection_status(
                    connection=connection,
                    status=GoogleConnectionStatus.EXPIRED,
                    error_code="api_auth_rejected",
                )
                self._raise_reconnect(
                    connection=connection,
                    reason=GoogleCalendarReconnectReason.API_AUTH_REJECTED,
                    message="Google Calendar rejected the stored OAuth token",
                )

        if not response.is_success:
            payload = self._safe_json(response)
            raise GoogleCalendarGatewayError(
                "Google Calendar request failed",
                status_code=response.status_code,
                error_code=self._extract_error_code(payload),
                retriable=response.status_code >= 500,
            )

        payload = self._safe_json(response)
        if not payload:
            raise GoogleCalendarGatewayError(
                "Google Calendar response was not valid JSON",
                status_code=response.status_code,
                error_code="invalid_json_response",
            )
        await self._record_success(connection=connection)
        return payload

    async def _get_access_token(
        self,
        *,
        connection: GoogleCalendarConnection,
    ) -> str:
        """Load and decrypt a usable access token for a Calendar read.

        Args:
            connection: Stored Google connection identity to use for the read.

        Returns:
            Plaintext OAuth access token.
        """
        document = await self._require_active_connection(connection=connection)
        if self._should_refresh(document):
            return await self._refresh_access_token(
                connection=connection,
                reason=GoogleCalendarReconnectReason.TOKEN_REFRESH_FAILED,
            )
        if document.access_token_encrypted is None:
            if document.refresh_token_encrypted is not None:
                return await self._refresh_access_token(
                    connection=connection,
                    reason=GoogleCalendarReconnectReason.MISSING_ACCESS_TOKEN,
                )
            self._raise_reconnect(
                connection=connection,
                reason=GoogleCalendarReconnectReason.MISSING_ACCESS_TOKEN,
                message="Google OAuth connection does not have an access token",
            )
        try:
            return self._token_cipher.decrypt(document.access_token_encrypted)
        except TokenCipherError:
            await self._mark_connection_status(
                connection=connection,
                status=GoogleConnectionStatus.ERROR,
                error_code="token_decrypt_failed",
            )
            self._raise_reconnect(
                connection=connection,
                reason=GoogleCalendarReconnectReason.TOKEN_DECRYPT_FAILED,
                message="Google OAuth access token could not be decrypted",
            )

    async def _refresh_access_token(
        self,
        *,
        connection: GoogleCalendarConnection,
        reason: GoogleCalendarReconnectReason,
    ) -> str:
        """Refresh a stored OAuth access token and persist the result.

        Args:
            connection: Stored Google connection identity to refresh.
            reason: Reconnect reason to use if refresh cannot produce a token.

        Returns:
            New plaintext access token.
        """
        document = await self._require_active_connection(connection=connection)
        if document.refresh_token_encrypted is None:
            await self._mark_connection_status(
                connection=connection,
                status=GoogleConnectionStatus.EXPIRED,
                error_code="missing_refresh_token",
            )
            self._raise_reconnect(
                connection=connection,
                reason=GoogleCalendarReconnectReason.MISSING_REFRESH_TOKEN,
                message="Google OAuth connection does not have a refresh token",
            )
        try:
            refresh_token = self._token_cipher.decrypt(document.refresh_token_encrypted)
        except TokenCipherError:
            await self._mark_connection_status(
                connection=connection,
                status=GoogleConnectionStatus.ERROR,
                error_code="token_decrypt_failed",
            )
            self._raise_reconnect(
                connection=connection,
                reason=GoogleCalendarReconnectReason.TOKEN_DECRYPT_FAILED,
                message="Google OAuth refresh token could not be decrypted",
            )

        try:
            tokens = await self._oauth_gateway.refresh_access_token(
                refresh_token=refresh_token
            )
        except GoogleOAuthGatewayError as exc:
            now = utc_now()
            status = (
                GoogleConnectionStatus.EXPIRED
                if exc.error_code == "invalid_grant"
                else GoogleConnectionStatus.ACTIVE
            )
            updated_connection = document.model_copy(
                update={
                    "connection_status": status,
                    "last_refresh_error_at": now,
                    "last_refresh_error_code": exc.error_code or "refresh_failed",
                    "updated_at": now,
                }
            )
            await self._upsert_connection(connection=updated_connection)
            if status == GoogleConnectionStatus.EXPIRED:
                self._raise_reconnect(
                    connection=connection,
                    reason=GoogleCalendarReconnectReason.TOKEN_REFRESH_FAILED,
                    message="Google OAuth refresh token is no longer valid",
                )
            raise GoogleCalendarGatewayError(
                "Google OAuth token refresh failed",
                error_code=exc.error_code or "refresh_failed",
                retriable=exc.retriable,
            ) from exc

        try:
            access_token_encrypted = self._token_cipher.encrypt(tokens.access_token)
            refresh_token_encrypted = document.refresh_token_encrypted
            if tokens.refresh_token:
                refresh_token_encrypted = self._token_cipher.encrypt(
                    tokens.refresh_token
                )
        except TokenCipherError:
            await self._mark_connection_status(
                connection=connection,
                status=GoogleConnectionStatus.ERROR,
                error_code="token_encrypt_failed",
            )
            self._raise_reconnect(
                connection=connection,
                reason=reason,
                message="Google OAuth refreshed token could not be stored",
            )

        now = utc_now()
        updated_connection = document.model_copy(
            update={
                "granted_scopes": tokens.granted_scopes or document.granted_scopes,
                "connection_status": GoogleConnectionStatus.ACTIVE,
                "access_token_encrypted": access_token_encrypted,
                "refresh_token_encrypted": refresh_token_encrypted,
                "token_expires_at": tokens.expires_at,
                "refresh_token_expires_at": (
                    tokens.refresh_token_expires_at
                    if tokens.refresh_token_expires_at is not None
                    else document.refresh_token_expires_at
                ),
                "last_refreshed_at": now,
                "last_refresh_error_at": None,
                "last_refresh_error_code": None,
                "last_successful_access_at": now,
                "updated_at": now,
            }
        )
        await self._upsert_connection(connection=updated_connection)
        return tokens.access_token

    async def _require_active_connection(
        self,
        *,
        connection: GoogleCalendarConnection,
    ) -> GoogleAuthConnectionDocument:
        """Load a stored active OAuth connection or raise reconnect-required.

        Args:
            connection: Stored Google connection identity to load.

        Returns:
            Active stored Google OAuth connection.
        """
        document = await self._get_connection(connection=connection)
        if document is None:
            self._raise_reconnect(
                connection=connection,
                reason=GoogleCalendarReconnectReason.CONNECTION_NOT_FOUND,
                message="Google OAuth connection was not found",
            )
        if document.connection_status == GoogleConnectionStatus.REVOKED:
            self._raise_reconnect(
                connection=connection,
                reason=GoogleCalendarReconnectReason.CONNECTION_REVOKED,
                message="Google OAuth connection was revoked",
            )
        if document.connection_status == GoogleConnectionStatus.EXPIRED:
            self._raise_reconnect(
                connection=connection,
                reason=GoogleCalendarReconnectReason.CONNECTION_EXPIRED,
                message="Google OAuth connection is expired",
            )
        if document.connection_status == GoogleConnectionStatus.ERROR:
            self._raise_reconnect(
                connection=connection,
                reason=GoogleCalendarReconnectReason.CONNECTION_ERROR,
                message="Google OAuth connection is in an error state",
            )
        if (
            document.granted_scopes
            and _CALENDAR_READONLY_SCOPE not in document.granted_scopes
        ):
            self._raise_reconnect(
                connection=connection,
                reason=GoogleCalendarReconnectReason.MISSING_CALENDAR_SCOPE,
                message="Google OAuth connection is missing Calendar read scope",
            )
        return document

    async def _get(
        self,
        *,
        method_path: str,
        access_token: str,
        params: Mapping[str, Any],
    ) -> httpx.Response:
        """Execute a Google Calendar API GET request.

        Args:
            method_path: Calendar API path below the base URL.
            access_token: Plaintext OAuth access token.
            params: Query parameters for the GET request.

        Returns:
            HTTPX response returned by Google Calendar.
        """
        try:
            return await self._http_client.get(
                f"{self._BASE_URL}{method_path}",
                params=params,
                headers={"Authorization": f"Bearer {access_token}"},
            )
        except httpx.HTTPError as exc:
            raise GoogleCalendarGatewayError(
                "Google Calendar request failed",
                error_code="transport_error",
                retriable=True,
            ) from exc

    async def _get_connection(
        self,
        *,
        connection: GoogleCalendarConnection,
    ) -> GoogleAuthConnectionDocument | None:
        """Load a stored Google OAuth connection without blocking the loop.

        Args:
            connection: Stored Google connection identity to load.

        Returns:
            Stored connection document, or `None` when absent.
        """
        return await asyncio.to_thread(
            self._connection_repository.get_connection,
            team_id=connection.team_id,
            slack_user_id=connection.slack_user_id,
            google_account_subject=connection.google_account_subject,
        )

    async def _upsert_connection(
        self,
        *,
        connection: GoogleAuthConnectionDocument,
    ) -> GoogleAuthConnectionDocument:
        """Persist a Google OAuth connection without blocking the loop.

        Args:
            connection: Connection document to persist.

        Returns:
            Persisted connection document.
        """
        return await asyncio.to_thread(
            self._connection_repository.upsert_connection,
            connection=connection,
        )

    async def _record_success(
        self,
        *,
        connection: GoogleCalendarConnection,
    ) -> None:
        """Update the connection's last successful Calendar access timestamp.

        Args:
            connection: Stored Google connection identity to update.

        Returns:
            None.
        """
        document = await self._get_connection(connection=connection)
        if document is None:
            return
        now = utc_now()
        await self._upsert_connection(
            connection=document.model_copy(
                update={"last_successful_access_at": now, "updated_at": now}
            )
        )

    async def _mark_connection_status(
        self,
        *,
        connection: GoogleCalendarConnection,
        status: GoogleConnectionStatus,
        error_code: str,
    ) -> None:
        """Persist a connection status and refresh error code.

        Args:
            connection: Stored Google connection identity to update.
            status: New connection status.
            error_code: Stable failure code to record.

        Returns:
            None.
        """
        document = await self._get_connection(connection=connection)
        if document is None:
            return
        now = utc_now()
        await self._upsert_connection(
            connection=document.model_copy(
                update={
                    "connection_status": status,
                    "last_refresh_error_at": now,
                    "last_refresh_error_code": error_code,
                    "updated_at": now,
                }
            )
        )

    def _should_refresh(self, document: GoogleAuthConnectionDocument) -> bool:
        """Return whether a stored access token should be refreshed first.

        Args:
            document: Stored Google OAuth connection.

        Returns:
            `True` when the access token is missing or close to expiry.
        """
        if document.access_token_encrypted is None:
            return True
        if document.token_expires_at is None:
            return False
        expires_at = document.token_expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        return utc_now() + _REFRESH_SKEW >= expires_at.astimezone(UTC)

    def _build_event_query_params(
        self,
        *,
        query: GoogleCalendarEventQuery,
        page_token: str | None,
        page_size: int,
    ) -> dict[str, str]:
        """Convert an event query model into Google Calendar API parameters.

        Args:
            query: Event query model to convert.
            page_token: Optional Google pagination token.
            page_size: Maximum events to request for this page.

        Returns:
            Query parameter mapping for the Calendar events endpoint.
        """
        params: dict[str, str] = {
            "maxResults": str(page_size),
            "singleEvents": self._format_bool(query.single_events),
            "showDeleted": self._format_bool(query.include_deleted),
        }
        if query.text:
            params["q"] = query.text
        if query.time_min is not None:
            params["timeMin"] = self._format_datetime(query.time_min)
        if query.time_max is not None:
            params["timeMax"] = self._format_datetime(query.time_max)
        if query.order_by is not None:
            params["orderBy"] = query.order_by
        if query.time_zone is not None:
            params["timeZone"] = query.time_zone
        if page_token is not None:
            params["pageToken"] = page_token
        return params

    def _parse_calendar(self, payload: Mapping[str, Any]) -> GoogleCalendarCalendar:
        """Parse a Calendar API calendar-list item.

        Args:
            payload: Raw calendar-list item returned by Google Calendar.

        Returns:
            SDK-free Calendar read model.
        """
        calendar_id = payload.get("id")
        if not isinstance(calendar_id, str) or not calendar_id:
            raise GoogleCalendarGatewayError(
                "Google Calendar list item did not include an id",
                error_code="invalid_calendar_item",
            )
        try:
            return GoogleCalendarCalendar(
                calendar_id=calendar_id,
                summary=self._optional_str(payload.get("summary")),
                description=self._optional_str(payload.get("description")),
                time_zone=self._optional_str(payload.get("timeZone")),
                primary=bool(payload.get("primary", False)),
                access_role=self._optional_str(payload.get("accessRole")),
            )
        except ValidationError as exc:
            raise GoogleCalendarGatewayError(
                "Google Calendar list item could not be parsed",
                error_code="invalid_calendar_item",
            ) from exc

    def _parse_event(
        self,
        *,
        calendar_id: str,
        payload: Mapping[str, Any],
    ) -> GoogleCalendarEvent:
        """Parse a Calendar API event item.

        Args:
            calendar_id: Calendar id that owns the event.
            payload: Raw event item returned by Google Calendar.

        Returns:
            SDK-free event read model.
        """
        event_id = payload.get("id")
        if not isinstance(event_id, str) or not event_id:
            raise GoogleCalendarGatewayError(
                "Google Calendar event did not include an id",
                error_code="invalid_event_item",
            )
        start = self._parse_event_time(payload.get("start"))
        end = self._parse_event_time(payload.get("end"))
        try:
            return GoogleCalendarEvent(
                calendar_id=calendar_id,
                event_id=event_id,
                status=self._optional_str(payload.get("status")),
                summary=self._optional_str(payload.get("summary")),
                description=self._optional_str(payload.get("description")),
                location=self._optional_str(payload.get("location")),
                html_link=self._optional_str(payload.get("htmlLink")),
                start=start,
                end=end,
                is_all_day=start.date is not None and start.date_time is None,
                organizer_email=self._email_from_nested(payload.get("organizer")),
                creator_email=self._email_from_nested(payload.get("creator")),
                updated_at=self._parse_optional_datetime(payload.get("updated")),
                recurring_event_id=self._optional_str(payload.get("recurringEventId")),
            )
        except ValidationError as exc:
            raise GoogleCalendarGatewayError(
                "Google Calendar event could not be parsed",
                error_code="invalid_event_item",
            ) from exc

    def _parse_event_time(self, value: Any) -> GoogleCalendarEventTime:
        """Parse a Calendar event start or end payload.

        Args:
            value: Raw event time object returned by Google Calendar.

        Returns:
            SDK-free event time value.
        """
        if not isinstance(value, Mapping):
            raise GoogleCalendarGatewayError(
                "Google Calendar event time was invalid",
                error_code="invalid_event_time",
            )
        raw_date = value.get("date")
        raw_date_time = value.get("dateTime")
        parsed_date = (
            Date.fromisoformat(raw_date) if isinstance(raw_date, str) else None
        )
        parsed_date_time = self._parse_optional_datetime(raw_date_time)
        return GoogleCalendarEventTime(
            date=parsed_date,
            date_time=parsed_date_time,
            time_zone=self._optional_str(value.get("timeZone")),
        )

    def _parse_optional_datetime(self, value: Any) -> datetime | None:
        """Parse an optional RFC3339 datetime string.

        Args:
            value: Raw datetime string returned by Google Calendar.

        Returns:
            Parsed datetime, or `None` when absent.
        """
        if not isinstance(value, str) or not value:
            return None
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)

    def _safe_json(self, response: httpx.Response) -> Mapping[str, Any]:
        """Return a JSON mapping response payload when possible.

        Args:
            response: HTTPX response received from Google Calendar.

        Returns:
            JSON mapping payload, or an empty mapping when parsing fails.
        """
        try:
            payload = response.json()
        except ValueError:
            return {}
        return cast(Mapping[str, Any], payload) if isinstance(payload, dict) else {}

    def _extract_error_code(self, payload: Mapping[str, Any]) -> str | None:
        """Extract a Google Calendar error code from a response payload.

        Args:
            payload: Raw Calendar error response.

        Returns:
            Error reason or code when present.
        """
        error = payload.get("error")
        if isinstance(error, Mapping):
            errors = error.get("errors")
            if isinstance(errors, list):
                for item in errors:
                    if isinstance(item, Mapping) and isinstance(
                        item.get("reason"), str
                    ):
                        return str(item["reason"])
            code = error.get("code")
            if isinstance(code, str | int):
                return str(code)
        return None

    def _email_from_nested(self, value: Any) -> str | None:
        """Extract an email field from a nested Calendar event object.

        Args:
            value: Nested event object such as `organizer` or `creator`.

        Returns:
            Email string when present.
        """
        if not isinstance(value, Mapping):
            return None
        return self._optional_str(value.get("email"))

    def _optional_str(self, value: Any) -> str | None:
        """Return a string value only when the raw value is a string.

        Args:
            value: Raw value from a Google Calendar JSON payload.

        Returns:
            String value, or `None`.
        """
        return value if isinstance(value, str) else None

    def _format_datetime(self, value: datetime) -> str:
        """Format a datetime for Google Calendar query parameters.

        Args:
            value: Datetime value to format.

        Returns:
            ISO-8601/RFC3339-compatible timestamp string.
        """
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")

    def _format_bool(self, value: bool) -> str:
        """Format a boolean for Google Calendar query parameters.

        Args:
            value: Boolean value to format.

        Returns:
            Lowercase JSON-style boolean string.
        """
        return "true" if value else "false"

    def _raise_reconnect(
        self,
        *,
        connection: GoogleCalendarConnection,
        reason: GoogleCalendarReconnectReason,
        message: str,
    ) -> NoReturn:
        """Raise a stable reconnect-required error for a Calendar operation.

        Args:
            connection: Stored Google connection identity involved in the failure.
            reason: Stable reconnect reason.
            message: Human-readable failure message.

        Raises:
            GoogleCalendarReconnectRequiredError: Always raised.
        """
        raise GoogleCalendarReconnectRequiredError(
            message,
            reason=reason,
            team_id=connection.team_id,
            slack_user_id=connection.slack_user_id,
            google_account_subject=connection.google_account_subject,
        )


__all__ = ["GoogleCalendarGatewayError", "HttpxGoogleCalendarReadGateway"]
