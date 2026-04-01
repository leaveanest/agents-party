"""Tests for the PostgreSQL-backed Slack agent repository."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import create_engine, insert
from sqlalchemy.pool import StaticPool

from agents_party.domain import AgentRouteScope, ThreadStatus
from agents_party.infrastructure.postgres import PostgresSlackAgentRepository
from agents_party.infrastructure.postgres.models import ensure_schema
from agents_party.infrastructure.postgres.models import (
    AgentRecord,
    ChannelAppSettingsRecord,
    SlackThreadRecord,
    WorkspaceAppSettingsRecord,
)


def make_engine():
    """Build a reusable in-memory engine for repository tests.

    Returns:
        SQLite engine configured to persist across multiple connections.
    """
    return create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )


def seed_timestamp() -> datetime:
    """Return a stable timestamp used for relational seed data in tests.

    Returns:
        Timezone-aware timestamp shared across repository fixtures.
    """
    return datetime(2026, 3, 30, tzinfo=UTC)


def build_seeded_engine():
    """Create an in-memory engine with the relational schema initialized.

    Returns:
        SQLite engine prepared with the repository schema for tests.
    """
    engine = make_engine()
    ensure_schema(engine)
    return engine


def test_resolve_agent_prefers_thread_over_channel_and_workspace() -> None:
    """Verify thread routing overrides channel and workspace defaults.

    Returns:
        None.
    """
    engine = build_seeded_engine()
    repository = PostgresSlackAgentRepository(engine=engine)

    with engine.begin() as connection:
        connection.execute(
            insert(AgentRecord),
            [
                {
                    "agent_id": "thread-agent",
                    "enabled": True,
                    "updated_at": seed_timestamp(),
                    "payload": {
                        "agent_id": "thread-agent",
                        "name": "Thread Agent",
                        "model_provider": "google-gla",
                        "model_name": "gemini-3-flash-preview",
                        "enabled": True,
                    },
                }
            ],
        )
        connection.execute(
            insert(WorkspaceAppSettingsRecord),
            [
                {
                    "team_id": "T1",
                    "default_agent_id": "workspace-agent",
                    "thread_auto_reply": None,
                    "updated_at": seed_timestamp(),
                    "payload": {
                        "default_agent_id": "workspace-agent",
                        "enabled_channel_ids": ["C123"],
                    },
                }
            ],
        )
        connection.execute(
            insert(ChannelAppSettingsRecord),
            [
                {
                    "team_id": "T1",
                    "channel_id": "C123",
                    "default_agent_id": "channel-agent",
                    "thread_auto_reply": None,
                    "updated_at": seed_timestamp(),
                    "payload": {"default_agent_id": "channel-agent"},
                }
            ],
        )
        connection.execute(
            insert(SlackThreadRecord),
            [
                {
                    "team_id": "T1",
                    "channel_id": "C123",
                    "thread_ts": "1712345678.000100",
                    "agent_id": "thread-agent",
                    "root_message_ts": "1712345678.000100",
                    "last_message_ts": "1712345678.000100",
                    "status": "active",
                    "created_at": seed_timestamp(),
                    "updated_at": seed_timestamp(),
                    "payload": {
                        "thread_ts": "1712345678.000100",
                        "root_message_ts": "1712345678.000100",
                        "channel_id": "C123",
                        "team_id": "T1",
                        "agent_id": "thread-agent",
                    },
                }
            ],
        )

    route = repository.resolve_agent(
        team_id="T1",
        channel_id="C123",
        thread_ts="1712345678.000100",
    )

    assert route is not None
    assert route.agent.agent_id == "thread-agent"
    assert route.scope == AgentRouteScope.THREAD


def test_is_channel_enabled_returns_false_outside_workspace_enablement() -> None:
    """Verify the assistant is disabled when the channel is not workspace-enabled.

    Returns:
        None.
    """
    engine = build_seeded_engine()
    repository = PostgresSlackAgentRepository(engine=engine)

    with engine.begin() as connection:
        connection.execute(
            insert(WorkspaceAppSettingsRecord),
            [
                {
                    "team_id": "T1",
                    "default_agent_id": None,
                    "thread_auto_reply": None,
                    "updated_at": seed_timestamp(),
                    "payload": {
                        "enabled_channel_ids": ["C999"],
                    },
                }
            ],
        )

    assert repository.is_channel_enabled(team_id="T1", channel_id="C123") is False


def test_is_channel_enabled_returns_true_for_allowed_channel() -> None:
    """Verify the assistant remains enabled when the channel is allowed.

    Returns:
        None.
    """
    engine = build_seeded_engine()
    repository = PostgresSlackAgentRepository(engine=engine)

    with engine.begin() as connection:
        connection.execute(
            insert(WorkspaceAppSettingsRecord),
            [
                {
                    "team_id": "T1",
                    "default_agent_id": "legacy-agent",
                    "thread_auto_reply": None,
                    "updated_at": seed_timestamp(),
                    "payload": {
                        "default_agent_id": "legacy-agent",
                        "enabled_channel_ids": ["C123"],
                    },
                }
            ],
        )
        connection.execute(
            insert(AgentRecord),
            [
                {
                    "agent_id": "legacy-agent",
                    "enabled": True,
                    "updated_at": seed_timestamp(),
                    "payload": {
                        "agent_id": "legacy-agent",
                        "name": "Legacy Agent",
                        "model_provider": "google-gla",
                        "model_name": "gemini-3-flash-preview",
                        "enabled": True,
                    },
                }
            ],
        )

    assert repository.is_channel_enabled(team_id="T1", channel_id="C123") is True


def test_activate_thread_agent_upserts_minimal_state_only() -> None:
    """Verify thread activation writes only routing state fields.

    Returns:
        None.
    """
    engine = build_seeded_engine()
    repository = PostgresSlackAgentRepository(engine=engine)

    thread = repository.activate_thread_agent(
        team_id="T1",
        channel_id="C123",
        thread_ts="1712345678.000100",
        agent_id="work-manager",
        root_message_ts="1712345678.000100",
        last_message_ts="1712345680.000200",
    )

    stored = repository.get_thread_document(
        team_id="T1",
        channel_id="C123",
        thread_ts="1712345678.000100",
    )
    assert thread.status == ThreadStatus.ACTIVE
    assert stored is not None
    assert stored.agent_id == "work-manager"
    assert stored.root_message_ts == "1712345678.000100"
    assert stored.last_message_ts == "1712345680.000200"
    assert stored.messages == []
    assert stored.participant_user_ids == []
    assert stored.summary is None


def test_is_thread_auto_reply_enabled_prefers_channel_then_workspace_then_default() -> (
    None
):
    """Verify thread auto-reply settings resolve with the intended precedence.

    Returns:
        None.
    """
    engine = build_seeded_engine()
    repository = PostgresSlackAgentRepository(engine=engine)

    assert (
        repository.is_thread_auto_reply_enabled(team_id="T1", channel_id="C123") is True
    )

    with engine.begin() as connection:
        connection.execute(
            insert(WorkspaceAppSettingsRecord),
            [
                {
                    "team_id": "T1",
                    "default_agent_id": None,
                    "thread_auto_reply": False,
                    "updated_at": seed_timestamp(),
                    "payload": {"thread_auto_reply": False},
                }
            ],
        )
    assert (
        repository.is_thread_auto_reply_enabled(team_id="T1", channel_id="C123")
        is False
    )

    with engine.begin() as connection:
        connection.execute(
            insert(ChannelAppSettingsRecord),
            [
                {
                    "team_id": "T1",
                    "channel_id": "C123",
                    "default_agent_id": None,
                    "thread_auto_reply": True,
                    "updated_at": seed_timestamp(),
                    "payload": {"thread_auto_reply": True},
                }
            ],
        )
    assert (
        repository.is_thread_auto_reply_enabled(team_id="T1", channel_id="C123") is True
    )
