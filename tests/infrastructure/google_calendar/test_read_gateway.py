"""Tests for the HTTP-backed Google Calendar read gateway."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
import httpx
import pytest

from agents_party.domain.google_auth import (
    GoogleAuthConnectionDocument,
    GoogleConnectionStatus,
    GoogleIdentityClaims,
    GoogleOAuthTokens,
)
from agents_party.domain.google_calendar import (
    GoogleCalendarConnection,
    GoogleCalendarEventQuery,
    GoogleCalendarReconnectReason,
    GoogleCalendarReconnectRequiredError,
)
from agents_party.domain.slack_documents import utc_now
from agents_party.infrastructure.google_auth import (
    GoogleOAuthGatewayError,
    TokenCipherError,
)
from agents_party.infrastructure.google_calendar import HttpxGoogleCalendarReadGateway


class InMemoryGoogleAuthConnectionRepository:
    """In-memory Google OAuth connection repository for Calendar tests."""

    def __init__(self) -> None:
        """Initialize the in-memory connection store.

        Returns:
            None.
        """
        self.documents: dict[tuple[str, str, str], GoogleAuthConnectionDocument] = {}

    def get_connection(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        google_account_subject: str,
    ) -> GoogleAuthConnectionDocument | None:
        """Return a stored Google OAuth connection document.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            google_account_subject: Stable Google `sub` value for the account.

        Returns:
            Stored connection document, or `None` when absent.
        """
        return self.documents.get((team_id, slack_user_id, google_account_subject))

    def list_connections(
        self,
        *,
        team_id: str,
        slack_user_id: str,
    ) -> list[GoogleAuthConnectionDocument]:
        """Return all stored Google OAuth connections for a Slack user.

        Args:
            team_id: Slack workspace id owning the connections.
            slack_user_id: Slack user id whose connections should be listed.

        Returns:
            Stored connection documents.
        """
        return [
            document
            for (document_team_id, document_slack_user_id, _subject), document in (
                self.documents.items()
            )
            if document_team_id == team_id and document_slack_user_id == slack_user_id
        ]

    def upsert_connection(
        self,
        *,
        connection: GoogleAuthConnectionDocument,
    ) -> GoogleAuthConnectionDocument:
        """Persist a Google OAuth connection document.

        Args:
            connection: Connection document to store.

        Returns:
            Stored connection document.
        """
        self.documents[
            (
                connection.team_id,
                connection.slack_user_id,
                connection.google_account_subject,
            )
        ] = connection
        return connection


class PlaintextTokenCipher:
    """Deterministic reversible token cipher for Calendar tests."""

    def encrypt(self, value: str) -> str:
        """Return a fake encrypted token.

        Args:
            value: Plaintext token to encode.

        Returns:
            Encoded token value.
        """
        return f"enc:{value}"

    def decrypt(self, value: str) -> str:
        """Decode a fake encrypted token.

        Args:
            value: Encoded token value.

        Returns:
            Plaintext token.
        """
        return value.removeprefix("enc:")


class BrokenTokenCipher(PlaintextTokenCipher):
    """Token cipher fake that fails decryption."""

    def decrypt(self, value: str) -> str:
        """Raise a deterministic decryption failure.

        Args:
            value: Encoded token value.

        Raises:
            TokenCipherError: Always raised by this fake.
        """
        raise TokenCipherError("cannot decrypt")


class FakeGoogleOAuthGateway:
    """Configurable fake Google OAuth gateway for refresh-path tests."""

    def __init__(self) -> None:
        """Initialize the fake OAuth gateway.

        Returns:
            None.
        """
        self.refresh_tokens: list[str] = []
        self.refresh_response = GoogleOAuthTokens(
            access_token="refreshed-access-token",
            granted_scopes=["https://www.googleapis.com/auth/calendar.readonly"],
            expires_at=utc_now() + timedelta(hours=1),
        )
        self.refresh_error: GoogleOAuthGatewayError | None = None

    def build_authorization_url(
        self,
        *,
        state_id: str,
        redirect_uri: str,
        scopes: list[str],
    ) -> str:
        """Return a fake authorization URL.

        Args:
            state_id: Server-generated OAuth state identifier.
            redirect_uri: Callback URI registered for the web client.
            scopes: OAuth scopes requested for the flow.

        Returns:
            Fake authorization URL.
        """
        return f"https://example.test/auth?state={state_id}"

    async def exchange_code(
        self,
        *,
        code: str,
        redirect_uri: str,
    ) -> GoogleOAuthTokens:
        """Return a fake token response for code exchange.

        Args:
            code: Authorization code returned by Google.
            redirect_uri: Callback URI registered for the web client.

        Returns:
            Fake OAuth token bundle.
        """
        return self.refresh_response

    async def refresh_access_token(
        self,
        *,
        refresh_token: str,
    ) -> GoogleOAuthTokens:
        """Return or raise the configured refresh result.

        Args:
            refresh_token: Stored Google refresh token.

        Returns:
            Fake OAuth token bundle.

        Raises:
            GoogleOAuthGatewayError: If configured by the test.
        """
        self.refresh_tokens.append(refresh_token)
        if self.refresh_error is not None:
            raise self.refresh_error
        return self.refresh_response

    async def revoke_token(
        self,
        *,
        token: str,
    ) -> None:
        """Accept a fake revoke request.

        Args:
            token: Google OAuth token to revoke.

        Returns:
            None.
        """
        return None

    async def verify_id_token(
        self,
        *,
        id_token: str,
    ) -> GoogleIdentityClaims:
        """Return fake identity claims.

        Args:
            id_token: Google ID token to verify.

        Returns:
            Fake identity claims.
        """
        return GoogleIdentityClaims(subject="google-subject")

    async def aclose(self) -> None:
        """Release fake resources.

        Returns:
            None.
        """
        return None


def _connection_ref() -> GoogleCalendarConnection:
    """Return the shared Calendar connection reference used by tests.

    Returns:
        Calendar connection identity.
    """
    return GoogleCalendarConnection(
        team_id="T123",
        slack_user_id="U123",
        google_account_subject="google-subject",
    )


def _stored_connection(
    *,
    access_token: str | None = "access-token",
    refresh_token: str | None = "refresh-token",
    status: GoogleConnectionStatus = GoogleConnectionStatus.ACTIVE,
    token_expires_at: datetime | None = None,
    granted_scopes: list[str] | None = None,
) -> GoogleAuthConnectionDocument:
    """Build a stored OAuth connection document for Calendar tests.

    Args:
        access_token: Plaintext access token to store through the fake cipher.
        refresh_token: Plaintext refresh token to store through the fake cipher.
        status: Connection lifecycle status.
        token_expires_at: Optional access token expiration timestamp.
        granted_scopes: Optional OAuth scopes to store on the connection.

    Returns:
        Stored Google OAuth connection document.
    """
    connection = _connection_ref()
    return GoogleAuthConnectionDocument(
        team_id=connection.team_id,
        slack_user_id=connection.slack_user_id,
        google_account_subject=connection.google_account_subject,
        google_account_email="person@example.com",
        granted_scopes=granted_scopes
        if granted_scopes is not None
        else ["https://www.googleapis.com/auth/calendar.readonly"],
        connection_status=status,
        access_token_encrypted=f"enc:{access_token}" if access_token else None,
        refresh_token_encrypted=f"enc:{refresh_token}" if refresh_token else None,
        token_expires_at=token_expires_at or utc_now() + timedelta(hours=1),
    )


def _gateway(
    *,
    repository: InMemoryGoogleAuthConnectionRepository,
    oauth_gateway: FakeGoogleOAuthGateway | None = None,
    token_cipher: PlaintextTokenCipher | None = None,
    handler: Callable[[httpx.Request], httpx.Response] | None = None,
) -> HttpxGoogleCalendarReadGateway:
    """Build a Calendar read gateway with fake dependencies.

    Args:
        repository: In-memory connection repository.
        oauth_gateway: Optional fake OAuth gateway.
        token_cipher: Optional fake token cipher.
        handler: Optional HTTPX mock transport handler.

    Returns:
        Configured Calendar read gateway.
    """
    transport = httpx.MockTransport(
        handler
        or (
            lambda request: httpx.Response(
                200,
                json={},
                request=request,
            )
        )
    )
    return HttpxGoogleCalendarReadGateway(
        connection_repository=repository,
        oauth_gateway=oauth_gateway or FakeGoogleOAuthGateway(),
        token_cipher=token_cipher or PlaintextTokenCipher(),
        http_client=httpx.AsyncClient(transport=transport),
    )


@pytest.mark.asyncio
async def test_list_calendars_returns_sdk_free_calendar_models() -> None:
    """Verify calendar list reads are parsed into domain models."""
    repository = InMemoryGoogleAuthConnectionRepository()
    repository.upsert_connection(connection=_stored_connection())

    def handler(request: httpx.Request) -> httpx.Response:
        """Return a fake Google Calendar calendarList response.

        Args:
            request: HTTPX request received by the mock transport.

        Returns:
            HTTPX response with Calendar API JSON.
        """
        assert request.url.path == "/calendar/v3/users/me/calendarList"
        assert request.headers["authorization"] == "Bearer access-token"
        if request.url.params.get("pageToken") == "page-2":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": "team@example.com",
                            "summary": "Team Calendar",
                            "accessRole": "reader",
                        }
                    ]
                },
                request=request,
            )
        return httpx.Response(
            200,
            json={
                "items": [
                    {
                        "id": "primary",
                        "summary": "Primary Calendar",
                        "timeZone": "Asia/Tokyo",
                        "primary": True,
                        "accessRole": "owner",
                    }
                ],
                "nextPageToken": "page-2",
            },
            request=request,
        )

    gateway = _gateway(repository=repository, handler=handler)

    calendars = await gateway.list_calendars(connection=_connection_ref())

    assert len(calendars) == 2
    assert calendars[0].calendar_id == "primary"
    assert calendars[0].summary == "Primary Calendar"
    assert calendars[0].primary is True
    assert calendars[1].calendar_id == "team@example.com"
    stored = repository.get_connection(
        team_id="T123",
        slack_user_id="U123",
        google_account_subject="google-subject",
    )
    assert stored is not None
    assert stored.last_successful_access_at is not None


@pytest.mark.asyncio
async def test_get_and_search_events_parse_timed_and_all_day_events() -> None:
    """Verify event reads parse timed and all-day Calendar payloads."""
    repository = InMemoryGoogleAuthConnectionRepository()
    repository.upsert_connection(connection=_stored_connection())
    requested_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        """Return fake event responses by request path.

        Args:
            request: HTTPX request received by the mock transport.

        Returns:
            HTTPX response with Calendar API JSON.
        """
        requested_paths.append(request.url.path)
        if request.url.path.endswith("/events/event-1"):
            return httpx.Response(
                200,
                json={
                    "id": "event-1",
                    "status": "confirmed",
                    "summary": "Planning",
                    "htmlLink": "https://calendar.google.com/event?eid=event-1",
                    "start": {"dateTime": "2026-05-08T10:00:00+09:00"},
                    "end": {"dateTime": "2026-05-08T11:00:00+09:00"},
                    "organizer": {"email": "owner@example.com"},
                    "creator": {"email": "creator@example.com"},
                    "updated": "2026-05-07T12:00:00Z",
                },
                request=request,
            )
        assert request.url.params["q"] == "planning"
        assert request.url.params["singleEvents"] == "true"
        return httpx.Response(
            200,
            json={
                "items": [
                    {
                        "id": "event-2",
                        "status": "confirmed",
                        "summary": "Offsite",
                        "start": {"date": "2026-05-09"},
                        "end": {"date": "2026-05-10"},
                    }
                ]
            },
            request=request,
        )

    gateway = _gateway(repository=repository, handler=handler)

    event = await gateway.get_event(
        connection=_connection_ref(),
        calendar_id="primary",
        event_id="event-1",
    )
    search_results = await gateway.search_events(
        connection=_connection_ref(),
        query=GoogleCalendarEventQuery(calendar_id="primary", text="planning"),
    )

    assert event.event_id == "event-1"
    assert event.start.date_time is not None
    assert event.start.date_time.isoformat() == "2026-05-08T10:00:00+09:00"
    assert event.is_all_day is False
    assert event.organizer_email == "owner@example.com"
    assert search_results[0].event_id == "event-2"
    assert search_results[0].is_all_day is True
    assert requested_paths == [
        "/calendar/v3/calendars/primary/events/event-1",
        "/calendar/v3/calendars/primary/events",
    ]


@pytest.mark.asyncio
async def test_list_upcoming_events_refreshes_expiring_token_before_read() -> None:
    """Verify upcoming-event reads refresh access tokens before expiry."""
    repository = InMemoryGoogleAuthConnectionRepository()
    repository.upsert_connection(
        connection=_stored_connection(token_expires_at=utc_now() + timedelta(minutes=1))
    )
    oauth_gateway = FakeGoogleOAuthGateway()

    def handler(request: httpx.Request) -> httpx.Response:
        """Return a fake upcoming events response.

        Args:
            request: HTTPX request received by the mock transport.

        Returns:
            HTTPX response with Calendar API JSON.
        """
        assert request.headers["authorization"] == "Bearer refreshed-access-token"
        assert request.url.params["orderBy"] == "startTime"
        assert request.url.params["maxResults"] == "2"
        assert request.url.params["timeMin"] == "2026-05-08T00:00:00Z"
        return httpx.Response(
            200,
            json={
                "items": [
                    {
                        "id": "event-1",
                        "start": {"dateTime": "2026-05-08T10:00:00Z"},
                        "end": {"dateTime": "2026-05-08T11:00:00Z"},
                    }
                ]
            },
            request=request,
        )

    gateway = _gateway(
        repository=repository,
        oauth_gateway=oauth_gateway,
        handler=handler,
    )

    events = await gateway.list_upcoming_events(
        connection=_connection_ref(),
        limit=2,
        now=datetime(2026, 5, 8, tzinfo=UTC),
    )

    assert [event.event_id for event in events] == ["event-1"]
    assert oauth_gateway.refresh_tokens == ["refresh-token"]
    stored = repository.get_connection(
        team_id="T123",
        slack_user_id="U123",
        google_account_subject="google-subject",
    )
    assert stored is not None
    assert stored.access_token_encrypted == "enc:refreshed-access-token"
    assert stored.last_refresh_error_code is None


@pytest.mark.asyncio
async def test_calendar_read_refreshes_once_after_api_unauthorized() -> None:
    """Verify a 401 Calendar response triggers one refresh and retry."""
    repository = InMemoryGoogleAuthConnectionRepository()
    repository.upsert_connection(connection=_stored_connection())
    oauth_gateway = FakeGoogleOAuthGateway()
    seen_authorizations: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        """Return 401 once, then a successful calendarList response.

        Args:
            request: HTTPX request received by the mock transport.

        Returns:
            HTTPX response with Calendar API JSON.
        """
        seen_authorizations.append(request.headers["authorization"])
        if len(seen_authorizations) == 1:
            return httpx.Response(401, json={"error": "invalid_token"}, request=request)
        return httpx.Response(200, json={"items": []}, request=request)

    gateway = _gateway(
        repository=repository,
        oauth_gateway=oauth_gateway,
        handler=handler,
    )

    calendars = await gateway.list_calendars(connection=_connection_ref())

    assert calendars == []
    assert seen_authorizations == [
        "Bearer access-token",
        "Bearer refreshed-access-token",
    ]
    assert oauth_gateway.refresh_tokens == ["refresh-token"]


@pytest.mark.asyncio
async def test_missing_connection_raises_reconnect_required() -> None:
    """Verify absent connections raise a stable reconnect-required reason."""
    gateway = _gateway(repository=InMemoryGoogleAuthConnectionRepository())

    with pytest.raises(GoogleCalendarReconnectRequiredError) as exc_info:
        await gateway.list_calendars(connection=_connection_ref())

    assert exc_info.value.reason == GoogleCalendarReconnectReason.CONNECTION_NOT_FOUND


@pytest.mark.asyncio
async def test_revoked_connection_raises_reconnect_required() -> None:
    """Verify revoked connections raise a stable reconnect-required reason."""
    repository = InMemoryGoogleAuthConnectionRepository()
    repository.upsert_connection(
        connection=_stored_connection(status=GoogleConnectionStatus.REVOKED)
    )
    gateway = _gateway(repository=repository)

    with pytest.raises(GoogleCalendarReconnectRequiredError) as exc_info:
        await gateway.list_calendars(connection=_connection_ref())

    assert exc_info.value.reason == GoogleCalendarReconnectReason.CONNECTION_REVOKED


@pytest.mark.asyncio
async def test_missing_calendar_scope_raises_reconnect_required() -> None:
    """Verify connections without Calendar scope require reconnect."""
    repository = InMemoryGoogleAuthConnectionRepository()
    repository.upsert_connection(
        connection=_stored_connection(granted_scopes=["email"])
    )
    gateway = _gateway(repository=repository)

    with pytest.raises(GoogleCalendarReconnectRequiredError) as exc_info:
        await gateway.list_calendars(connection=_connection_ref())

    assert exc_info.value.reason == GoogleCalendarReconnectReason.MISSING_CALENDAR_SCOPE


@pytest.mark.asyncio
async def test_invalid_refresh_token_marks_connection_expired() -> None:
    """Verify invalid refresh tokens are persisted as expired connections."""
    repository = InMemoryGoogleAuthConnectionRepository()
    repository.upsert_connection(
        connection=_stored_connection(token_expires_at=utc_now() - timedelta(minutes=1))
    )
    oauth_gateway = FakeGoogleOAuthGateway()
    oauth_gateway.refresh_error = GoogleOAuthGatewayError(
        "invalid grant",
        error_code="invalid_grant",
    )
    gateway = _gateway(repository=repository, oauth_gateway=oauth_gateway)

    with pytest.raises(GoogleCalendarReconnectRequiredError) as exc_info:
        await gateway.list_calendars(connection=_connection_ref())

    stored = repository.get_connection(
        team_id="T123",
        slack_user_id="U123",
        google_account_subject="google-subject",
    )
    assert stored is not None
    assert exc_info.value.reason == GoogleCalendarReconnectReason.TOKEN_REFRESH_FAILED
    assert stored.connection_status == GoogleConnectionStatus.EXPIRED
    assert stored.last_refresh_error_code == "invalid_grant"


@pytest.mark.asyncio
async def test_decrypt_failure_marks_connection_error() -> None:
    """Verify broken stored token ciphertext is persisted as an error state."""
    repository = InMemoryGoogleAuthConnectionRepository()
    repository.upsert_connection(connection=_stored_connection())
    gateway = _gateway(repository=repository, token_cipher=BrokenTokenCipher())

    with pytest.raises(GoogleCalendarReconnectRequiredError) as exc_info:
        await gateway.list_calendars(connection=_connection_ref())

    stored = repository.get_connection(
        team_id="T123",
        slack_user_id="U123",
        google_account_subject="google-subject",
    )
    assert stored is not None
    assert exc_info.value.reason == GoogleCalendarReconnectReason.TOKEN_DECRYPT_FAILED
    assert stored.connection_status == GoogleConnectionStatus.ERROR
    assert stored.last_refresh_error_code == "token_decrypt_failed"
