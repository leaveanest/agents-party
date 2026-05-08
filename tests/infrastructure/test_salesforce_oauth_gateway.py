from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from agents_party.domain.salesforce_auth import SalesforceWorkspaceAuthConfigDocument
from agents_party.infrastructure.salesforce import (
    HttpxSalesforceOAuthGateway,
    SalesforceOAuthGatewayError,
)


class FakeAsyncClient:
    """Stub async client for Salesforce OAuth gateway transport tests."""

    def __init__(
        self,
        *,
        responses: list[httpx.Response] | None = None,
        error: Exception | None = None,
    ) -> None:
        """Initialize the stub async client.

        Args:
            responses: Optional HTTP responses returned by requests.
            error: Optional exception raised by requests.
        """
        self.responses = responses or []
        self.error = error
        self.calls: list[dict[str, object]] = []
        self.closed = False

    async def post(self, url: str, **kwargs: object) -> httpx.Response:
        """Record a POST request and return the configured outcome.

        Args:
            url: Target URL for the outbound request.
            **kwargs: Additional keyword arguments forwarded by the gateway.

        Returns:
            Configured HTTP response.

        Raises:
            Exception: Re-raises the configured client error.
        """
        self.calls.append({"method": "POST", "url": url, **kwargs})
        if self.error is not None:
            raise self.error
        return self.responses.pop(0)

    async def get(self, url: str, **kwargs: object) -> httpx.Response:
        """Record a GET request and return the configured outcome.

        Args:
            url: Target URL for the outbound request.
            **kwargs: Additional keyword arguments forwarded by the gateway.

        Returns:
            Configured HTTP response.

        Raises:
            Exception: Re-raises the configured client error.
        """
        self.calls.append({"method": "GET", "url": url, **kwargs})
        if self.error is not None:
            raise self.error
        return self.responses.pop(0)

    async def aclose(self) -> None:
        """Record that the fake client was closed."""
        self.closed = True


def build_config() -> SalesforceWorkspaceAuthConfigDocument:
    """Build a Salesforce OAuth config for gateway tests.

    Returns:
        Salesforce workspace auth config document.
    """
    return SalesforceWorkspaceAuthConfigDocument(
        team_id="T1",
        salesforce_org_id="00D1",
        salesforce_my_domain_host="https://acme.my.salesforce.com/setup",
        oauth_client_id="client-id",
        redirect_uri="https://example.com/oauth/salesforce/callback",
    )


