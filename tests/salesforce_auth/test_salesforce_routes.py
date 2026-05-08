from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from agents_party.domain.salesforce_auth import (
    SalesforceConnectionDocument,
    SalesforceConnectionStatus,
    SalesforceIdentity,
    SalesforceOAuthStateDocument,
    SalesforceOAuthStateToken,
    SalesforceOAuthTokens,
    SalesforceWorkspaceAuthConfigDocument,
    calculate_expiration,
)
from agents_party.infrastructure.salesforce import (
    SalesforceOAuthContextSigner,
    SalesforceOAuthGatewayError,
)
from agents_party.salesforce_auth.router import create_salesforce_auth_router
from agents_party.salesforce_auth.service import (
    SalesforceAuthCoordinator,
    SalesforceOAuthFlowError,
)


class InMemorySalesforceAuthConfigRepository:
    """In-memory Salesforce workspace auth config repository for tests."""

    def __init__(self) -> None:
        """Initialize the in-memory config store."""
        self.documents: dict[
            tuple[str, str], SalesforceWorkspaceAuthConfigDocument
        ] = {}

    def get_config(
        self,
        *,
        team_id: str,
        salesforce_org_id: str,
    ) -> SalesforceWorkspaceAuthConfigDocument | None:
        """Return a stored Salesforce workspace auth config.

        Args:
            team_id: Slack workspace id owning the configuration.
            salesforce_org_id: Salesforce org id for the configuration.

        Returns:
            Stored config document, or `None` when absent.
        """
        return self.documents.get((team_id, salesforce_org_id))

    def upsert_config(
        self,
        *,
        config: SalesforceWorkspaceAuthConfigDocument,
    ) -> SalesforceWorkspaceAuthConfigDocument:
        """Persist a Salesforce workspace auth config.

        Args:
            config: Config document to store.

        Returns:
            Stored config document.
        """
        self.documents[(config.team_id, config.salesforce_org_id)] = config
        return config


class InMemorySalesforceConnectionRepository:
    """In-memory Salesforce connection repository for tests."""

    def __init__(self) -> None:
        """Initialize the in-memory connection store."""
        self.documents: dict[tuple[str, str, str], SalesforceConnectionDocument] = {}

    def get_connection(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        salesforce_org_id: str,
    ) -> SalesforceConnectionDocument | None:
        """Return a stored Salesforce OAuth connection.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            salesforce_org_id: Salesforce org id for the connection.

        Returns:
            Stored connection document, or `None` when absent.
        """
        return self.documents.get((team_id, slack_user_id, salesforce_org_id))

    def list_connections(
        self,
        *,
        team_id: str,
        slack_user_id: str,
    ) -> list[SalesforceConnectionDocument]:
        """Return stored Salesforce OAuth connections for a Slack user.

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
                _org_id,
            ), document in self.documents.items()
            if document_team_id == team_id and document_slack_user_id == slack_user_id
        ]

    def upsert_connection(
        self,
        *,
        connection: SalesforceConnectionDocument,
    ) -> SalesforceConnectionDocument:
        """Persist a Salesforce OAuth connection.

        Args:
            connection: Connection document to store.

        Returns:
            Stored connection document.
        """
        self.documents[
            (
                connection.team_id,
                connection.slack_user_id,
                connection.salesforce_org_id,
            )
        ] = connection
        return connection


class InMemorySalesforceOAuthStateRepository:
    """In-memory Salesforce OAuth state repository for tests."""

    def __init__(self) -> None:
        """Initialize the in-memory state store."""
        self.documents: dict[str, dict[str, SalesforceOAuthStateDocument]] = (
            defaultdict(dict)
        )

    def create_state(
        self,
        *,
        state: SalesforceOAuthStateDocument,
    ) -> SalesforceOAuthStateDocument:
        """Persist a Salesforce OAuth state document.

        Args:
            state: State document to store.

        Returns:
            Stored state document.
        """
        self.documents[state.team_id][state.state_id] = state
        return state

    def get_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> SalesforceOAuthStateDocument | None:
        """Return a stored Salesforce OAuth state document.

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
    ) -> SalesforceOAuthStateDocument | None:
        """Atomically read and delete a stored Salesforce OAuth state document.

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
        """Delete a stored Salesforce OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.
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


