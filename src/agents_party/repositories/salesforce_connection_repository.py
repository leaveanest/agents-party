"""Repository boundary for persisted Salesforce OAuth connections."""

from __future__ import annotations

from typing import Protocol

from agents_party.domain.salesforce_auth import SalesforceConnectionDocument


class SalesforceConnectionRepository(Protocol):
    """Persistence interface for Salesforce OAuth connection documents."""

    def get_connection(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        salesforce_org_id: str,
    ) -> SalesforceConnectionDocument | None:
        """Return a specific stored Salesforce OAuth connection.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            salesforce_org_id: Salesforce org id for the connection.

        Returns:
            Stored connection document, or `None` when absent.
        """

        ...

    def list_connections(
        self,
        *,
        team_id: str,
        slack_user_id: str,
    ) -> list[SalesforceConnectionDocument]:
        """Return all stored Salesforce OAuth connections for a Slack user.

        Args:
            team_id: Slack workspace id owning the connections.
            slack_user_id: Slack user id whose connections should be listed.

        Returns:
            Stored Salesforce OAuth connection documents for the Slack user.
        """

        ...

    def upsert_connection(
        self,
        *,
        connection: SalesforceConnectionDocument,
    ) -> SalesforceConnectionDocument:
        """Persist a Salesforce OAuth connection document.

        Args:
            connection: Connection document to create or update.

        Returns:
            Persisted connection document.
        """

        ...


__all__ = ["SalesforceConnectionRepository"]