def test_build_authorization_url_uses_my_domain_and_pkce() -> None:
    """Verify authorization URLs use the configured My Domain and PKCE params."""
    gateway = HttpxSalesforceOAuthGateway(http_client=FakeAsyncClient())

    url = gateway.build_authorization_url(
        config=build_config(),
        state_id="state-token",
        code_challenge="challenge",
        scopes=["api", "refresh_token", "id"],
    )

    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    assert parsed.netloc == "acme.my.salesforce.com"
    assert parsed.path == "/services/oauth2/authorize"
    assert query["client_id"] == ["client-id"]
    assert query["response_type"] == ["code"]
    assert query["code_challenge"] == ["challenge"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["scope"] == ["api refresh_token id"]


def test_rejects_non_salesforce_oauth_hosts() -> None:
    """Verify workspace configs cannot route OAuth secrets to arbitrary hosts."""
    with pytest.raises(ValueError, match="Salesforce domain"):
        SalesforceWorkspaceAuthConfigDocument(
            team_id="T1",
            salesforce_org_id="00D1",
            salesforce_my_domain_host="https://example.com",
            oauth_client_id="client-id",
            redirect_uri="https://example.com/oauth/salesforce/callback",
        )


@pytest.mark.asyncio
async def test_exchange_code_posts_pkce_form_and_normalizes_tokens() -> None:
    """Verify token exchange sends PKCE data and parses Salesforce tokens."""
    request = httpx.Request(
        "POST",
        "https://acme.my.salesforce.com/services/oauth2/token",
    )
    client = FakeAsyncClient(
        responses=[
            httpx.Response(
                200,
                json={
                    "access_token": "access-token",
                    "refresh_token": "refresh-token",
                    "scope": "api refresh_token id",
                    "instance_url": "https://instance.salesforce.com",
                    "id": "https://login.salesforce.com/id/00D1/0051",
                    "expires_in": 7200,
                },
                request=request,
            )
        ]
    )
    gateway = HttpxSalesforceOAuthGateway(http_client=client)

    tokens = await gateway.exchange_code(
        config=build_config(),
        code="auth-code",
        code_verifier="verifier",
    )

    assert tokens.access_token == "access-token"
    assert tokens.refresh_token == "refresh-token"
    assert tokens.granted_scopes == ["api", "refresh_token", "id"]
    assert tokens.instance_url == "https://instance.salesforce.com"
    assert tokens.identity_url == "https://login.salesforce.com/id/00D1/0051"
    assert client.calls[0]["url"] == (
        "https://acme.my.salesforce.com/services/oauth2/token"
    )
    assert client.calls[0]["data"] == {
        "client_id": "client-id",
        "code": "auth-code",
        "redirect_uri": "https://example.com/oauth/salesforce/callback",
        "grant_type": "authorization_code",
        "code_verifier": "verifier",
    }


@pytest.mark.asyncio
async def test_lookup_identity_sends_bearer_token_and_normalizes_identity() -> None:
    """Verify identity lookup sends bearer auth and parses stable identifiers."""
    request = httpx.Request("GET", "https://login.salesforce.com/id/00D1/0051")
    client = FakeAsyncClient(
        responses=[
            httpx.Response(
                200,
                json={
                    "organization_id": "00D1",
                    "user_id": "0051",
                    "username": "person@example.com",
                    "email": "person@example.com",
                },
                request=request,
            )
        ]
    )
    gateway = HttpxSalesforceOAuthGateway(http_client=client)

    identity = await gateway.lookup_identity(
        identity_url="https://login.salesforce.com/id/00D1/0051",
        access_token="access-token",
    )

    assert identity.organization_id == "00D1"
    assert identity.user_id == "0051"
    assert client.calls[0]["headers"] == {"Authorization": "Bearer access-token"}


@pytest.mark.asyncio
async def test_lookup_identity_rejects_non_salesforce_identity_url() -> None:
    """Verify bearer tokens are not sent to non-Salesforce identity URLs."""
    client = FakeAsyncClient()
    gateway = HttpxSalesforceOAuthGateway(http_client=client)

    with pytest.raises(SalesforceOAuthGatewayError) as exc_info:
        await gateway.lookup_identity(
            identity_url="https://example.com/id/00D1/0051",
            access_token="access-token",
        )

    assert exc_info.value.error_code == "invalid_identity_url"
    assert client.calls == []


@pytest.mark.asyncio
async def test_exchange_code_rejects_non_salesforce_identity_url() -> None:
    """Verify unsafe identity URLs from token responses are rejected."""
    request = httpx.Request(
        "POST",
        "https://acme.my.salesforce.com/services/oauth2/token",
    )
    gateway = HttpxSalesforceOAuthGateway(
        http_client=FakeAsyncClient(
            responses=[
                httpx.Response(
                    200,
                    json={
                        "access_token": "access-token",
                        "scope": "api refresh_token id",
                        "id": "https://example.com/id/00D1/0051",
                    },
                    request=request,
                )
            ]
        )
    )

    with pytest.raises(SalesforceOAuthGatewayError) as exc_info:
        await gateway.exchange_code(
            config=build_config(),
            code="auth-code",
            code_verifier="verifier",
        )

    assert exc_info.value.error_code == "invalid_salesforce_url"


@pytest.mark.asyncio
async def test_refresh_wraps_salesforce_errors_with_retriable_flag() -> None:
    """Verify Salesforce token errors surface as typed gateway errors."""
    request = httpx.Request(
        "POST",
        "https://acme.my.salesforce.com/services/oauth2/token",
    )
    gateway = HttpxSalesforceOAuthGateway(
        http_client=FakeAsyncClient(
            responses=[
                httpx.Response(
                    503,
                    json={
                        "error": "temporarily_unavailable",
                        "error_description": "try again",
                    },
                    request=request,
                )
            ]
        )
    )

    with pytest.raises(SalesforceOAuthGatewayError) as exc_info:
        await gateway.refresh_access_token(
            config=build_config(),
            refresh_token="refresh-token",
        )

    assert str(exc_info.value) == "Salesforce OAuth request failed: try again"
    assert exc_info.value.error_code == "temporarily_unavailable"
    assert exc_info.value.retriable is True


@pytest.mark.asyncio
async def test_revoke_token_posts_token_to_revoke_endpoint() -> None:
    """Verify revocation posts the token to Salesforce's revoke endpoint."""
    request = httpx.Request(
        "POST",
        "https://acme.my.salesforce.com/services/oauth2/revoke",
    )
    client = FakeAsyncClient(
        responses=[httpx.Response(200, request=request)],
    )
    gateway = HttpxSalesforceOAuthGateway(http_client=client)

    await gateway.revoke_token(config=build_config(), token="refresh-token")

    assert client.calls[0]["url"] == (
        "https://acme.my.salesforce.com/services/oauth2/revoke"
    )
    assert client.calls[0]["data"] == {
        "client_id": "client-id",
        "token": "refresh-token",
    }


@pytest.mark.asyncio
async def test_exchange_code_wraps_httpx_transport_failures() -> None:
    """Verify token exchange wraps transport failures in a typed gateway error."""
    request = httpx.Request(
        "POST",
        "https://acme.my.salesforce.com/services/oauth2/token",
    )
    gateway = HttpxSalesforceOAuthGateway(
        http_client=FakeAsyncClient(
            error=httpx.ReadTimeout("timed out", request=request)
        )
    )

    with pytest.raises(SalesforceOAuthGatewayError) as exc_info:
        await gateway.exchange_code(
            config=build_config(),
            code="auth-code",
            code_verifier="verifier",
        )

    assert str(exc_info.value) == "Salesforce OAuth token exchange request failed"
    assert exc_info.value.error_code == "transport_error"
    assert exc_info.value.retriable is True
