"""PostgreSQL-backed repository for persisted Salesforce OAuth connections."""

from __future__ import annotations

from typing import Any, cast

from pydantic import BaseModel
from sqlalchemy import Engine
from sqlmodel import Session, asc, select

from agents_party.domain.salesforce_auth import SalesforceConnectionDocument
from agents_party.infrastructure.postgres.connection import build_database_engine
from agents_party.infrastructure.postgres.models import SalesforceConnectionRecord


class PostgresSalesforceConnectionRepository:
    """Persist Salesforce OAuth connections in PostgreSQL."""

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

    def get_connection(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        salesforce_org_id: str,
    ) -> SalesforceConnectionDocument | None:
        """Return a specific Salesforce OAuth connection document.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            salesforce_org_id: Salesforce org id for the connection.

        Returns:
            Stored connection document, or `None` when absent.
        """
        with Session(self._engine) as session:
            record = session.get(
                SalesforceConnectionRecord,
                (team_id, slack_user_id, salesforce_org_id),
            )
        if record is None:
            return None
        return SalesforceConnectionDocument.model_validate(record.payload)

    def list_connections(
        self,
        *,
        team_id: str,
        slack_user_id: str,
    ) -> list[SalesforceConnectionDocument]:
        """Return all Salesforce OAuth connections owned by a Slack user.

        Args:
            team_id: Slack workspace id owning the connections.
            slack_user_id: Slack user id whose connections should be listed.

        Returns:
            Stored Salesforce OAuth connection documents for the Slack user.
        """
        statement = (
            select(SalesforceConnectionRecord)
            .where(
                SalesforceConnectionRecord.team_id == team_id,
                SalesforceConnectionRecord.slack_user_id == slack_user_id,
            )
            .order_by(asc(SalesforceConnectionRecord.salesforce_org_id))
        )
        with Session(self._engine) as session:
            rows = session.exec(statement).all()
        return [
            SalesforceConnectionDocument.model_validate(row.payload) for row in rows
        ]

    def upsert_connection(
        self,
        *,
        connection: SalesforceConnectionDocument,
    ) -> SalesforceConnectionDocument:
        """Create or update a Salesforce OAuth connection document.

        Args:
            connection: Connection document to persist.

        Returns:
            Persisted connection document.
        """
        payload = self._dump(connection)
        with Session(self._engine) as session:
            record = session.get(
                SalesforceConnectionRecord,
                (
                    connection.team_id,
                    connection.slack_user_id,
                    connection.salesforce_org_id,
                ),
            )
            if record is None:
                record = SalesforceConnectionRecord(
                    team_id=connection.team_id,
                    slack_user_id=connection.slack_user_id,
                    salesforce_org_id=connection.salesforce_org_id,
                    salesforce_user_id=connection.salesforce_user_id,
                    salesforce_username=connection.salesforce_username,
                    connection_status=connection.connection_status,
                    token_expires_at=connection.token_expires_at,
                    updated_at=connection.updated_at,
                    payload=payload,
                )
            else:
                record.salesforce_user_id = connection.salesforce_user_id
                record.salesforce_username = connection.salesforce_username
                record.connection_status = connection.connection_status
                record.token_expires_at = connection.token_expires_at
                record.updated_at = connection.updated_at
                record.payload = payload
            session.add(record)
            session.commit()
        return connection

    def _dump(self, document: BaseModel) -> dict[str, Any]:
        """Serialize a Pydantic document into JSON-friendly Python data.

        Args:
            document: Pydantic document to serialize.

        Returns:
            Plain Python dictionary ready to persist in a JSON column.
        """
        return cast(dict[str, Any], document.model_dump(mode="json"))


__all__ = ["PostgresSalesforceConnectionRepository"]
