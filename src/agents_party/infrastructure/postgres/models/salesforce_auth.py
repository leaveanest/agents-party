"""SQLModel table mappings for Salesforce OAuth persistence."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlmodel import Field, SQLModel

from agents_party.infrastructure.postgres.models.common import json_payload_field


class SalesforceAuthConfigRecord(SQLModel, table=True):
    """Persisted workspace-level Salesforce OAuth configuration row."""

    __tablename__ = "salesforce_auth_configs"

    team_id: str = Field(primary_key=True)
    salesforce_org_id: str = Field(primary_key=True)
    salesforce_my_domain_host: str = Field(nullable=False)
    oauth_client_id: str = Field(nullable=False)
    status: str = Field(nullable=False)
    updated_at: datetime = Field(nullable=False)
    payload: dict[str, Any] = json_payload_field()


class SalesforceConnectionRecord(SQLModel, table=True):
    """Persisted Salesforce OAuth connection row for one Slack user and org."""

    __tablename__ = "salesforce_connections"

    team_id: str = Field(primary_key=True)
    slack_user_id: str = Field(primary_key=True)
    salesforce_org_id: str = Field(primary_key=True)
    salesforce_user_id: str = Field(nullable=False)
    salesforce_username: str | None = Field(default=None)
    connection_status: str = Field(nullable=False)
    token_expires_at: datetime | None = Field(default=None)
    updated_at: datetime = Field(nullable=False)
    payload: dict[str, Any] = json_payload_field()


class SalesforceOAuthStateRecord(SQLModel, table=True):
    """Persisted short-lived Salesforce OAuth state row."""

    __tablename__ = "salesforce_oauth_states"

    team_id: str = Field(primary_key=True)
    state_id: str = Field(primary_key=True)
    slack_user_id: str = Field(nullable=False)
    salesforce_org_id: str = Field(nullable=False)
    expires_at: datetime = Field(nullable=False)
    created_at: datetime = Field(nullable=False)
    payload: dict[str, Any] = json_payload_field()


__all__ = [
    "SalesforceAuthConfigRecord",
    "SalesforceConnectionRecord",
    "SalesforceOAuthStateRecord",
]
