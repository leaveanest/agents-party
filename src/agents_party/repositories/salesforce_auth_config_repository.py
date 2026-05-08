"""Repository boundary for Salesforce workspace OAuth configuration."""

from __future__ import annotations

from typing import Protocol

from agents_party.domain.salesforce_auth import SalesforceWorkspaceAuthConfigDocument


class SalesforceWorkspaceAuthConfigRepository(Protocol):
    """Persistence interface for workspace-level Salesforce OAuth settings."""

    def get_config(
        self,
        *,
        team_id: str,
        salesforce_org_id: str,
    ) -> SalesforceWorkspaceAuthConfigDocument | None:
        """Return a specific Salesforce workspace OAuth configuration.

        Args:
            team_id: Slack workspace id owning the configuration.
            salesforce_org_id: Salesforce org id for the configuration.

        Returns:
            Stored workspace auth configuration, or `None` when absent.
        """

        ...

    def upsert_config(
        self,
        *,
        config: SalesforceWorkspaceAuthConfigDocument,
    ) -> SalesforceWorkspaceAuthConfigDocument:
        """Persist a Salesforce workspace OAuth configuration.

        Args:
            config: Workspace auth configuration to create or update.

        Returns:
            Persisted workspace auth configuration.
        """

        ...


__all__ = ["SalesforceWorkspaceAuthConfigRepository"]