class FakeSalesforceOAuthGateway:
    """Configurable fake Salesforce OAuth gateway for service and route tests."""

    def __init__(self) -> None:
        """Initialize the fake gateway."""
        self.exchange_result = SalesforceOAuthTokens(
            access_token="access-token",
            refresh_token="refresh-token",
            granted_scopes=["api", "refresh_token", "id"],
            expires_at=calculate_expiration(expires_in_seconds=7200),
            instance_url="https://instance.salesforce.com",
            identity_url="https://login.salesforce.com/id/00D1/0051",
        )
        self.identity_result = SalesforceIdentity(
            organization_id="00D1",
            user_id="0051",
            username="person@example.com",
            email="person@example.com",
            identity_url="https://login.salesforce.com/id/00D1/0051",
        )
        self.refresh_result = SalesforceOAuthTokens(
            access_token="new-access-token",
            refresh_token=None,
            granted_scopes=["api", "refresh_token", "id"],
            expires_at=calculate_expiration(expires_in_seconds=7200),
            instance_url="https://new-instance.salesforce.com",
        )
        self.refresh_error: Exception | None = None
        self.revoked_tokens: list[str] = []
        self.authorization_calls: list[dict[str, object]] = []
        self.exchange_calls: list[dict[str, object]] = []
        self.closed = False

    def build_authorization_url(
        self,
        *,
        config: SalesforceWorkspaceAuthConfigDocument,
        state_id: str,
        code_challenge: str,
        scopes: list[str],
    ) -> str:
        """Return a deterministic authorization URL.

        Args:
            config: Workspace Salesforce OAuth configuration.
            state_id: OAuth state identifier.
            code_challenge: PKCE code challenge.
            scopes: OAuth scopes requested for the flow.

        Returns:
            Deterministic authorization URL.
        """
        self.authorization_calls.append(
            {
                "config": config,
                "state_id": state_id,
                "code_challenge": code_challenge,
                "scopes": scopes,
            }
        )
        return (
            "https://acme.my.salesforce.com/services/oauth2/authorize"
            f"?state={state_id}&code_challenge={code_challenge}"
        )

    async def exchange_code(
        self,
        *,
        config: SalesforceWorkspaceAuthConfigDocument,
        code: str,
        code_verifier: str,
    ) -> SalesforceOAuthTokens:
        """Return configured token exchange result.

        Args:
            config: Workspace Salesforce OAuth configuration.
            code: Authorization code returned by Salesforce.
            code_verifier: PKCE verifier paired with the flow.

        Returns:
            Configured token exchange result.
        """
        self.exchange_calls.append(
            {"config": config, "code": code, "code_verifier": code_verifier}
        )
        return self.exchange_result

    async def lookup_identity(
        self,
        *,
        identity_url: str,
        access_token: str,
    ) -> SalesforceIdentity:
        """Return configured identity result.

        Args:
            identity_url: Identity URL returned by token exchange.
            access_token: Access token used for identity lookup.

        Returns:
            Configured identity result.
        """
        del identity_url, access_token
        return self.identity_result

    async def refresh_access_token(
        self,
        *,
        config: SalesforceWorkspaceAuthConfigDocument,
        refresh_token: str,
    ) -> SalesforceOAuthTokens:
        """Return configured refresh result or raise a configured error.

        Args:
            config: Workspace Salesforce OAuth configuration.
            refresh_token: Stored refresh token.

        Returns:
            Configured token refresh result.

        Raises:
            Exception: Re-raises the configured refresh error.
        """
        del config, refresh_token
        if self.refresh_error is not None:
            raise self.refresh_error
        return self.refresh_result

    async def revoke_token(
        self,
        *,
        config: SalesforceWorkspaceAuthConfigDocument,
        token: str,
    ) -> None:
        """Record a token revocation request.

        Args:
            config: Workspace Salesforce OAuth configuration.
            token: Token selected for revocation.
        """
        del config
        self.revoked_tokens.append(token)

    async def aclose(self) -> None:
        """Record that the fake gateway was closed."""
        self.closed = True


def build_config() -> SalesforceWorkspaceAuthConfigDocument:
    """Build a Salesforce workspace auth config for tests.

    Returns:
        Salesforce workspace auth config document.
    """
    return SalesforceWorkspaceAuthConfigDocument(
        team_id="T1",
        salesforce_org_id="00D1",
        salesforce_org_name="Acme",
        salesforce_my_domain_host="acme.my.salesforce.com",
        oauth_client_id="client-id",
        redirect_uri="https://example.com/oauth/salesforce/callback",
    )


