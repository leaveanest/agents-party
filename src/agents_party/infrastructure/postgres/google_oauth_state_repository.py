"""PostgreSQL-backed repository for short-lived Google OAuth state."""

from __future__ import annotations

from typing import Any, cast

from pydantic import BaseModel
from sqlalchemy import Engine
from sqlmodel import Session

from agents_party.domain.google_auth import GoogleOAuthStateDocument
from agents_party.infrastructure.postgres.connection import build_database_engine
from agents_party.infrastructure.postgres.models import GoogleOAuthStateRecord


class PostgresGoogleOAuthStateRepository:
    """Persist short-lived Google OAuth state in PostgreSQL."""

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

    def create_state(
        self,
        *,
        state: GoogleOAuthStateDocument,
    ) -> GoogleOAuthStateDocument:
        """Persist a new Google OAuth state document.

        Args:
            state: OAuth state document to store.

        Returns:
            Persisted OAuth state document.
        """
        record = GoogleOAuthStateRecord(
            team_id=state.team_id,
            state_id=state.state_id,
            slack_user_id=state.slack_user_id,
            expires_at=state.expires_at,
            created_at=state.created_at,
            payload=self._dump(state),
        )
        with Session(self._engine) as session:
            session.add(record)
            session.commit()
        return state

    def get_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> GoogleOAuthStateDocument | None:
        """Return a stored Google OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            Stored state document, or `None` when absent.
        """
        with Session(self._engine) as session:
            record = session.get(GoogleOAuthStateRecord, (team_id, state_id))
        if record is None:
            return None
        return GoogleOAuthStateDocument.model_validate(record.payload)

    def consume_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> GoogleOAuthStateDocument | None:
        """Atomically read and delete a stored Google OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            Stored state document, or `None` when absent.
        """
        with Session(self._engine) as session:
            record = session.get(GoogleOAuthStateRecord, (team_id, state_id))
            if record is None:
                return None
            state = GoogleOAuthStateDocument.model_validate(record.payload)
            session.delete(record)
            session.commit()
        return state

    def delete_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> None:
        """Delete a stored Google OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            None.
        """
        with Session(self._engine) as session:
            record = session.get(GoogleOAuthStateRecord, (team_id, state_id))
            if record is None:
                return
            session.delete(record)
            session.commit()

    def _dump(self, document: BaseModel) -> dict[str, Any]:
        """Serialize a Pydantic document into JSON-friendly Python data.

        Args:
            document: Pydantic document to serialize.

        Returns:
            Plain Python dictionary ready to persist in a JSON column.
        """
        return cast(dict[str, Any], document.model_dump(mode="json"))


__all__ = ["PostgresGoogleOAuthStateRepository"]
