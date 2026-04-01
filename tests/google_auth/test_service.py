from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
import asyncio
from urllib.parse import parse_qs, urlparse

import pytest

from agents_party.domain.google_auth import (
    GoogleAuthConnectionDocument,
    GoogleConnectionStatus,
    GoogleIdentityClaims,
    GoogleOAuthStateDocument,
    GoogleOAuthTokens,
    calculate_expiration,
)
from agents_party.domain.slack_documents import utc_now
from agents_party.google_auth.service import GoogleAuthCoordinator, GoogleOAuthFlowError
from agents_party.infrastructure.google_auth import (
    GoogleOAuthContextSigner,
    GoogleOAuthGatewayError,
)


class InMemoryGoogleAuthConnectionRepository:
    """In-memory Google OAuth connection repository for service tests."""

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
            for (
                document_team_id,
                document_slack_user_id,
                _subject,
            ), document in self.documents.items()
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


class InMemoryGoogleOAuthStateRepository:
    """In-memory Google OAuth state repository for service tests."""

    def __init__(self) -> None:
        """Initialize the in-memory state store.

        Returns:
            None.
        """
        self.documents: dict[str, dict[str, GoogleOAuthStateDocument]] = defaultdict(
            dict
        )
        self.create_error: Exception | None = None

    def create_state(
        self,
        *,
        state: GoogleOAuthStateDocument,
    ) -> GoogleOAuthStateDocument:
        """Persist a Google OAuth state document.

        Args:
            state: State document to store.

        Returns:
            Stored state document.
        """
        if self.create_error is not None:
            raise self.create_error
        self.documents[state.team_id][state.state_id] = state
        return state

    def get_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> GoogleOAuthStateDocument | None:
        """Return a stored Google OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            Stored state document, or `None` when absent.
        """
        return self.documents.get(team_id, {}).get(state_id)

    def consume_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> GoogleOAuthStateDocument | None:
        """Atomically read and delete a stored Google OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            Stored state document, or `None` when absent.
        """
        return self.documents.get(team_id, {}).pop(state_id, None)

    def delete_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> None:
        """Delete a stored Google OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            None.
        """
        self.documents.get(team_id, {}).pop(state_id, None)


class PlaintextTokenCipher:
    """Deterministic token cipher fake used by unit tests."""

    def encrypt(self, value: str) -> str:
        """Return a reversible fake ciphertext string.

        Args:
            value: Plaintext token to encode.

        Returns:
            Encoded token string.
        """
        return f"enc:{value}"

    def decrypt(self, value: str) -> str:
        """Decode a fake ciphertext string back into plaintext.

        Args:
            value: Encoded token string to decode.

        Returns:
            Decoded plaintext token.
        """
        return value.removeprefix("enc:")


