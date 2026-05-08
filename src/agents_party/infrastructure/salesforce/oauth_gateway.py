"""HTTP-backed Salesforce OAuth gateway implementation."""

from __future__ import annotations

from collections.abc import Mapping
import hashlib
import base64
from typing import Any, Protocol
from urllib.parse import urlencode, urlsplit

import httpx

from agents_party.domain.salesforce_auth import (
    SalesforceIdentity,
    SalesforceOAuthTokens,
    SalesforceWorkspaceAuthConfigDocument,
    calculate_expiration,
    is_salesforce_host,
)
from agents_party.infrastructure.salesforce.token_cipher import (
    SalesforceTokenCipherError,
)


class SalesforceOAuthGatewayError(RuntimeError):
    """Raised when the Salesforce OAuth gateway cannot complete a request."""

    def __init__(
        self,
        message: str,
        *,
        error_code: str | None = None,
        retriable: bool = False,
    ) -> None:
        """Initialize the Salesforce OAuth gateway error.

        Args:
            message: Human-readable failure message.
            error_code: Optional OAuth error code returned by Salesforce.
            retriable: Whether the caller may retry the failed operation.
        """
        super().__init__(message)
        self.error_code = error_code
        self.retriable = retriable


class AsyncSalesforceHttpTransport(Protocol):
    """Minimal async HTTP transport used by the Salesforce OAuth gateway."""

    async def post(self, url: str, **kwargs: object) -> httpx.Response:
        """Execute an HTTP POST request.

        Args:
            url: Target URL for the outbound request.
            **kwargs: Transport-specific request arguments.

        Returns:
            HTTP response returned by the remote server.
        """

        ...

    async def get(self, url: str, **kwargs: object) -> httpx.Response:
        """Execute an HTTP GET request.

        Args:
            url: Target URL for the outbound request.
            **kwargs: Transport-specific request arguments.

        Returns:
            HTTP response returned by the remote server.
        """

        ...

    async def aclose(self) -> None:
        """Release resources held by the transport.

        Returns:
            None.
        """

        ...


class SalesforceSecretCipher(Protocol):
    """Protocol for decrypting stored Salesforce client secrets."""

    def decrypt(self, value: str) -> str:
        """Decrypt an encrypted secret string.

        Args:
            value: Encrypted secret string.

        Returns:
            Decrypted plaintext secret.
        """

        ...


