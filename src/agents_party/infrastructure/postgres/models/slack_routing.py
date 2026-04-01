"""SQLModel table mappings for Slack routing and thread state persistence."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlmodel import Field, SQLModel

from agents_party.infrastructure.postgres.models.common import json_payload_field


class AgentRecord(SQLModel, table=True):
    """Persisted agent definition row used for Slack routing."""

    __tablename__ = "agents"

    agent_id: str = Field(primary_key=True)
    enabled: bool = Field(nullable=False, index=True)
    updated_at: datetime = Field(nullable=False)
    payload: dict[str, Any] = json_payload_field()


class WorkspaceAppSettingsRecord(SQLModel, table=True):
    """Persisted workspace-level routing settings row."""

    __tablename__ = "workspace_app_settings"

    team_id: str = Field(primary_key=True)
    default_agent_id: str | None = Field(default=None)
    thread_auto_reply: bool | None = Field(default=None)
    updated_at: datetime = Field(nullable=False)
    payload: dict[str, Any] = json_payload_field()


class ChannelAppSettingsRecord(SQLModel, table=True):
    """Persisted channel-level routing settings row."""

    __tablename__ = "channel_app_settings"

    team_id: str = Field(primary_key=True)
    channel_id: str = Field(primary_key=True)
    default_agent_id: str | None = Field(default=None)
    thread_auto_reply: bool | None = Field(default=None)
    updated_at: datetime = Field(nullable=False)
    payload: dict[str, Any] = json_payload_field()


class SlackThreadRecord(SQLModel, table=True):
    """Persisted Slack thread routing state row."""

    __tablename__ = "slack_threads"

    team_id: str = Field(primary_key=True)
    channel_id: str = Field(primary_key=True)
    thread_ts: str = Field(primary_key=True)
    agent_id: str | None = Field(default=None)
    root_message_ts: str = Field(nullable=False)
    last_message_ts: str | None = Field(default=None)
    status: str = Field(nullable=False)
    created_at: datetime = Field(nullable=False)
    updated_at: datetime = Field(nullable=False)
    payload: dict[str, Any] = json_payload_field()


__all__ = [
    "AgentRecord",
    "ChannelAppSettingsRecord",
    "SlackThreadRecord",
    "WorkspaceAppSettingsRecord",
]
