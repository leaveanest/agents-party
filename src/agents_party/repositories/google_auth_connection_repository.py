"""Repository boundary for persisted Google OAuth connections."""

from __future__ import annotations

from typing import Protocol

from agents_party.domain.google_auth import GoogleAuthConnectionDocument


class GoogleAuthConnectionRepository(Protocol):
    """Persistence interface for Google OAuth connection documents."""

    def get_connection(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        google_account_subject: str,
    ) -> GoogleAuthConnectionDocument | None:
        """Return a specific stored Google OAuth connection.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            google_account_subject: Stable Google `sub` value for the account.

        Returns:
            Stored connection document, or `None` when absent.
        """

        ...

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
            Stored connections for the Slack user.
        """

        ...

    def upsert_connection(
        self,
        *,
        connection: GoogleAuthConnectionDocument,
    ) -> GoogleAuthConnectionDocument:
        """Persist a Google OAuth connection document.

        Args:
            connection: Connection document to create or update.

        Returns:
            Persisted connection document.
        """

        ...


__all__ = ["GoogleAuthConnectionRepository"]
