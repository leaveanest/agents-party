from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agents_party.domain.google_auth import (
    GoogleAuthConnectionDocument,
    GoogleIdentityClaims,
    GoogleOAuthStateDocument,
    GoogleOAuthStateToken,
    GoogleOAuthTokens,
    calculate_expiration,
)
from agents_party.domain.slack_documents import utc_now
from agents_party.google_auth.router import create_google_auth_router
from agents_party.google_auth.service import GoogleAuthCoordinator
from agents_party.infrastructure.google_auth import (
    GoogleOAuthContextSigner,
    GoogleOAuthGatewayError,
)


class InMemoryGoogleAuthConnectionRepository:
    """In-memory Google OAuth connection repository for route tests."""

    def __init__(self) -> None:
        """Initialize the in-memory document store.

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
            Stored connection documents for the Slack user.
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
    """In-memory Google OAuth state repository for route tests."""

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
        """Atomically read and delete a stored OAuth state document.

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
    """Configurable Google OAuth gateway fake used by route tests."""

    def __init__(self) -> None:
        """Initialize the fake gateway.

        Returns:
            None.
        """
        self.exchange_tokens = GoogleOAuthTokens(
            access_token="access-token",
            refresh_token="refresh-token",
            id_token="id-token",
            granted_scopes=["openid", "email", "profile"],
            expires_at=calculate_expiration(expires_in_seconds=3600),
        )
        self.identity_claims = GoogleIdentityClaims(
            subject="google-subject",
            email="person@example.com",
            email_verified=True,
        )
        self.exchange_error: Exception | None = None
        self.verify_error: Exception | None = None
        self.authorization_calls: list[dict[str, Any]] = []

    def build_authorization_url(
        self,
        *,
        state_id: str,
        redirect_uri: str,
        scopes: list[str],
    ) -> str:
        """Return a deterministic Google authorization URL for assertions.

        Args:
            state_id: Server-generated OAuth state identifier.
            redirect_uri: Callback URI registered for the web client.
            scopes: OAuth scopes requested for the flow.

        Returns:
            Deterministic authorization URL including the state and scope.
        """
        self.authorization_calls.append(
            {
                "state_id": state_id,
                "redirect_uri": redirect_uri,
                "scopes": scopes,
            }
        )
        return (
            "https://accounts.google.com/o/oauth2/v2/auth?"
            f"state={state_id}&redirect_uri={redirect_uri}&scope={' '.join(scopes)}"
        )

    async def exchange_code(
        self,
        *,
        code: str,
        redirect_uri: str,
    ) -> GoogleOAuthTokens:
        """Return the configured code exchange result.

        Args:
            code: OAuth authorization code.
            redirect_uri: OAuth callback URI.

        Returns:
            Configured token bundle.

        Raises:
            Exception: Re-raises the configured exchange error.
        """
        del code, redirect_uri
        if self.exchange_error is not None:
            raise self.exchange_error
        return self.exchange_tokens

    async def refresh_access_token(
        self,
        *,
        refresh_token: str,
    ) -> GoogleOAuthTokens:
        """Refresh is not used in route tests.

        Args:
            refresh_token: Stored Google refresh token.

        Returns:
            Configured token bundle.
        """
        del refresh_token
        return self.exchange_tokens

    async def revoke_token(
        self,
        *,
        token: str,
    ) -> None:
        """Revocation is not used in route tests.

        Args:
            token: Token selected for revocation.

        Returns:
            None.
        """
        del token

    async def verify_id_token(
        self,
        *,
        id_token: str,
    ) -> GoogleIdentityClaims:
        """Return the configured ID token verification result.

        Args:
            id_token: Google ID token to verify.

        Returns:
            Configured identity claims.

        Raises:
            Exception: Re-raises the configured verification error.
        """
        del id_token
        if self.verify_error is not None:
            raise self.verify_error
        return self.identity_claims

    async def aclose(self) -> None:
        """Release fake gateway resources.

        Returns:
            None.
        """
        return None


