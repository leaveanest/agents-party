"""SQLModel table mappings for Google OAuth persistence."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlmodel import Field, SQLModel

from agents_party.infrastructure.postgres.models.common import json_payload_field


class GoogleAuthConnectionRecord(SQLModel, table=True):
    """Persisted Google OAuth connection row for one Slack user account pair."""

    __tablename__ = "google_auth_connections"

    team_id: str = Field(primary_key=True)
    slack_user_id: str = Field(primary_key=True)
    google_account_subject: str = Field(primary_key=True)
    google_account_email: str | None = Field(default=None)
    connection_status: str = Field(nullable=False)
    token_expires_at: datetime | None = Field(default=None)
    refresh_token_expires_at: datetime | None = Field(default=None)
    updated_at: datetime = Field(nullable=False)
    payload: dict[str, Any] = json_payload_field()


class GoogleOAuthStateRecord(SQLModel, table=True):
    """Persisted short-lived Google OAuth state row."""

    __tablename__ = "google_oauth_states"

    team_id: str = Field(primary_key=True)
    state_id: str = Field(primary_key=True)
    slack_user_id: str = Field(nullable=False)
    expires_at: datetime = Field(nullable=False)
    created_at: datetime = Field(nullable=False)
    payload: dict[str, Any] = json_payload_field()


__all__ = ["GoogleAuthConnectionRecord", "GoogleOAuthStateRecord"]
