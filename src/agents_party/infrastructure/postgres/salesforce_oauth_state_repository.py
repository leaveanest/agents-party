"""PostgreSQL-backed repository for short-lived Salesforce OAuth state."""

from __future__ import annotations

import json
from typing import Any, cast

from pydantic import BaseModel
from sqlalchemy import Engine, text
from sqlmodel import Session

from agents_party.domain.salesforce_auth import SalesforceOAuthStateDocument
from agents_party.infrastructure.postgres.connection import build_database_engine
from agents_party.infrastructure.postgres.models import SalesforceOAuthStateRecord


class PostgresSalesforceOAuthStateRepository:
    """Persist short-lived Salesforce OAuth state in PostgreSQL."""

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

    def create_state(
        self,
        *,
        state: SalesforceOAuthStateDocument,
    ) -> SalesforceOAuthStateDocument:
        """Persist a new Salesforce OAuth state document.

        Args:
            state: OAuth state document to store.

        Returns:
            Persisted OAuth state document.
        """
        record = SalesforceOAuthStateRecord(
            team_id=state.team_id,
            state_id=state.state_id,
            slack_user_id=state.slack_user_id,
            salesforce_org_id=state.salesforce_org_id,
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
    ) -> SalesforceOAuthStateDocument | None:
        """Return a stored Salesforce OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            Stored state document, or `None` when absent.
        """
        with Session(self._engine) as session:
            record = session.get(SalesforceOAuthStateRecord, (team_id, state_id))
        if record is None:
            return None
        return SalesforceOAuthStateDocument.model_validate(record.payload)

    def consume_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> SalesforceOAuthStateDocument | None:
        """Atomically read and delete a stored Salesforce OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            Stored state document, or `None` when absent.
        """
        with Session(self._engine) as session:
            result = session.connection().execute(
                text(
                    """
                    DELETE FROM salesforce_oauth_states
                    WHERE team_id = :team_id AND state_id = :state_id
                    RETURNING payload
                    """
                ),
                {"team_id": team_id, "state_id": state_id},
            )
            payload = result.scalar_one_or_none()
            if payload is None:
                session.commit()
                return None
            session.commit()
        if isinstance(payload, str):
            payload = json.loads(payload)
        return SalesforceOAuthStateDocument.model_validate(payload)

    def delete_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> None:
        """Delete a stored Salesforce OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            None.
        """
        with Session(self._engine) as session:
            record = session.get(SalesforceOAuthStateRecord, (team_id, state_id))
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


__all__ = ["PostgresSalesforceOAuthStateRepository"]