def build_client(
    *,
    gateway: FakeGoogleOAuthGateway | None = None,
    state_repository: InMemoryGoogleOAuthStateRepository | None = None,
    connection_repository: InMemoryGoogleAuthConnectionRepository | None = None,
) -> tuple[
    TestClient,
    GoogleAuthCoordinator,
    InMemoryGoogleOAuthStateRepository,
    InMemoryGoogleAuthConnectionRepository,
    FakeGoogleOAuthGateway,
]:
    """Build a FastAPI test client with a fully wired Google OAuth router.

    Args:
        gateway: Optional fake OAuth gateway override.
        state_repository: Optional in-memory state repository override.
        connection_repository: Optional in-memory connection repository override.

        Returns:
            Tuple of test client and its core fake collaborators.
    """
    actual_gateway = gateway or FakeGoogleOAuthGateway()
    actual_state_repository = state_repository or InMemoryGoogleOAuthStateRepository()
    actual_connection_repository = (
        connection_repository or InMemoryGoogleAuthConnectionRepository()
    )
    coordinator = GoogleAuthCoordinator(
        connection_repository=actual_connection_repository,
        state_repository=actual_state_repository,
        gateway=actual_gateway,
        context_signer=GoogleOAuthContextSigner(secret="test-signing-secret"),
        token_cipher=PlaintextTokenCipher(),
        redirect_uri="https://example.com/oauth/google/callback",
    )
    app = FastAPI()
    app.include_router(create_google_auth_router(coordinator))
    return (
        TestClient(app),
        coordinator,
        actual_state_repository,
        actual_connection_repository,
        actual_gateway,
    )


def decode_state_token(
    coordinator: GoogleAuthCoordinator,
    public_state: str,
) -> GoogleOAuthStateToken:
    """Decode an opaque public callback state token for assertions.

    Args:
        coordinator: Coordinator whose signer issued the public state token.
        public_state: Opaque callback `state` token from the authorization URL.

    Returns:
        Decoded OAuth state token payload.
    """
    return coordinator._context_signer.loads_state_token(public_state)


def test_google_oauth_start_rejects_invalid_context() -> None:
    """Verify the start route rejects malformed signed context tokens.

    Returns:
        None.
    """
    client, _coordinator, _states, _connections, _gateway = build_client()

    response = client.get("/oauth/google/start", params={"context": "not-a-token"})

    assert response.status_code == 400
    assert response.json()["detail"] == "Malformed Google OAuth context token"


def test_google_oauth_start_rejects_expired_context() -> None:
    """Verify the start route rejects signed context tokens past their expiry.

    Returns:
        None.
    """
    client, coordinator, _states, _connections, _gateway = build_client()
    context = coordinator.issue_start_context(
        team_id="T1",
        slack_user_id="U1",
        ttl=timedelta(seconds=-1),
    )

    response = client.get("/oauth/google/start", params={"context": context})

    assert response.status_code == 400
    assert response.json()["detail"] == "Expired Google OAuth context token"


def test_google_oauth_start_redirects_to_google_and_persists_state() -> None:
    """Verify the start route redirects to Google and stores server-side state.

    Returns:
        None.
    """
    client, coordinator, state_repository, _connections, gateway = build_client()
    context = coordinator.issue_start_context(
        team_id="T1",
        slack_user_id="U1",
        redirect_after_connect="/after",
    )

    response = client.get(
        "/oauth/google/start",
        params={"context": context},
        follow_redirects=False,
    )

    assert response.status_code == 303
    location = response.headers["location"]
    parsed = urlparse(location)
    query = parse_qs(parsed.query)
    public_state = query["state"][0]
    state_reference = decode_state_token(coordinator, public_state)
    assert parsed.netloc == "accounts.google.com"
    assert (
        gateway.authorization_calls[0]["redirect_uri"]
        == "https://example.com/oauth/google/callback"
    )
    stored_state = state_repository.get_state(
        team_id="T1",
        state_id=state_reference.state_id,
    )
    assert stored_state is not None
    assert stored_state.slack_user_id == "U1"
    assert stored_state.redirect_after_connect == "/after"


def test_google_oauth_start_returns_500_when_state_persistence_fails() -> None:
    """Verify the start route surfaces state persistence failures as typed errors.

    Returns:
        None.
    """
    state_repository = InMemoryGoogleOAuthStateRepository()
    state_repository.create_error = RuntimeError("firestore unavailable")
    client, coordinator, _states, _connections, _gateway = build_client(
        state_repository=state_repository
    )
    context = coordinator.issue_start_context(team_id="T1", slack_user_id="U1")

    response = client.get("/oauth/google/start", params={"context": context})

    assert response.status_code == 500
    assert response.json()["detail"] == "Failed to create Google OAuth state"


def test_google_oauth_callback_persists_connection_and_consumes_state() -> None:
    """Verify a successful callback stores the connection and deletes the state.

    Returns:
        None.
    """
    client, coordinator, state_repository, connection_repository, _gateway = (
        build_client()
    )
    context = coordinator.issue_start_context(
        team_id="T1",
        slack_user_id="U1",
        redirect_after_connect="/app",
    )
    start_response = client.get(
        "/oauth/google/start",
        params={"context": context},
        follow_redirects=False,
    )
    public_state = parse_qs(urlparse(start_response.headers["location"]).query)[
        "state"
    ][0]
    state_reference = decode_state_token(coordinator, public_state)

    callback_response = client.get(
        "/oauth/google/callback",
        params={"state": public_state, "code": "auth-code"},
        follow_redirects=False,
    )

    assert callback_response.status_code == 303
    assert callback_response.headers["location"] == "/app?google_oauth_status=success"
    stored_connection = connection_repository.get_connection(
        team_id="T1",
        slack_user_id="U1",
        google_account_subject="google-subject",
    )
    assert stored_connection is not None
    assert stored_connection.google_account_email == "person@example.com"
    assert stored_connection.access_token_encrypted == "enc:access-token"
    assert stored_connection.refresh_token_encrypted == "enc:refresh-token"
    assert (
        state_repository.get_state(
            team_id="T1",
            state_id=state_reference.state_id,
        )
        is None
    )