def build_client() -> tuple[
    TestClient,
    SalesforceAuthCoordinator,
    InMemorySalesforceOAuthStateRepository,
    InMemorySalesforceConnectionRepository,
    FakeSalesforceOAuthGateway,
]:
    """Build a FastAPI test client with a wired Salesforce OAuth router.

    Returns:
        Tuple of test client and its core fake collaborators.
    """
    config_repository = InMemorySalesforceAuthConfigRepository()
    config_repository.upsert_config(config=build_config())
    state_repository = InMemorySalesforceOAuthStateRepository()
    connection_repository = InMemorySalesforceConnectionRepository()
    gateway = FakeSalesforceOAuthGateway()
    coordinator = SalesforceAuthCoordinator(
        config_repository=config_repository,
        connection_repository=connection_repository,
        state_repository=state_repository,
        gateway=gateway,
        context_signer=SalesforceOAuthContextSigner(secret="test-signing-secret"),
        token_cipher=PlaintextTokenCipher(),
    )
    app = FastAPI()
    app.include_router(create_salesforce_auth_router(coordinator))
    return (
        TestClient(app),
        coordinator,
        state_repository,
        connection_repository,
        gateway,
    )


def decode_state_token(
    coordinator: SalesforceAuthCoordinator,
    public_state: str,
) -> SalesforceOAuthStateToken:
    """Decode an opaque public callback state token for assertions.

    Args:
        coordinator: Coordinator whose signer issued the public state token.
        public_state: Opaque callback `state` token from the authorization URL.

    Returns:
        Decoded OAuth state token payload.
    """
    return coordinator._context_signer.loads_state_token(public_state)


def test_salesforce_oauth_start_redirects_and_persists_pkce_state() -> None:
    """Verify start redirects to Salesforce and stores encrypted PKCE state."""
    client, coordinator, state_repository, _connections, gateway = build_client()
    context = coordinator.issue_start_context(
        team_id="T1",
        slack_user_id="U1",
        salesforce_org_id="00D1",
        redirect_after_connect="/after",
    )

    response = client.get(
        "/oauth/salesforce/start",
        params={"context": context},
        follow_redirects=False,
    )

    assert response.status_code == 303
    parsed = urlparse(response.headers["location"])
    query = parse_qs(parsed.query)
    state_reference = decode_state_token(coordinator, query["state"][0])
    stored_state = state_repository.get_state(
        team_id="T1",
        state_id=state_reference.state_id,
    )
    assert parsed.netloc == "acme.my.salesforce.com"
    assert stored_state is not None
    assert stored_state.slack_user_id == "U1"
    assert stored_state.salesforce_org_id == "00D1"
    assert stored_state.redirect_after_connect == "/after"
    assert stored_state.pkce_code_verifier_encrypted.startswith("enc:")
    assert gateway.authorization_calls[0]["scopes"] == ["api", "refresh_token", "id"]


def test_salesforce_oauth_callback_persists_connection_and_consumes_state() -> None:
    """Verify a successful callback stores the connection and deletes state."""
    client, coordinator, state_repository, connection_repository, gateway = (
        build_client()
    )
    context = coordinator.issue_start_context(
        team_id="T1",
        slack_user_id="U1",
        salesforce_org_id="00D1",
        redirect_after_connect="/app",
    )
    start_response = client.get(
        "/oauth/salesforce/start",
        params={"context": context},
        follow_redirects=False,
    )
    public_state = parse_qs(urlparse(start_response.headers["location"]).query)[
        "state"
    ][0]
    state_reference = decode_state_token(coordinator, public_state)

    callback_response = client.get(
        "/oauth/salesforce/callback",
        params={"state": public_state, "code": "auth-code"},
        follow_redirects=False,
    )

    assert callback_response.status_code == 303
    assert (
        callback_response.headers["location"] == "/app?salesforce_oauth_status=success"
    )
    assert gateway.exchange_calls[0]["code"] == "auth-code"
    stored_connection = connection_repository.get_connection(
        team_id="T1",
        slack_user_id="U1",
        salesforce_org_id="00D1",
    )
    assert stored_connection is not None
    assert stored_connection.salesforce_user_id == "0051"
    assert stored_connection.salesforce_username == "person@example.com"
    assert stored_connection.access_token_encrypted == "enc:access-token"
    assert stored_connection.refresh_token_encrypted == "enc:refresh-token"
    assert (
        state_repository.get_state(
            team_id="T1",
            state_id=state_reference.state_id,
        )
        is None
    )


