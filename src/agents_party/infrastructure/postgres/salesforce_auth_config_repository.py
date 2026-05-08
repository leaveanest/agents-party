"""PostgreSQL-backed repository for Salesforce workspace OAuth configuration."""

from __future__ import annotations

from typing import Any, cast

from pydantic import BaseModel
from sqlalchemy import Engine
from sqlmodel import Session

from agents_party.domain.salesforce_auth import SalesforceWorkspaceAuthConfigDocument
from agents_party.infrastructure.postgres.connection import build_database_engine
from agents_party.infrastructure.postgres.models import SalesforceAuthConfigRecord


class PostgresSalesforceAuthConfigRepository:
    """Persist Salesforce workspace OAuth configuration in PostgreSQL."""

    def __init__(
        self,
        *,
        database_url: str | None = None,
        engine: Engine | None = None,
    ) -> None:
        """Create a repository with either an injected engine or database URL.

        Args:
            database_url: SQLAlchemy-compatible database URL.
            engine: Optional injected SQLAlchemy engine for tests or overrides.

        Raises:
            ValueError: If neither `database_url` nor `engine` is provided.
        """
        if engine is None and database_url is None:
            raise ValueError("database_url or engine is required.")
        self._engine = engine or build_database_engine(cast(str, database_url))

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
        with Session(self._engine) as session:
            record = session.get(
                SalesforceAuthConfigRecord,
                (team_id, salesforce_org_id),
            )
        if record is None:
            return None
        return SalesforceWorkspaceAuthConfigDocument.model_validate(record.payload)

    def upsert_config(
        self,
        *,
        config: SalesforceWorkspaceAuthConfigDocument,
    ) -> SalesforceWorkspaceAuthConfigDocument:
        """Create or update a Salesforce workspace OAuth configuration.

        Args:
            config: Workspace auth configuration to persist.

        Returns:
            Persisted workspace auth configuration.
        """
        payload = self._dump(config)
        with Session(self._engine) as session:
            record = session.get(
                SalesforceAuthConfigRecord,
                (config.team_id, config.salesforce_org_id),
            )
            if record is None:
                record = SalesforceAuthConfigRecord(
                    team_id=config.team_id,
                    salesforce_org_id=config.salesforce_org_id,
                    salesforce_my_domain_host=config.salesforce_my_domain_host,
                    oauth_client_id=config.oauth_client_id,
                    status=config.status,
                    updated_at=config.updated_at,
                    payload=payload,
                )
            else:
                record.salesforce_my_domain_host = config.salesforce_my_domain_host
                record.oauth_client_id = config.oauth_client_id
                record.status = config.status
                record.updated_at = config.updated_at
                record.payload = payload
            session.add(record)
            session.commit()
        return config

    def _dump(self, document: BaseModel) -> dict[str, Any]:
        """Serialize a Pydantic document into JSON-friendly Python data.

        Args:
            document: Pydantic document to serialize.

        Returns:
            Plain Python dictionary ready to persist in a JSON column.
        """
        return cast(dict[str, Any], document.model_dump(mode="json"))


__all__ = ["PostgresSalesforceAuthConfigRepository"]
