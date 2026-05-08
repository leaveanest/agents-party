"""Gateway boundary for Salesforce OAuth HTTP interactions."""

from __future__ import annotations

from typing import Protocol

from agents_party.domain.salesforce_auth import (
    SalesforceIdentity,
    SalesforceOAuthTokens,
    SalesforceWorkspaceAuthConfigDocument,
)


class SalesforceOAuthGateway(Protocol):
    """Boundary around Salesforce OAuth endpoints and identity lookup."""

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

        ...

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

        ...

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

        ...

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

        ...

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

        Returns:
            None.
        """

        ...

    async def aclose(self) -> None:
        """Release any network resources owned by the gateway.

        Returns:
            None.
        """

        ...


__all__ = ["SalesforceOAuthGateway"]