class HttpxSalesforceOAuthGateway:
    """Salesforce OAuth gateway backed by an injectable async HTTP transport."""

    def __init__(
        self,
        *,
        http_client: AsyncSalesforceHttpTransport | None = None,
        client_secret_cipher: SalesforceSecretCipher | None = None,
    ) -> None:
        """Initialize the Salesforce OAuth gateway.

        Args:
            http_client: Optional injected async HTTP transport for tests.
            client_secret_cipher: Optional helper for encrypted client secrets.
        """
        self._http_client = http_client or httpx.AsyncClient(timeout=10.0)
        self._client_secret_cipher = client_secret_cipher

    def build_authorization_url(
        self,
        *,
        config: SalesforceWorkspaceAuthConfigDocument,
        state_id: str,
        code_challenge: str,
        scopes: list[str],
    ) -> str:
        """Return the Salesforce authorization URL for a pending OAuth flow.

        Args:
            config: Workspace Salesforce OAuth configuration.
            state_id: Server-generated OAuth state identifier.
            code_challenge: PKCE S256 code challenge.
            scopes: OAuth scopes requested for the flow.

        Returns:
            Fully-qualified authorization URL.
        """
        query = urlencode(
            {
                "client_id": config.oauth_client_id,
                "redirect_uri": config.redirect_uri,
                "response_type": "code",
                "scope": " ".join(scopes),
                "state": state_id,
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
            }
        )
        return f"{self._oauth_base_url(config)}/authorize?{query}"

    async def exchange_code(
        self,
        *,
        config: SalesforceWorkspaceAuthConfigDocument,
        code: str,
        code_verifier: str,
    ) -> SalesforceOAuthTokens:
        """Exchange an authorization code for Salesforce OAuth tokens.

        Args:
            config: Workspace Salesforce OAuth configuration.
            code: Authorization code returned by Salesforce.
            code_verifier: PKCE verifier paired with the authorization request.

        Returns:
            Normalized OAuth token bundle.
        """
        data = self._base_token_data(config)
        data.update(
            {
                "code": code,
                "redirect_uri": config.redirect_uri,
                "grant_type": "authorization_code",
                "code_verifier": code_verifier,
            }
        )
        response = await self._post(
            f"{self._oauth_base_url(config)}/token",
            operation="token exchange",
            data=data,
        )
        payload = self._parse_json_response(response)
        return self._build_tokens(payload)

    async def lookup_identity(
        self,
        *,
        identity_url: str,
        access_token: str,
    ) -> SalesforceIdentity:
        """Look up the Salesforce identity for an access token.

        Args:
            identity_url: Identity URL returned by the Salesforce token endpoint.
            access_token: Salesforce access token used for the identity request.

        Returns:
            Normalized Salesforce identity information.
        """
        identity_url = self._validated_salesforce_url(
            identity_url,
            error_code="invalid_identity_url",
        )
        try:
            response = await self._http_client.get(
                identity_url,
                headers={"Authorization": f"Bearer {access_token}"},
            )
        except httpx.HTTPError as exc:
            raise SalesforceOAuthGatewayError(
                "Salesforce OAuth identity lookup request failed",
                error_code="transport_error",
                retriable=True,
            ) from exc
        payload = self._parse_json_response(response)
        return self._build_identity(payload, identity_url=identity_url)

    async def refresh_access_token(
        self,
        *,
        config: SalesforceWorkspaceAuthConfigDocument,
        refresh_token: str,
    ) -> SalesforceOAuthTokens:
        """Refresh Salesforce OAuth tokens for an existing connection.

        Args:
            config: Workspace Salesforce OAuth configuration.
            refresh_token: Stored Salesforce refresh token.

        Returns:
            Normalized OAuth token bundle.
        """
        data = self._base_token_data(config)
        data.update(
            {
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            }
        )
        response = await self._post(
            f"{self._oauth_base_url(config)}/token",
            operation="token refresh",
            data=data,
        )
        payload = self._parse_json_response(response)
        return self._build_tokens(payload)

    async def revoke_token(
        self,
        *,
        config: SalesforceWorkspaceAuthConfigDocument,
        token: str,
    ) -> None:
        """Revoke a Salesforce OAuth access or refresh token.

        Args:
            config: Workspace Salesforce OAuth configuration.
            token: Salesforce OAuth token to revoke.

        Raises:
            SalesforceOAuthGatewayError: If revocation fails.
        """
        data = self._base_token_data(config)
        data["token"] = token
        response = await self._post(
            f"{self._oauth_base_url(config)}/revoke",
            operation="token revocation",
            data=data,
        )
        if response.status_code in {200, 204}:
            return
        payload = self._safe_json(response)
        raise SalesforceOAuthGatewayError(
            "Salesforce token revocation failed",
            error_code=self._extract_error_code(payload),
            retriable=response.status_code >= 500,
        )

    async def aclose(self) -> None:
        """Close the owned HTTP client and release network resources.

        Returns:
            None.
        """
        await self._http_client.aclose()

    async def _post(
        self,
        url: str,
        *,
        operation: str,
        data: Mapping[str, Any],
    ) -> httpx.Response:
        """Execute an HTTP POST and normalize transport failures.

        Args:
            url: Target URL for the outbound HTTP request.
            operation: Short operation name used in error messages.
            data: Form payload sent in the request body.

        Returns:
            HTTP response returned by the remote server.

        Raises:
            SalesforceOAuthGatewayError: If the HTTP transport fails.
        """
        try:
            return await self._http_client.post(url, data=data)
        except httpx.HTTPError as exc:
            raise SalesforceOAuthGatewayError(
                f"Salesforce OAuth {operation} request failed",
                error_code="transport_error",
                retriable=True,
            ) from exc

    def _parse_json_response(self, response: httpx.Response) -> Mapping[str, Any]:
        """Parse a Salesforce JSON response and raise typed errors.

        Args:
            response: HTTP response received from Salesforce.

        Returns:
            Decoded JSON mapping payload.

        Raises:
            SalesforceOAuthGatewayError: If the response is not successful JSON.
        """
        payload = self._safe_json(response)
        if response.is_success:
            return payload
        error_code = self._extract_error_code(payload)
        message = "Salesforce OAuth request failed"
        error_description = self._extract_error_description(payload)
        if error_description:
            message = f"{message}: {error_description}"
        raise SalesforceOAuthGatewayError(
            message,
            error_code=error_code,
            retriable=response.status_code >= 500,
        )

    def _build_tokens(self, payload: Mapping[str, Any]) -> SalesforceOAuthTokens:
        """Normalize a token response payload from Salesforce.

        Args:
            payload: JSON payload returned by Salesforce's token endpoint.

        Returns:
            Normalized OAuth token bundle.

        Raises:
            SalesforceOAuthGatewayError: If required token fields are missing.
        """
        access_token = payload.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise SalesforceOAuthGatewayError(
                "Salesforce OAuth token response did not include an access token",
                error_code="invalid_token_response",
            )
        refresh_token = payload.get("refresh_token")
        scope_value = payload.get("scope")
        return SalesforceOAuthTokens(
            access_token=access_token,
            refresh_token=refresh_token if isinstance(refresh_token, str) else None,
            granted_scopes=str(scope_value).split()
            if isinstance(scope_value, str)
            else [],
            expires_at=calculate_expiration(
                expires_in_seconds=self._as_int(payload.get("expires_in"))
            ),
            instance_url=self._optional_salesforce_url(payload.get("instance_url")),
            identity_url=self._optional_salesforce_url(payload.get("id")),
        )

    def _build_identity(
        self,
        payload: Mapping[str, Any],
        *,
        identity_url: str,
    ) -> SalesforceIdentity:
        """Normalize a Salesforce identity response payload.

        Args:
            payload: JSON payload returned by the identity endpoint.
            identity_url: Identity URL used when the payload omits its own URL.

        Returns:
            Normalized Salesforce identity information.

        Raises:
            SalesforceOAuthGatewayError: If stable identity fields are absent.
        """
        organization_id = payload.get("organization_id")
        user_id = payload.get("user_id")
        if not isinstance(organization_id, str) or not organization_id:
            raise SalesforceOAuthGatewayError(
                "Salesforce identity response did not include an organization id",
                error_code="invalid_identity_response",
            )
        if not isinstance(user_id, str) or not user_id:
            raise SalesforceOAuthGatewayError(
                "Salesforce identity response did not include a user id",
                error_code="invalid_identity_response",
            )
        return SalesforceIdentity(
            organization_id=organization_id,
            user_id=user_id,
            username=self._optional_text(payload.get("username")),
            email=self._optional_text(payload.get("email")),
            identity_url=self._optional_text(payload.get("id")) or identity_url,
        )

    def _base_token_data(
        self,
        config: SalesforceWorkspaceAuthConfigDocument,
    ) -> dict[str, str]:
        """Build shared token endpoint form data for a workspace configuration.

        Args:
            config: Workspace Salesforce OAuth configuration.

        Returns:
            Mutable form data containing client credentials where available.

        Raises:
            SalesforceOAuthGatewayError: If an encrypted client secret cannot be
                decrypted.
        """
        data = {"client_id": config.oauth_client_id}
        if config.oauth_client_secret_encrypted is None:
            return data
        if self._client_secret_cipher is None:
            raise SalesforceOAuthGatewayError(
                "Salesforce OAuth client secret cannot be decrypted",
                error_code="client_secret_unavailable",
            )
        try:
            data["client_secret"] = self._client_secret_cipher.decrypt(
                config.oauth_client_secret_encrypted
            )
        except SalesforceTokenCipherError as exc:
            raise SalesforceOAuthGatewayError(
                str(exc),
                error_code="client_secret_decrypt_failed",
            ) from exc
        return data

    def _oauth_base_url(self, config: SalesforceWorkspaceAuthConfigDocument) -> str:
        """Return the Salesforce OAuth endpoint base URL for a workspace config.

        Args:
            config: Workspace Salesforce OAuth configuration.

        Returns:
            Absolute Salesforce OAuth base URL.
        """
        return f"https://{config.salesforce_my_domain_host}/services/oauth2"

    def _optional_salesforce_url(self, value: Any) -> str | None:
        """Return a validated Salesforce URL when a JSON value contains one.

        Args:
            value: JSON scalar that may contain a Salesforce URL.

        Returns:
            Validated Salesforce URL, or `None` when the value is empty.

        Raises:
            SalesforceOAuthGatewayError: If the value is a non-Salesforce URL.
        """
        text_value = self._optional_text(value)
        if text_value is None:
            return None
        return self._validated_salesforce_url(
            text_value,
            error_code="invalid_salesforce_url",
        )

    def _validated_salesforce_url(self, value: str, *, error_code: str) -> str:
        """Validate an outbound URL before sending Salesforce credentials to it.

        Args:
            value: URL to validate.
            error_code: Stable error code to use when validation fails.

        Returns:
            Original URL when it is an HTTPS Salesforce URL.

        Raises:
            SalesforceOAuthGatewayError: If the URL is not safe for bearer tokens or
                OAuth credentials.
        """
        split_url = urlsplit(value)
        hostname = split_url.hostname or ""
        if (
            split_url.scheme != "https"
            or not hostname
            or split_url.username
            or split_url.password
            or not is_salesforce_host(hostname)
        ):
            raise SalesforceOAuthGatewayError(
                "Salesforce OAuth response included an unsafe Salesforce URL",
                error_code=error_code,
            )
        return value

    def _safe_json(self, response: httpx.Response) -> Mapping[str, Any]:
        """Return a JSON mapping response payload when possible.

        Args:
            response: HTTP response received from Salesforce.

        Returns:
            JSON mapping payload, or an empty mapping when parsing fails.
        """
        try:
            payload = response.json()
        except ValueError:
            return {}
        return payload if isinstance(payload, dict) else {}

    def _extract_error_code(self, payload: Mapping[str, Any]) -> str | None:
        """Extract an OAuth error code from a Salesforce response payload.

        Args:
            payload: Salesforce response payload.

        Returns:
            OAuth error code when present.
        """
        error_value = payload.get("error")
        return str(error_value) if isinstance(error_value, str) else None

    def _extract_error_description(self, payload: Mapping[str, Any]) -> str | None:
        """Extract an OAuth error description from a Salesforce response payload.

        Args:
            payload: Salesforce response payload.

        Returns:
            OAuth error description when present.
        """
        description = payload.get("error_description")
        return str(description) if isinstance(description, str) else None

    def _optional_text(self, value: Any) -> str | None:
        """Return a non-empty string value when available.

        Args:
            value: JSON scalar to normalize.

        Returns:
            String value when it is non-empty, else `None`.
        """
        return value if isinstance(value, str) and value else None

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


def build_pkce_code_challenge(code_verifier: str) -> str:
    """Build an S256 PKCE code challenge from a verifier.

    Args:
        code_verifier: High-entropy PKCE verifier.

    Returns:
        Base64url-encoded SHA-256 challenge without padding.
    """
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


__all__ = [
    "AsyncSalesforceHttpTransport",
    "HttpxSalesforceOAuthGateway",
    "SalesforceOAuthGatewayError",
    "build_pkce_code_challenge",
]
