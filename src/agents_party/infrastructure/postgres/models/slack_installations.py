"""SQLModel table mappings for Slack OAuth installation persistence."""

from __future__ import annotations

from datetime import datetime

from sqlmodel import Field, SQLModel

from agents_party.infrastructure.postgres.models.common import json_payload_field


class SlackInstallationRecord(SQLModel, table=True):
    """Persisted Slack installation row compatible with Slack SDK OAuth flows."""

    __tablename__ = "slack_installations"

    id: int | None = Field(default=None, primary_key=True)
    client_id: str = Field(nullable=False)
    app_id: str | None = Field(default=None)
    enterprise_id: str | None = Field(default=None)
    enterprise_name: str | None = Field(default=None)
    enterprise_url: str | None = Field(default=None)
    team_id: str | None = Field(default=None)
    team_name: str | None = Field(default=None)
    bot_token: str | None = Field(default=None)
    bot_id: str | None = Field(default=None)
    bot_user_id: str | None = Field(default=None)
    bot_scopes: str | None = Field(default=None)
    bot_refresh_token: str | None = Field(default=None)
    bot_token_expires_at: datetime | None = Field(default=None)
    user_id: str = Field(nullable=False)
    user_token: str | None = Field(default=None)
    user_scopes: str | None = Field(default=None)
    user_refresh_token: str | None = Field(default=None)
    user_token_expires_at: datetime | None = Field(default=None)
    incoming_webhook_url: str | None = Field(default=None)
    incoming_webhook_channel: str | None = Field(default=None)
    incoming_webhook_channel_id: str | None = Field(default=None)
    incoming_webhook_configuration_url: str | None = Field(default=None)
    is_enterprise_install: bool = Field(nullable=False, default=False)
    token_type: str | None = Field(default=None)
    installed_at: datetime = Field(nullable=False)
    payload: dict[str, object] = json_payload_field()


class SlackBotRecord(SQLModel, table=True):
    """Persisted Slack bot row compatible with Slack SDK OAuth flows."""

    __tablename__ = "slack_bots"

    id: int | None = Field(default=None, primary_key=True)
    client_id: str = Field(nullable=False)
    app_id: str | None = Field(default=None)
    enterprise_id: str | None = Field(default=None)
    enterprise_name: str | None = Field(default=None)
    team_id: str | None = Field(default=None)
    team_name: str | None = Field(default=None)
    bot_token: str | None = Field(default=None)
    bot_id: str | None = Field(default=None)
    bot_user_id: str | None = Field(default=None)
    bot_scopes: str | None = Field(default=None)
    bot_refresh_token: str | None = Field(default=None)
    bot_token_expires_at: datetime | None = Field(default=None)
    is_enterprise_install: bool = Field(nullable=False, default=False)
    installed_at: datetime = Field(nullable=False)
    payload: dict[str, object] = json_payload_field()


__all__ = ["SlackBotRecord", "SlackInstallationRecord"]
