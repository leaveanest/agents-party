"""PostgreSQL-backed repository for persisted Google OAuth connections."""

from __future__ import annotations

from typing import Any, cast

from pydantic import BaseModel
from sqlalchemy import Engine
from sqlmodel import Session, asc, select

from agents_party.domain.google_auth import GoogleAuthConnectionDocument
from agents_party.infrastructure.postgres.connection import build_database_engine
from agents_party.infrastructure.postgres.models import GoogleAuthConnectionRecord


class PostgresGoogleAuthConnectionRepository:
    """Persist Google OAuth connections in PostgreSQL."""

    def __init__(
        self,
        *,
        database_url: str | None = None,
        engine: Engine | None = None,
    ) -> None:
        """Create a repository with either an injected engine or a database URL.

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
        google_account_subject: str,
    ) -> GoogleAuthConnectionDocument | None:
        """Return a specific Google OAuth connection document.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            google_account_subject: Stable Google `sub` for the account.

        Returns:
            Stored connection document, or `None` when absent.
        """
        with Session(self._engine) as session:
            record = session.get(
                GoogleAuthConnectionRecord,
                (team_id, slack_user_id, google_account_subject),
            )
        if record is None:
            return None
        return GoogleAuthConnectionDocument.model_validate(record.payload)

    def list_connections(
        self,
        *,
        team_id: str,
        slack_user_id: str,
    ) -> list[GoogleAuthConnectionDocument]:
        """Return all Google OAuth connections owned by a Slack user.

        Args:
            team_id: Slack workspace id owning the connections.
            slack_user_id: Slack user id whose connections should be listed.

        Returns:
            Stored Google OAuth connection documents for the Slack user.
        """
        statement = (
            select(GoogleAuthConnectionRecord)
            .where(
                GoogleAuthConnectionRecord.team_id == team_id,
                GoogleAuthConnectionRecord.slack_user_id == slack_user_id,
            )
            .order_by(asc(GoogleAuthConnectionRecord.google_account_subject))
        )
        with Session(self._engine) as session:
            rows = session.exec(statement).all()
        return [
            GoogleAuthConnectionDocument.model_validate(row.payload) for row in rows
        ]

    def upsert_connection(
        self,
        *,
        connection: GoogleAuthConnectionDocument,
    ) -> GoogleAuthConnectionDocument:
        """Create or update a Google OAuth connection document.

        Args:
            connection: Connection document to persist.

        Returns:
            Persisted connection document.
        """
        payload = self._dump(connection)
        with Session(self._engine) as session:
            record = session.get(
                GoogleAuthConnectionRecord,
                (
                    connection.team_id,
                    connection.slack_user_id,
                    connection.google_account_subject,
                ),
            )
            if record is None:
                record = GoogleAuthConnectionRecord(
                    team_id=connection.team_id,
                    slack_user_id=connection.slack_user_id,
                    google_account_subject=connection.google_account_subject,
                    google_account_email=connection.google_account_email,
                    connection_status=connection.connection_status,
                    token_expires_at=connection.token_expires_at,
                    refresh_token_expires_at=connection.refresh_token_expires_at,
                    updated_at=connection.updated_at,
                    payload=payload,
                )
            else:
                record.google_account_email = connection.google_account_email
                record.connection_status = connection.connection_status
                record.token_expires_at = connection.token_expires_at
                record.refresh_token_expires_at = connection.refresh_token_expires_at
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


__all__ = ["PostgresGoogleAuthConnectionRepository"]