class FakeGoogleOAuthGateway:
    """Configurable fake Google OAuth gateway for service tests."""

    def __init__(self) -> None:
        """Initialize the fake gateway.

        Returns:
            None.
        """
        self.refresh_result = GoogleOAuthTokens(
            access_token="new-access-token",
            refresh_token=None,
            granted_scopes=["openid", "email"],
            expires_at=calculate_expiration(expires_in_seconds=7200),
        )
        self.refresh_error: Exception | None = None
        self.revoke_error: Exception | None = None
        self.revoked_tokens: list[str] = []
        self.closed = False
        self.exchange_calls = 0
        self.exchange_started: asyncio.Event | None = None
        self.allow_exchange: asyncio.Event | None = None
        self.refresh_started: asyncio.Event | None = None
        self.allow_refresh: asyncio.Event | None = None

    def build_authorization_url(
        self,
        *,
        state_id: str,
        redirect_uri: str,
        scopes: list[str],
    ) -> str:
        """Return a deterministic authorization URL.

        Args:
            state_id: OAuth state identifier.
            redirect_uri: OAuth callback URI.
            scopes: OAuth scopes requested for the flow.

        Returns:
            Deterministic authorization URL.
        """
        del redirect_uri, scopes
        return f"https://example.com/auth?state={state_id}"

    async def exchange_code(
        self,
        *,
        code: str,
        redirect_uri: str,
    ) -> GoogleOAuthTokens:
        """Code exchange is not used in these service tests.

        Args:
            code: OAuth authorization code.
            redirect_uri: OAuth callback URI.

        Returns:
            Dummy token bundle.
        """
        del code, redirect_uri
        self.exchange_calls += 1
        if self.exchange_started is not None:
            self.exchange_started.set()
        if self.allow_exchange is not None:
            await self.allow_exchange.wait()
        return GoogleOAuthTokens(
            access_token="unused",
            refresh_token="unused",
            id_token="unused",
        )

    async def refresh_access_token(
        self,
        *,
        refresh_token: str,
    ) -> GoogleOAuthTokens:
        """Return the configured refresh result or re-raise the refresh error.

        Args:
            refresh_token: Stored Google refresh token.

        Returns:
            Configured refresh token bundle.

        Raises:
            Exception: Re-raises the configured refresh error.
        """
        del refresh_token
        if self.refresh_started is not None:
            self.refresh_started.set()
        if self.allow_refresh is not None:
            await self.allow_refresh.wait()
        if self.refresh_error is not None:
            raise self.refresh_error
        return self.refresh_result

    async def revoke_token(
        self,
        *,
        token: str,
    ) -> None:
        """Record a revocation request or re-raise the configured error.

        Args:
            token: Token selected for revocation.

        Returns:
            None.

        Raises:
            Exception: Re-raises the configured revocation error.
        """
        self.revoked_tokens.append(token)
        if self.revoke_error is not None:
            raise self.revoke_error

    async def verify_id_token(
        self,
        *,
        id_token: str,
    ) -> GoogleIdentityClaims:
        """ID token verification is not used in these service tests.

        Args:
            id_token: Google ID token.

        Returns:
            Dummy identity claims.
        """
        del id_token
        return GoogleIdentityClaims(
            subject="unused",
            email="unused@example.com",
            email_verified=True,
        )

    async def aclose(self) -> None:
        """Record gateway shutdown for lifecycle assertions.

        Returns:
            None.
        """
        self.closed = True


def build_coordinator(
    *,
    connection_repository: InMemoryGoogleAuthConnectionRepository | None = None,
    state_repository: InMemoryGoogleOAuthStateRepository | None = None,
    gateway: FakeGoogleOAuthGateway | None = None,
) -> tuple[
    GoogleAuthCoordinator,
    InMemoryGoogleAuthConnectionRepository,
    InMemoryGoogleOAuthStateRepository,
    FakeGoogleOAuthGateway,
]:
    """Build a coordinator and in-memory collaborators for unit tests.

    Args:
        connection_repository: Optional fake connection repository override.
        state_repository: Optional fake state repository override.
        gateway: Optional fake gateway override.

        Returns:
            Tuple of coordinator and its core fake collaborators.
    """
    actual_connection_repository = (
        connection_repository or InMemoryGoogleAuthConnectionRepository()
    )
    actual_state_repository = state_repository or InMemoryGoogleOAuthStateRepository()
    actual_gateway = gateway or FakeGoogleOAuthGateway()
    coordinator = GoogleAuthCoordinator(
        connection_repository=actual_connection_repository,
        state_repository=actual_state_repository,
        gateway=actual_gateway,
        context_signer=GoogleOAuthContextSigner(secret="test-signing-secret"),
        token_cipher=PlaintextTokenCipher(),
        redirect_uri="https://example.com/oauth/google/callback",
    )
    return (
        coordinator,
        actual_connection_repository,
        actual_state_repository,
        actual_gateway,
    )


def build_connection() -> GoogleAuthConnectionDocument:
    """Build a stored connection document suitable for lifecycle tests.

    Returns:
        Google OAuth connection document with encrypted tokens.
    """
    now = utc_now()
    return GoogleAuthConnectionDocument(
        team_id="T1",
        slack_user_id="U1",
        google_account_subject="google-subject",
        google_account_email="person@example.com",
        google_account_email_verified=True,
        granted_scopes=["openid", "email", "profile"],
        connection_status=GoogleConnectionStatus.ACTIVE,
        access_token_encrypted="enc:old-access-token",
        refresh_token_encrypted="enc:old-refresh-token",
        token_expires_at=now + timedelta(minutes=30),
        refresh_token_expires_at=now + timedelta(days=30),
        created_at=now,
        updated_at=now,
    )


