"""SQLModel table mappings for work-item persistence and query indexes."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Index, UniqueConstraint
from sqlmodel import Field, SQLModel

from agents_party.infrastructure.postgres.models.common import json_payload_field


class WorkItemRecord(SQLModel, table=True):
    """Persisted work-item source-of-truth row."""

    __tablename__ = "work_items"
    __table_args__ = (Index("ix_work_items_channel", "team_id", "audience_channel_id"),)

    team_id: str = Field(primary_key=True)
    work_item_id: str = Field(primary_key=True)
    title: str = Field(nullable=False)
    status: str = Field(nullable=False, index=True)
    visibility_kind: str = Field(nullable=False, index=True)
    audience_channel_id: str | None = Field(default=None)
    primary_assignee_user_id: str | None = Field(default=None)
    due_at: datetime | None = Field(default=None)
    updated_at: datetime = Field(nullable=False)
    completed_at: datetime | None = Field(default=None)
    payload: dict[str, Any] = json_payload_field()


class WorkItemParticipantRecord(SQLModel, table=True):
    """Persisted participant relation row for a work item."""

    __tablename__ = "work_item_participants"

    team_id: str = Field(primary_key=True)
    work_item_id: str = Field(primary_key=True)
    user_id: str = Field(primary_key=True)
    role: str = Field(nullable=False)
    attention_profile: str = Field(nullable=False)
    next_attention_at: datetime | None = Field(default=None)
    muted_until: datetime | None = Field(default=None)
    last_seen_event_id: str | None = Field(default=None)
    updated_at: datetime = Field(nullable=False)
    payload: dict[str, Any] = json_payload_field()


class WorkItemEventRecord(SQLModel, table=True):
    """Persisted work-item event history row."""

    __tablename__ = "work_item_events"

    team_id: str = Field(primary_key=True)
    work_item_id: str = Field(primary_key=True)
    event_id: str = Field(primary_key=True)
    type: str = Field(nullable=False)
    occurred_at: datetime = Field(nullable=False)
    payload: dict[str, Any] = json_payload_field()


class WorkItemCalendarLinkRecord(SQLModel, table=True):
    """Persisted external calendar event link for a work item."""

    __tablename__ = "work_item_calendar_links"
    __table_args__ = (
        UniqueConstraint(
            "team_id",
            "work_item_id",
            "provider_kind",
            "external_calendar_id",
            "external_event_id",
            name="uq_work_item_calendar_links_external_event",
        ),
        Index(
            "ix_work_item_calendar_links_external_event",
            "team_id",
            "provider_kind",
            "external_calendar_id",
            "external_event_id",
        ),
        Index(
            "ix_work_item_calendar_links_sync_status",
            "team_id",
            "sync_status",
        ),
    )

    team_id: str = Field(primary_key=True)
    work_item_id: str = Field(primary_key=True)
    link_id: str = Field(primary_key=True)
    provider_kind: str = Field(nullable=False)
    external_calendar_id: str = Field(nullable=False)
    external_event_id: str = Field(nullable=False)
    event_title_snapshot: str | None = Field(default=None)
    starts_at: datetime | None = Field(default=None)
    ends_at: datetime | None = Field(default=None)
    is_all_day: bool = Field(default=False, nullable=False)
    response_status: str | None = Field(default=None)
    sync_status: str = Field(nullable=False)
    last_synced_at: datetime | None = Field(default=None)
    created_at: datetime = Field(nullable=False)
    updated_at: datetime = Field(nullable=False)
    payload: dict[str, Any] = json_payload_field()


class WorkItemAttentionIndexRecord(SQLModel, table=True):
    """Persisted per-user attention index row for a work item."""

    __tablename__ = "work_item_attention_index"
    __table_args__ = (
        Index(
            "ix_work_item_attention_index_viewer",
            "team_id",
            "user_id",
            "needs_attention_now",
        ),
    )

    team_id: str = Field(primary_key=True)
    user_id: str = Field(primary_key=True)
    work_item_id: str = Field(primary_key=True)
    needs_attention_now: bool = Field(nullable=False, index=True)
    status: str = Field(nullable=False)
    visibility_kind: str = Field(nullable=False)
    audience_channel_id: str | None = Field(default=None)
    primary_assignee_user_id: str | None = Field(default=None)
    updated_at: datetime = Field(nullable=False)
    payload: dict[str, Any] = json_payload_field()


__all__ = [
    "WorkItemAttentionIndexRecord",
    "WorkItemCalendarLinkRecord",
    "WorkItemEventRecord",
    "WorkItemParticipantRecord",
    "WorkItemRecord",
]