@pytest.mark.asyncio
async def test_salesforce_refresh_success_updates_token_fields() -> None:
    """Verify refresh success updates tokens and clears previous errors."""
    _client, coordinator, _states, connection_repository, _gateway = build_client()
    connection_repository.upsert_connection(
        connection=SalesforceConnectionDocument(
            team_id="T1",
            slack_user_id="U1",
            salesforce_org_id="00D1",
            salesforce_user_id="0051",
            access_token_encrypted="enc:old-access-token",
            refresh_token_encrypted="enc:old-refresh-token",
            last_refresh_error_code="invalid_grant",
        )
    )

    refreshed = await coordinator.refresh_connection(
        team_id="T1",
        slack_user_id="U1",
        salesforce_org_id="00D1",
    )

    assert refreshed.connection_status == SalesforceConnectionStatus.ACTIVE
    assert refreshed.access_token_encrypted == "enc:new-access-token"
    assert refreshed.refresh_token_encrypted == "enc:old-refresh-token"
    assert refreshed.salesforce_instance_url == "https://new-instance.salesforce.com"
    assert refreshed.last_refresh_error_code is None


@pytest.mark.asyncio
async def test_salesforce_refresh_invalid_grant_marks_connection_expired() -> None:
    """Verify non-retriable invalid grant refresh failures expire the connection."""
    _client, coordinator, _states, connection_repository, gateway = build_client()
    gateway.refresh_error = SalesforceOAuthGatewayError(
        "Salesforce OAuth request failed: expired refresh token",
        error_code="invalid_grant",
    )
    connection_repository.upsert_connection(
        connection=SalesforceConnectionDocument(
            team_id="T1",
            slack_user_id="U1",
            salesforce_org_id="00D1",
            salesforce_user_id="0051",
            access_token_encrypted="enc:old-access-token",
            refresh_token_encrypted="enc:old-refresh-token",
        )
    )

    with pytest.raises(SalesforceOAuthFlowError) as exc_info:
        await coordinator.refresh_connection(
            team_id="T1",
            slack_user_id="U1",
            salesforce_org_id="00D1",
        )

    stored_connection = connection_repository.get_connection(
        team_id="T1",
        slack_user_id="U1",
        salesforce_org_id="00D1",
    )
    assert exc_info.value.code == "invalid_grant"
    assert stored_connection is not None
    assert stored_connection.connection_status == SalesforceConnectionStatus.EXPIRED
    assert stored_connection.last_refresh_error_code == "invalid_grant"


def test_salesforce_disconnect_revokes_refresh_token_and_clears_tokens() -> None:
    """Verify disconnect revokes the refresh token and clears local secrets."""
    client, coordinator, _states, connection_repository, gateway = build_client()
    connection_repository.upsert_connection(
        connection=SalesforceConnectionDocument(
            team_id="T1",
            slack_user_id="U1",
            salesforce_org_id="00D1",
            salesforce_user_id="0051",
            access_token_encrypted="enc:access-token",
            refresh_token_encrypted="enc:refresh-token",
        )
    )
    context = coordinator.issue_start_context(
        team_id="T1",
        slack_user_id="U1",
        salesforce_org_id="00D1",
    )

    response = client.post(
        "/oauth/salesforce/disconnect",
        json={"context": context},
    )

    stored_connection = connection_repository.get_connection(
        team_id="T1",
        slack_user_id="U1",
        salesforce_org_id="00D1",
    )
    assert response.status_code == 200
    assert response.json()["status"] == "revoked"
    assert gateway.revoked_tokens == ["refresh-token"]
    assert stored_connection is not None
    assert stored_connection.connection_status == SalesforceConnectionStatus.REVOKED
    assert stored_connection.access_token_encrypted is None
    assert stored_connection.refresh_token_encrypted is None


def test_salesforce_oauth_start_rejects_expired_context() -> None:
    """Verify the start route rejects signed context tokens past their expiry."""
    client, coordinator, _states, _connections, _gateway = build_client()
    context = coordinator.issue_start_context(
        team_id="T1",
        slack_user_id="U1",
        salesforce_org_id="00D1",
        ttl=timedelta(seconds=-1),
    )

    response = client.get("/oauth/salesforce/start", params={"context": context})

    assert response.status_code == 400
    assert response.json()["detail"] == "Expired Salesforce OAuth context token"