@pytest.mark.asyncio
async def test_refresh_connection_updates_tokens_and_preserves_existing_refresh_token() -> (
    None
):
    """Verify refresh success updates access token fields but keeps old refresh token.

    Returns:
        None.
    """
    coordinator, connection_repository, _states, _gateway = build_coordinator()
    connection_repository.upsert_connection(connection=build_connection())

    refreshed = await coordinator.refresh_connection(
        team_id="T1",
        slack_user_id="U1",
        google_account_subject="google-subject",
    )

    assert refreshed.connection_status == GoogleConnectionStatus.ACTIVE
    assert refreshed.access_token_encrypted == "enc:new-access-token"
    assert refreshed.refresh_token_encrypted == "enc:old-refresh-token"
    assert refreshed.last_refreshed_at is not None
    assert refreshed.last_refresh_error_code is None


@pytest.mark.asyncio
async def test_refresh_connection_marks_expired_on_invalid_grant() -> None:
    """Verify invalid refresh grants mark the connection as expired.

    Returns:
        None.
    """
    gateway = FakeGoogleOAuthGateway()
    gateway.refresh_error = GoogleOAuthGatewayError(
        "refresh token expired",
        error_code="invalid_grant",
    )
    coordinator, connection_repository, _states, _gateway = build_coordinator(
        gateway=gateway,
    )
    connection_repository.upsert_connection(connection=build_connection())

    with pytest.raises(GoogleOAuthFlowError, match="refresh token expired"):
        await coordinator.refresh_connection(
            team_id="T1",
            slack_user_id="U1",
            google_account_subject="google-subject",
        )

    stored = connection_repository.get_connection(
        team_id="T1",
        slack_user_id="U1",
        google_account_subject="google-subject",
    )
    assert stored is not None
    assert stored.connection_status == GoogleConnectionStatus.EXPIRED
    assert stored.last_refresh_error_code == "invalid_grant"


@pytest.mark.asyncio
async def test_refresh_connection_keeps_active_on_transient_gateway_failure() -> None:
    """Verify retriable refresh errors keep the connection active.

    Returns:
        None.
    """
    gateway = FakeGoogleOAuthGateway()
    gateway.refresh_error = GoogleOAuthGatewayError(
        "temporary Google outage",
        error_code="server_error",
        retriable=True,
    )
    coordinator, connection_repository, _states, _gateway = build_coordinator(
        gateway=gateway,
    )
    connection_repository.upsert_connection(connection=build_connection())

    with pytest.raises(GoogleOAuthFlowError, match="temporary Google outage"):
        await coordinator.refresh_connection(
            team_id="T1",
            slack_user_id="U1",
            google_account_subject="google-subject",
        )

    stored = connection_repository.get_connection(
        team_id="T1",
        slack_user_id="U1",
        google_account_subject="google-subject",
    )
    assert stored is not None
    assert stored.connection_status == GoogleConnectionStatus.ACTIVE
    assert stored.last_refresh_error_code == "server_error"


@pytest.mark.asyncio
async def test_revoke_connection_clears_tokens_even_when_google_revoke_fails() -> None:
    """Verify revoke clears local secrets even when remote revocation errors.

    Returns:
        None.
    """
    gateway = FakeGoogleOAuthGateway()
    gateway.revoke_error = GoogleOAuthGatewayError(
        "revoke failed",
        error_code="server_error",
        retriable=True,
    )
    coordinator, connection_repository, _states, _gateway = build_coordinator(
        gateway=gateway,
    )
    connection_repository.upsert_connection(connection=build_connection())

    revoked = await coordinator.revoke_connection(
        team_id="T1",
        slack_user_id="U1",
        google_account_subject="google-subject",
    )

    assert gateway.revoked_tokens == ["old-refresh-token"]
    assert revoked.connection_status == GoogleConnectionStatus.REVOKED
    assert revoked.access_token_encrypted is None
    assert revoked.refresh_token_encrypted is None
    assert revoked.last_refresh_error_code == "server_error"


