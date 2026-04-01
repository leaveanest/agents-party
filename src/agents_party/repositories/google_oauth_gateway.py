"""Gateway boundary for Google OAuth HTTP interactions."""

from __future__ import annotations

from typing import Protocol

from agents_party.domain.google_auth import GoogleIdentityClaims, GoogleOAuthTokens


class GoogleOAuthGateway(Protocol):
    """Boundary around Google OAuth endpoints and token verification."""

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

        ...

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

        ...

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

        ...

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

        ...

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

        ...

    async def aclose(self) -> None:
        """Release any network resources owned by the gateway.

        Returns:
            None.
        """

        ...


__all__ = ["GoogleOAuthGateway"]
