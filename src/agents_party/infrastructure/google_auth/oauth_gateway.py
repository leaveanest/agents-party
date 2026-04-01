"""HTTP-backed Google OAuth gateway implementation."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlencode

import httpx
from google.auth.exceptions import TransportError
from google.auth.transport.requests import Request
from google.oauth2 import id_token as google_id_token

from agents_party.domain.google_auth import (
    GoogleIdentityClaims,
    GoogleOAuthTokens,
    calculate_expiration,
)


class GoogleOAuthGatewayError(RuntimeError):
    """Raised when the Google OAuth gateway cannot complete a request."""

    def __init__(
        self,
        message: str,
        *,
        error_code: str | None = None,
        retriable: bool = False,
    ) -> None:
        """Initialize the Google OAuth gateway error.

        Args:
            message: Human-readable failure message.
            error_code: Optional OAuth error code returned by Google.
            retriable: Whether the caller may retry the failed operation.

        Returns:
            None.
        """
        super().__init__(message)
        self.error_code = error_code
        self.retriable = retriable


class HttpxGoogleOAuthGateway:
    """Google OAuth gateway backed by HTTPX and `google-auth`."""

    _AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
    _TOKEN_URL = "https://oauth2.googleapis.com/token"
    _REVOKE_URL = "https://oauth2.googleapis.com/revoke"

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        """Initialize the Google OAuth gateway.

        Args:
            client_id: Google OAuth web client id.
            client_secret: Google OAuth web client secret.
            http_client: Optional injected HTTPX async client for tests.

        Returns:
            None.
        """
        self._client_id = client_id
        self._client_secret = client_secret
        self._http_client = http_client or httpx.AsyncClient(timeout=10.0)

    def build_authorization_url(
        self,
        *,
        state_id: str,
        redirect_uri: str,
        scopes: list[str],
    ) -> str:
        """Return the Google authorization URL for a pending OAuth flow.

        Args:
            state_id: Server-generated OAuth state identifier.
            redirect_uri: Callback URI registered for the web client.
            scopes: OAuth scopes requested for the flow.

        Returns:
            Fully-qualified authorization URL.
        """
        query = urlencode(
            {
                "client_id": self._client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": " ".join(scopes),
                "state": state_id,
                "access_type": "offline",
                "include_granted_scopes": "true",
                "prompt": "consent",
            }
        )
        return f"{self._AUTHORIZE_URL}?{query}"

    async def exchange_code(
        self,
        *,
        code: str,
        redirect_uri: str,
    ) -> GoogleOAuthTokens:
        """Exchange an authorization code for Google OAuth tokens.

        Args:
            code: Authorization code returned by Google.
            redirect_uri: Callback URI registered for the web client.

        Returns:
            Normalized OAuth token bundle.
        """
        response = await self._post(
            self._TOKEN_URL,
            operation="token exchange",
            data={
                "code": code,
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        payload = await self._parse_json_response(response)
        return self._build_tokens(payload)

    async def refresh_access_token(
        self,
        *,
        refresh_token: str,
    ) -> GoogleOAuthTokens:
        """Refresh Google OAuth tokens for an existing connection.

        Args:
            refresh_token: Stored Google refresh token.

        Returns:
            Normalized OAuth token bundle.
        """
        response = await self._post(
            self._TOKEN_URL,
            operation="token refresh",
            data={
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )
        payload = await self._parse_json_response(response)
        return self._build_tokens(payload)

    async def revoke_token(
        self,
        *,
        token: str,
    ) -> None:
        """Revoke a Google OAuth access or refresh token.

        Args:
            token: Google OAuth token to revoke.

        Returns:
            None.
        """
        response = await self._post(
            self._REVOKE_URL,
            operation="token revocation",
            params={"token": token},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if response.status_code == 200:
            return
        payload = self._safe_json(response)
        error_code = self._extract_error_code(payload)
        raise GoogleOAuthGatewayError(
            "Google token revocation failed",
            error_code=error_code,
            retriable=response.status_code >= 500,
        )

    async def verify_id_token(
        self,
        *,
        id_token: str,
    ) -> GoogleIdentityClaims:
        """Verify a Google ID token and return stable identity claims.

        Args:
            id_token: Google ID token to verify.

        Returns:
            Verified identity claims.
        """
        try:
            claims = await asyncio.to_thread(
                self._verify_oauth2_token_sync,
                id_token,
            )
        except TransportError as exc:
            raise GoogleOAuthGatewayError(
                "Google ID token verification request failed",
                error_code="transport_error",
                retriable=True,
            ) from exc
        except Exception as exc:  # pragma: no cover - google-auth exception types vary.
            raise GoogleOAuthGatewayError(
                "Google ID token verification failed",
                error_code="invalid_id_token",
            ) from exc
        return GoogleIdentityClaims(
            subject=str(claims["sub"]),
            email=str(claims["email"]) if "email" in claims else None,
            email_verified=bool(claims.get("email_verified", False)),
        )

    async def aclose(self) -> None:
        """Close the owned HTTP client and release network resources.

        Returns:
            None.
        """
        await self._http_client.aclose()

    def _verify_oauth2_token_sync(self, id_token: str) -> Mapping[str, Any]:
        """Verify a Google ID token in a synchronous worker context.

        Args:
            id_token: Google ID token to verify.

        Returns:
            Raw verified claim mapping returned by `google-auth`.
        """
        return google_id_token.verify_oauth2_token(
            id_token,
            Request(),
            audience=self._client_id,
        )

    async def _parse_json_response(
        self,
        response: httpx.Response,
    ) -> Mapping[str, Any]:
        """Parse a Google OAuth JSON response and raise typed errors.

        Args:
            response: HTTPX response received from Google.

        Returns:
            Decoded JSON mapping payload.

        Raises:
            GoogleOAuthGatewayError: If the response is not successful JSON.
        """
        payload = self._safe_json(response)
        if response.is_success:
            return payload
        error_code = self._extract_error_code(payload)
        error_description = self._extract_error_description(payload)
        message = "Google OAuth request failed"
        if error_description:
            message = f"{message}: {error_description}"
        raise GoogleOAuthGatewayError(
            message,
            error_code=error_code,
            retriable=response.status_code >= 500,
        )

    async def _post(
        self,
        url: str,
        *,
        operation: str,
        data: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> httpx.Response:
        """Execute an HTTP POST and normalize transport failures.

        Args:
            url: Target URL for the outbound HTTP request.
            operation: Short operation name used in error messages.
            data: Optional form payload sent in the request body.
            params: Optional query parameters sent with the request.
            headers: Optional HTTP headers sent with the request.

        Returns:
            HTTPX response returned by the remote server.

        Raises:
            GoogleOAuthGatewayError: If the HTTP transport fails before a response
                is received.
        """
        try:
            return await self._http_client.post(
                url,
                data=data,
                params=params,
                headers=headers,
            )
        except httpx.HTTPError as exc:
            raise GoogleOAuthGatewayError(
                f"Google OAuth {operation} request failed",
                error_code="transport_error",
                retriable=True,
            ) from exc

    def _build_tokens(self, payload: Mapping[str, Any]) -> GoogleOAuthTokens:
        """Normalize a token response payload from Google.

        Args:
            payload: JSON payload returned by Google's token endpoint.

        Returns:
            Normalized OAuth token bundle.

        Raises:
            GoogleOAuthGatewayError: If the response is missing required fields.
        """
        access_token = payload.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise GoogleOAuthGatewayError(
                "Google OAuth token response did not include an access token",
                error_code="invalid_token_response",
            )
        scopes = str(payload.get("scope", "")).split()
        refresh_token = payload.get("refresh_token")
        id_token = payload.get("id_token")
        refresh_token_expires_in = payload.get("refresh_token_expires_in")
        return GoogleOAuthTokens(
            access_token=access_token,
            refresh_token=refresh_token if isinstance(refresh_token, str) else None,
            id_token=id_token if isinstance(id_token, str) else None,
            granted_scopes=scopes,
            expires_at=calculate_expiration(
                expires_in_seconds=self._as_int(payload.get("expires_in"))
            ),
            refresh_token_expires_at=calculate_expiration(
                expires_in_seconds=self._as_int(refresh_token_expires_in)
            ),
        )

    def _safe_json(self, response: httpx.Response) -> Mapping[str, Any]:
        """Return a JSON mapping response payload when possible.

        Args:
            response: HTTPX response received from Google.

        Returns:
            JSON mapping payload, or an empty mapping when parsing fails.
        """
        try:
            payload = response.json()
        except ValueError:
            return {}
        return payload if isinstance(payload, dict) else {}

    def _extract_error_code(self, payload: Mapping[str, Any]) -> str | None:
        """Extract an OAuth error code from a Google response payload.

        Args:
            payload: Google OAuth response payload.

        Returns:
            OAuth error code when present.
        """
        error_value = payload.get("error")
        return str(error_value) if isinstance(error_value, str) else None

    def _extract_error_description(self, payload: Mapping[str, Any]) -> str | None:
        """Extract an OAuth error description from a Google response payload.

        Args:
            payload: Google OAuth response payload.

        Returns:
            OAuth error description when present.
        """
        description = payload.get("error_description")
        return str(description) if isinstance(description, str) else None

    def _as_int(self, value: Any) -> int | None:
        """Coerce a JSON scalar into an integer when possible.

        Args:
            value: JSON value to coerce.

        Returns:
            Integer value when coercion succeeds, else `None`.
        """
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None


__all__ = ["GoogleOAuthGatewayError", "HttpxGoogleOAuthGateway"]