def test_google_oauth_callback_rejects_unknown_or_reused_state() -> None:
    """Verify callback replay and unknown state values are rejected.

    Returns:
        None.
    """
    client, coordinator, _states, _connections, _gateway = build_client()
    context = coordinator.issue_start_context(team_id="T1", slack_user_id="U1")
    start_response = client.get(
        "/oauth/google/start",
        params={"context": context},
        follow_redirects=False,
    )
    state_id = parse_qs(urlparse(start_response.headers["location"]).query)["state"][0]

    first_response = client.get(
        "/oauth/google/callback",
        params={"state": state_id, "code": "auth-code"},
        follow_redirects=False,
    )
    second_response = client.get(
        "/oauth/google/callback",
        params={"state": state_id, "code": "auth-code"},
        follow_redirects=False,
    )
    missing_state = coordinator._context_signer.dumps_state_token(
        GoogleOAuthStateToken(
            team_id="T1",
            state_id="missing",
            expires_at=utc_now() + timedelta(minutes=10),
        )
    )
    missing_response = client.get(
        "/oauth/google/callback",
        params={"state": missing_state, "code": "auth-code"},
    )

    assert first_response.status_code == 200
    assert second_response.status_code == 400
    assert "already consumed" in second_response.text
    assert missing_response.status_code == 400
    assert "Unknown or already consumed" in missing_response.text


def test_google_oauth_callback_rejects_malformed_state_with_path_separator() -> None:
    """Verify malformed callback state values are rejected before repository lookup.

    Returns:
        None.
    """
    client, _coordinator, _states, _connections, _gateway = build_client()

    response = client.get(
        "/oauth/google/callback",
        params={"state": "T1.invalid/path", "code": "auth-code"},
    )

    assert response.status_code == 400
    assert "Invalid Google OAuth state" in response.text


def test_google_oauth_callback_rejects_expired_state() -> None:
    """Verify callback rejects expired server-side OAuth state documents.

    Returns:
        None.
    """
    state_repository = InMemoryGoogleOAuthStateRepository()
    expired_state = GoogleOAuthStateDocument(
        state_id="expired-state",
        team_id="T1",
        slack_user_id="U1",
        expires_at=utc_now() - timedelta(minutes=1),
    )
    state_repository.create_state(state=expired_state)
    client, _coordinator, _states, _connections, _gateway = build_client(
        state_repository=state_repository,
    )

    expired_public_state = GoogleOAuthContextSigner(
        secret="test-signing-secret"
    ).dumps_state_token(
        GoogleOAuthStateToken(
            team_id="T1",
            state_id="expired-state",
            expires_at=utc_now() + timedelta(minutes=10),
        )
    )
    response = client.get(
        "/oauth/google/callback",
        params={"state": expired_public_state, "code": "auth-code"},
    )

    assert response.status_code == 400
    assert "Expired Google OAuth state" in response.text
    assert state_repository.get_state(team_id="T1", state_id="expired-state") is None


def test_google_oauth_callback_redirects_with_error_when_google_returns_error() -> None:
    """Verify callback errors redirect back to the supplied post-connect URL.

    Returns:
        None.
    """
    client, coordinator, _states, _connections, _gateway = build_client()
    context = coordinator.issue_start_context(
        team_id="T1",
        slack_user_id="U1",
        redirect_after_connect="/app?tab=settings",
    )
    start_response = client.get(
        "/oauth/google/start",
        params={"context": context},
        follow_redirects=False,
    )
    state_id = parse_qs(urlparse(start_response.headers["location"]).query)["state"][0]

    response = client.get(
        "/oauth/google/callback",
        params={
            "state": state_id,
            "error": "access_denied",
            "error_description": "user denied access",
        },
        follow_redirects=False,
    )

    assert response.status_code == 303
    assert (
        response.headers["location"]
        == "/app?tab=settings&google_oauth_status=error&google_oauth_error=access_denied"
    )