@pytest.mark.asyncio
async def test_coordinator_closes_underlying_gateway() -> None:
    """Verify coordinator shutdown releases gateway-owned resources.

    Returns:
        None.
    """
    coordinator, _connections, _states, gateway = build_coordinator()

    await coordinator.aclose()

    assert gateway.closed is True


@pytest.mark.asyncio
async def test_begin_authorization_surfaces_state_persistence_failures() -> None:
    """Verify start-flow persistence failures become typed OAuth flow errors.

    Returns:
        None.
    """
    state_repository = InMemoryGoogleOAuthStateRepository()
    state_repository.create_error = RuntimeError("firestore unavailable")
    coordinator = GoogleAuthCoordinator(
        connection_repository=InMemoryGoogleAuthConnectionRepository(),
        state_repository=state_repository,
        gateway=FakeGoogleOAuthGateway(),
        context_signer=GoogleOAuthContextSigner(secret="test-signing-secret"),
        token_cipher=PlaintextTokenCipher(),
        redirect_uri="https://example.com/oauth/google/callback",
    )
    context = coordinator.issue_start_context(team_id="T1", slack_user_id="U1")

    with pytest.raises(GoogleOAuthFlowError) as exc_info:
        await coordinator.begin_authorization(context_token=context)

    assert str(exc_info.value) == "Failed to create Google OAuth state"
    assert exc_info.value.code == "state_storage_error"
    assert exc_info.value.status_code == 500


@pytest.mark.asyncio
async def test_handle_callback_consumes_state_once_under_concurrent_retries() -> None:
    """Verify concurrent callbacks cannot both consume the same OAuth state.

    Returns:
        None.
    """
    gateway = FakeGoogleOAuthGateway()
    gateway.exchange_started = asyncio.Event()
    gateway.allow_exchange = asyncio.Event()
    coordinator, _connections, _states, _gateway = build_coordinator(gateway=gateway)
    context = coordinator.issue_start_context(team_id="T1", slack_user_id="U1")
    authorization_url = await coordinator.begin_authorization(context_token=context)
    public_state = parse_qs(urlparse(authorization_url).query)["state"][0]

    first_callback = asyncio.create_task(
        coordinator.handle_callback(
            state_id=public_state,
            code="auth-code",
            error=None,
            error_description=None,
        )
    )
    await gateway.exchange_started.wait()

    with pytest.raises(
        GoogleOAuthFlowError,
        match="Unknown or already consumed Google OAuth state",
    ):
        await coordinator.handle_callback(
            state_id=public_state,
            code="auth-code",
            error=None,
            error_description=None,
        )

    gateway.allow_exchange.set()
    await first_callback
    assert gateway.exchange_calls == 1


@pytest.mark.asyncio
async def test_revoke_connection_wins_against_in_flight_refresh() -> None:
    """Verify an in-flight refresh cannot resurrect a concurrently revoked connection.

    Returns:
        None.
    """
    gateway = FakeGoogleOAuthGateway()
    gateway.refresh_started = asyncio.Event()
    gateway.allow_refresh = asyncio.Event()
    coordinator, connection_repository, _states, _gateway = build_coordinator(
        gateway=gateway
    )
    connection_repository.upsert_connection(connection=build_connection())

    refresh_task = asyncio.create_task(
        coordinator.refresh_connection(
            team_id="T1",
            slack_user_id="U1",
            google_account_subject="google-subject",
        )
    )
    await gateway.refresh_started.wait()

    revoke_task = asyncio.create_task(
        coordinator.revoke_connection(
            team_id="T1",
            slack_user_id="U1",
            google_account_subject="google-subject",
        )
    )
    await asyncio.sleep(0)
    assert revoke_task.done() is False

    gateway.allow_refresh.set()
    await refresh_task
    revoked = await revoke_task

    stored = connection_repository.get_connection(
        team_id="T1",
        slack_user_id="U1",
        google_account_subject="google-subject",
    )
    assert revoked.connection_status == GoogleConnectionStatus.REVOKED
    assert stored is not None
    assert stored.connection_status == GoogleConnectionStatus.REVOKED
    assert stored.access_token_encrypted is None
    assert stored.refresh_token_encrypted is None
