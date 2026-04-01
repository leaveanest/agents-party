"""PostgreSQL-backed repository for Slack routing configuration and thread state."""

from __future__ import annotations

from typing import Any, cast

from pydantic import BaseModel
from sqlalchemy import Engine, asc
from sqlmodel import Session, col, select

from agents_party.domain import (
    AgentDocument,
    ChannelAppSettingsDocument,
    ResolvedAgentRoute,
    ThreadDocument,
    ThreadStatus,
    WorkspaceAppSettingsDocument,
    resolve_agent_id_for_slack_context,
    utc_now,
)
from agents_party.infrastructure.postgres.connection import build_database_engine
from agents_party.infrastructure.postgres.models import (
    AgentRecord,
    ChannelAppSettingsRecord,
    SlackThreadRecord,
    WorkspaceAppSettingsRecord,
)


class PostgresSlackAgentRepository:
    """PostgreSQL-backed repository for Slack agent routing settings."""

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

        Notes:
            The target schema must already exist. Apply Alembic migrations before
            constructing this repository in non-test environments.
        """
        if engine is None and database_url is None:
            raise ValueError("database_url or engine is required.")
        self._engine = engine or build_database_engine(cast(str, database_url))

    def resolve_agent(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str | None = None,
    ) -> ResolvedAgentRoute | None:
        """Resolve a configured agent using thread, channel, then workspace settings.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the request was made.
            thread_ts: Optional thread timestamp for thread-level routing.

        Returns:
            Resolved route containing the enabled agent, or `None` when none applies.
        """
        workspace_settings = self._read_workspace_settings(team_id)
        if (
            workspace_settings is not None
            and workspace_settings.enabled_channel_ids
            and channel_id not in workspace_settings.enabled_channel_ids
        ):
            return None

        channel_settings = self._read_channel_settings(team_id, channel_id)
        thread = (
            self.get_thread_document(
                team_id=team_id,
                channel_id=channel_id,
                thread_ts=thread_ts,
            )
            if thread_ts is not None
            else None
        )

        agent_id, scope = resolve_agent_id_for_slack_context(
            thread_agent_id=thread.agent_id if thread is not None else None,
            channel_agent_id=(
                channel_settings.default_agent_id
                if channel_settings is not None
                else None
            ),
            workspace_agent_id=(
                workspace_settings.default_agent_id
                if workspace_settings is not None
                else None
            ),
        )
        if agent_id is None or scope is None:
            return None

        agent = self._read_agent(agent_id)
        if agent is None or not agent.enabled:
            return None

        return ResolvedAgentRoute(
            scope=scope,
            agent=agent,
            team_id=team_id,
            channel_id=channel_id,
            thread_ts=thread_ts,
        )

    def list_enabled_agents(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str | None = None,
    ) -> list[AgentDocument]:
        """Return enabled agent documents available for selector fallback.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the request was made.
            thread_ts: Optional thread timestamp, currently unused by the query.

        Returns:
            Enabled agent documents that are allowed in the supplied context.
        """
        del thread_ts
        workspace_settings = self._read_workspace_settings(team_id)
        if (
            workspace_settings is not None
            and workspace_settings.enabled_channel_ids
            and channel_id not in workspace_settings.enabled_channel_ids
        ):
            return []

        statement = (
            select(AgentRecord)
            .where(col(AgentRecord.enabled).is_(True))
            .order_by(asc(col(AgentRecord.agent_id)))
        )
        with Session(self._engine) as session:
            rows = session.exec(statement).all()
        return [AgentDocument.model_validate(row.payload) for row in rows]

    def get_thread_document(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str,
    ) -> ThreadDocument | None:
        """Return the stored thread document for a Slack conversation.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the thread lives.
            thread_ts: Thread timestamp identifying the Slack thread.

        Returns:
            Stored thread document, or `None` when no thread state exists.
        """
        with Session(self._engine) as session:
            record = session.get(SlackThreadRecord, (team_id, channel_id, thread_ts))
        if record is None:
            return None
        return ThreadDocument.model_validate(record.payload)

    def activate_thread_agent(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str,
        agent_id: str,
        root_message_ts: str,
        last_message_ts: str,
    ) -> ThreadDocument:
        """Persist the active routed agent for a Slack thread.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the thread lives.
            thread_ts: Thread timestamp identifying the Slack thread.
            agent_id: Agent id that successfully handled the thread.
            root_message_ts: Root Slack message timestamp for the thread.
            last_message_ts: Latest Slack message timestamp included in execution.

        Returns:
            Persisted thread document containing the active routing state.
        """
        current_thread = self.get_thread_document(
            team_id=team_id,
            channel_id=channel_id,
            thread_ts=thread_ts,
        )
        now = utc_now()
        thread = ThreadDocument(
            thread_ts=thread_ts,
            root_message_ts=(
                current_thread.root_message_ts
                if current_thread is not None
                else root_message_ts
            ),
            channel_id=channel_id,
            team_id=team_id,
            status=ThreadStatus.ACTIVE,
            agent_id=agent_id,
            last_message_ts=last_message_ts,
            created_at=current_thread.created_at if current_thread is not None else now,
            updated_at=now,
        )
        payload = self._dump(thread)
        for field_name in (
            "enterprise_id",
            "title",
            "participant_user_ids",
            "messages",
            "message_count",
            "summary",
        ):
            payload.pop(field_name, None)

        with Session(self._engine) as session:
            record = session.get(SlackThreadRecord, (team_id, channel_id, thread_ts))
            if record is None:
                record = SlackThreadRecord(
                    team_id=team_id,
                    channel_id=channel_id,
                    thread_ts=thread_ts,
                    agent_id=agent_id,
                    root_message_ts=thread.root_message_ts,
                    last_message_ts=last_message_ts,
                    status=thread.status,
                    created_at=thread.created_at,
                    updated_at=thread.updated_at,
                    payload=payload,
                )
            else:
                record.agent_id = agent_id
                record.root_message_ts = thread.root_message_ts
                record.last_message_ts = last_message_ts
                record.status = thread.status
                record.created_at = thread.created_at
                record.updated_at = thread.updated_at
                record.payload = payload
            session.add(record)
            session.commit()
        return thread

    def is_thread_auto_reply_enabled(
        self,
        *,
        team_id: str,
        channel_id: str,
    ) -> bool:
        """Return whether follow-up thread replies should auto-route.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the thread lives.

        Returns:
            `True` when follow-up thread replies should trigger auto-routing.
        """
        workspace_settings = self._read_workspace_settings(team_id)
        if (
            workspace_settings is not None
            and workspace_settings.enabled_channel_ids
            and channel_id not in workspace_settings.enabled_channel_ids
        ):
            return False

        channel_settings = self._read_channel_settings(team_id, channel_id)
        if (
            channel_settings is not None
            and channel_settings.thread_auto_reply is not None
        ):
            return channel_settings.thread_auto_reply
        if (
            workspace_settings is not None
            and workspace_settings.thread_auto_reply is not None
        ):
            return workspace_settings.thread_auto_reply
        return True

    def _read_agent(self, agent_id: str) -> AgentDocument | None:
        """Read one enabled or disabled agent definition from the relational store.

        Args:
            agent_id: Agent identifier to fetch.

        Returns:
            Validated agent document, or `None` when the row does not exist.
        """
        with Session(self._engine) as session:
            record = session.get(AgentRecord, agent_id)
        if record is None:
            return None
        return AgentDocument.model_validate(record.payload)

    def _read_workspace_settings(
        self,
        team_id: str,
    ) -> WorkspaceAppSettingsDocument | None:
        """Read workspace app settings for the supplied Slack team.

        Args:
            team_id: Slack workspace id.

        Returns:
            Validated workspace settings, or `None` when missing.
        """
        with Session(self._engine) as session:
            record = session.get(WorkspaceAppSettingsRecord, team_id)
        if record is None:
            return None
        return WorkspaceAppSettingsDocument.model_validate(record.payload)

    def _read_channel_settings(
        self,
        team_id: str,
        channel_id: str,
    ) -> ChannelAppSettingsDocument | None:
        """Read channel app settings for the supplied Slack channel.

        Args:
            team_id: Slack workspace id.
            channel_id: Slack channel id.

        Returns:
            Validated channel settings, or `None` when missing.
        """
        with Session(self._engine) as session:
            record = session.get(ChannelAppSettingsRecord, (team_id, channel_id))
        if record is None:
            return None
        return ChannelAppSettingsDocument.model_validate(record.payload)

    def _dump(self, document: BaseModel) -> dict[str, Any]:
        """Serialize a Pydantic document into JSON-friendly Python data.

        Args:
            document: Pydantic document to serialize.

        Returns:
            Plain Python dictionary ready to persist in a JSON column.
        """
        return cast(dict[str, Any], document.model_dump(mode="json"))


__all__ = ["PostgresSlackAgentRepository"]
