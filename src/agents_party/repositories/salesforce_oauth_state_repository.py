"""Repository boundary for server-side Salesforce OAuth state documents."""

from __future__ import annotations

from typing import Protocol

from agents_party.domain.salesforce_auth import SalesforceOAuthStateDocument


class SalesforceOAuthStateRepository(Protocol):
    """Persistence interface for short-lived Salesforce OAuth state."""

    def create_state(
        self,
        *,
        state: SalesforceOAuthStateDocument,
    ) -> SalesforceOAuthStateDocument:
        """Persist a new OAuth state document.

        Args:
            state: OAuth state document to store.

        Returns:
            Persisted OAuth state document.
        """

        ...

    def get_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> SalesforceOAuthStateDocument | None:
        """Return a stored OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            Stored state document, or `None` when absent.
        """

        ...

    def consume_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> SalesforceOAuthStateDocument | None:
        """Atomically read and delete a stored OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            Stored state document when present, or `None` when absent.
        """

        ...

    def delete_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> None:
        """Delete a stored OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            None.
        """

        ...


__all__ = ["SalesforceOAuthStateRepository"]