def test_google_oauth_start_rejects_absolute_redirect_targets() -> None:
    """Verify issue_start_context rejects redirect targets outside the app origin.

    Returns:
        None.
    """
    _client, coordinator, _states, _connections, _gateway = build_client()

    with pytest.raises(ValueError, match="relative path"):
        coordinator.issue_start_context(
            team_id="T1",
            slack_user_id="U1",
            redirect_after_connect="https://example.com/app",
        )


def test_google_oauth_callback_escapes_error_text_in_html_response() -> None:
    """Verify callback error pages HTML-escape provider-controlled text.

    Returns:
        None.
    """
    client, coordinator, _states, _connections, _gateway = build_client()
    context = coordinator.issue_start_context(team_id="T1", slack_user_id="U1")
    start_response = client.get(
        "/oauth/google/start",
        params={"context": context},
        follow_redirects=False,
    )
    state_id = parse_qs(urlparse(start_response.headers["location"]).query)["state"][0]

    response = client.get(
        "/oauth/google/callback",
        params={
            "state": state_id,
            "error": "access_denied",
            "error_description": "<script>alert(1)</script>",
        },
    )

    assert response.status_code == 400
    assert "<script>alert(1)</script>" not in response.text
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in response.text


def test_google_oauth_callback_rejects_token_exchange_failures() -> None:
    """Verify token exchange failures surface as callback errors.

    Returns:
        None.
    """
    gateway = FakeGoogleOAuthGateway()
    gateway.exchange_error = GoogleOAuthGatewayError(
        "exchange failed",
        error_code="server_error",
        retriable=True,
    )
    client, coordinator, _states, _connections, _gateway = build_client(gateway=gateway)
    context = coordinator.issue_start_context(team_id="T1", slack_user_id="U1")
    start_response = client.get(
        "/oauth/google/start",
        params={"context": context},
        follow_redirects=False,
    )
    state_id = parse_qs(urlparse(start_response.headers["location"]).query)["state"][0]

    response = client.get(
        "/oauth/google/callback",
        params={"state": state_id, "code": "auth-code"},
    )

    assert response.status_code == 502
    assert "exchange failed" in response.text


def test_google_oauth_callback_returns_400_for_non_retriable_gateway_failures() -> None:
    """Verify non-retriable Google callback failures are surfaced as client errors.

    Returns:
        None.
    """
    gateway = FakeGoogleOAuthGateway()
    gateway.exchange_error = GoogleOAuthGatewayError(
        "authorization code expired",
        error_code="invalid_grant",
        retriable=False,
    )
    client, coordinator, _states, _connections, _gateway = build_client(gateway=gateway)
    context = coordinator.issue_start_context(team_id="T1", slack_user_id="U1")
    start_response = client.get(
        "/oauth/google/start",
        params={"context": context},
        follow_redirects=False,
    )
    state_id = parse_qs(urlparse(start_response.headers["location"]).query)["state"][0]

    response = client.get(
        "/oauth/google/callback",
        params={"state": state_id, "code": "auth-code"},
    )

    assert response.status_code == 400
    assert "authorization code expired" in response.text


def test_google_oauth_callback_rejects_id_token_verification_failures() -> None:
    """Verify invalid ID tokens surface as callback failures.

    Returns:
        None.
    """
    gateway = FakeGoogleOAuthGateway()
    gateway.verify_error = GoogleOAuthGatewayError(
        "bad id token",
        error_code="invalid_id_token",
    )
    client, coordinator, _states, _connections, _gateway = build_client(gateway=gateway)
    context = coordinator.issue_start_context(team_id="T1", slack_user_id="U1")
    start_response = client.get(
        "/oauth/google/start",
        params={"context": context},
        follow_redirects=False,
    )
    state_id = parse_qs(urlparse(start_response.headers["location"]).query)["state"][0]

    response = client.get(
        "/oauth/google/callback",
        params={"state": state_id, "code": "auth-code"},
    )

    assert response.status_code == 400
    assert "bad id token" in response.text


def test_google_oauth_callback_returns_502_for_retriable_id_token_verification_failures() -> (
    None
):
    """Verify retriable ID token verification failures surface as server errors.

    Returns:
        None.
    """
    gateway = FakeGoogleOAuthGateway()
    gateway.verify_error = GoogleOAuthGatewayError(
        "verify transport failed",
        error_code="transport_error",
        retriable=True,
    )
    client, coordinator, _states, _connections, _gateway = build_client(gateway=gateway)
    context = coordinator.issue_start_context(team_id="T1", slack_user_id="U1")
    start_response = client.get(
        "/oauth/google/start",
        params={"context": context},
        follow_redirects=False,
    )
    state_id = parse_qs(urlparse(start_response.headers["location"]).query)["state"][0]

    response = client.get(
        "/oauth/google/callback",
        params={"state": state_id, "code": "auth-code"},
    )

    assert response.status_code == 502
    assert "verify transport failed" in response.text
