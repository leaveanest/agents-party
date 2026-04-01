from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest
from google.auth.exceptions import TransportError

from agents_party.infrastructure.google_auth import (
    GoogleOAuthGatewayError,
    HttpxGoogleOAuthGateway,
)
from agents_party.infrastructure.google_auth import (
    oauth_gateway as oauth_gateway_module,
)


class FakeAsyncClient:
    """Stub async client for Google OAuth gateway transport tests."""

    def __init__(
        self,
        *,
        response: httpx.Response | None = None,
        error: Exception | None = None,
    ) -> None:
        """Initialize the stub async client.

        Args:
            response: Optional HTTP response returned by `post`.
            error: Optional exception raised by `post`.

        Returns:
            None.
        """
        self.response = response
        self.error = error
        self.calls: list[dict[str, object]] = []

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
        self.calls.append({"url": url, **kwargs})
        if self.error is not None:
            raise self.error
        assert self.response is not None
        return self.response


@pytest.mark.asyncio
async def test_exchange_code_wraps_httpx_transport_failures() -> None:
    """Verify token exchange wraps transport failures in a typed gateway error.

    Returns:
        None.
    """
    request = httpx.Request("POST", "https://oauth2.googleapis.com/token")
    gateway = HttpxGoogleOAuthGateway(
        client_id="client-id",
        client_secret="client-secret",
        http_client=FakeAsyncClient(
            error=httpx.ReadTimeout("timed out", request=request)
        ),  # type: ignore[arg-type]
    )

    with pytest.raises(GoogleOAuthGatewayError) as exc_info:
        await gateway.exchange_code(
            code="auth-code",
            redirect_uri="https://example.com/oauth/google/callback",
        )

    assert str(exc_info.value) == "Google OAuth token exchange request failed"
    assert exc_info.value.error_code == "transport_error"
    assert exc_info.value.retriable is True


@pytest.mark.asyncio
async def test_revoke_token_wraps_httpx_transport_failures() -> None:
    """Verify token revocation wraps transport failures in a typed gateway error.

    Returns:
        None.
    """
    request = httpx.Request("POST", "https://oauth2.googleapis.com/revoke")
    gateway = HttpxGoogleOAuthGateway(
        client_id="client-id",
        client_secret="client-secret",
        http_client=FakeAsyncClient(
            error=httpx.ConnectError("connect failed", request=request)
        ),  # type: ignore[arg-type]
    )

    with pytest.raises(GoogleOAuthGatewayError) as exc_info:
        await gateway.revoke_token(token="refresh-token")

    assert str(exc_info.value) == "Google OAuth token revocation request failed"
    assert exc_info.value.error_code == "transport_error"
    assert exc_info.value.retriable is True


@pytest.mark.asyncio
async def test_verify_id_token_wraps_google_auth_transport_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify cert-fetch transport failures remain retriable gateway errors.

    Args:
        monkeypatch: Pytest helper for temporarily patching module attributes.

    Returns:
        None.
    """

    def raise_transport_error(*args: object, **kwargs: object) -> object:
        del args, kwargs
        raise TransportError("certificate fetch failed")

    monkeypatch.setattr(
        oauth_gateway_module.google_id_token,
        "verify_oauth2_token",
        raise_transport_error,
    )
    gateway = HttpxGoogleOAuthGateway(
        client_id="client-id",
        client_secret="client-secret",
        http_client=FakeAsyncClient(
            response=httpx.Response(
                200, request=httpx.Request("POST", "https://unused")
            )
        ),  # type: ignore[arg-type]
    )

    with pytest.raises(GoogleOAuthGatewayError) as exc_info:
        await gateway.verify_id_token(id_token="id-token")

    assert str(exc_info.value) == "Google ID token verification request failed"
    assert exc_info.value.error_code == "transport_error"
    assert exc_info.value.retriable is True


@pytest.mark.asyncio
async def test_verify_id_token_offloads_blocking_verification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify ID token verification is executed through the async thread offload.

    Args:
        monkeypatch: Pytest helper for temporarily patching module attributes.

    Returns:
        None.
    """
    calls: list[str] = []

    async def fake_to_thread(
        function: Callable[..., object], *args: object, **kwargs: object
    ) -> object:
        del kwargs
        calls.append("to_thread")
        return function(*args)

    def fake_verify_oauth2_token(*args: object, **kwargs: object) -> object:
        del args, kwargs
        calls.append("verify")
        return {
            "sub": "google-subject",
            "email": "person@example.com",
            "email_verified": True,
        }

    monkeypatch.setattr(oauth_gateway_module.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(
        oauth_gateway_module.google_id_token,
        "verify_oauth2_token",
        fake_verify_oauth2_token,
    )
    gateway = HttpxGoogleOAuthGateway(
        client_id="client-id",
        client_secret="client-secret",
        http_client=FakeAsyncClient(
            response=httpx.Response(
                200, request=httpx.Request("POST", "https://unused")
            )
        ),  # type: ignore[arg-type]
    )

    claims = await gateway.verify_id_token(id_token="id-token")

    assert calls == ["to_thread", "verify"]
    assert claims.subject == "google-subject"
