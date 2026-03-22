from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


class FirestoreDocument(BaseModel):
    """Base model for Firestore-backed documents."""

    model_config = ConfigDict(extra="forbid")


class InstallationScope(StrEnum):
    WORKSPACE = "workspace"
    ENTERPRISE = "enterprise"


class AgentRouteScope(StrEnum):
    WORKSPACE = "workspace"
    CHANNEL = "channel"
    THREAD = "thread"


class ChannelType(StrEnum):
    CHANNEL = "channel"
    PRIVATE_CHANNEL = "private_channel"
    DM = "dm"
    MPIM = "mpim"


class ThreadStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"
    CLOSED = "closed"


class MessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"


def utc_now() -> datetime:
    """Return the current UTC timestamp for Firestore document defaults.

    Returns:
        Timezone-aware UTC timestamp.
    """
    return datetime.now(tz=UTC)


class TenantSlackIdentityDocument(FirestoreDocument):
    enterprise_id: str | None = None
    primary_team_id: str | None = None
    installation_scope: InstallationScope
    workspace_ids: list[str] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=utc_now)


class TenantAppSettingsDocument(FirestoreDocument):
    default_agent_id: str | None = None
    allowed_models: list[str] = Field(default_factory=list)
    thread_auto_reply: bool = True
    retention_days: int | None = None
    updated_at: datetime = Field(default_factory=utc_now)


class SlackInstallationDocument(FirestoreDocument):
    installation_id: str
    installation_scope: InstallationScope
    enterprise_id: str | None = None
    team_id: str | None = None
    bot_user_id: str | None = None
    installer_user_id: str | None = None
    scopes: list[str] = Field(default_factory=list)
    installed_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentDocument(FirestoreDocument):
    agent_id: str
    name: str
    description: str | None = None
    when_to_use: str | None = None
    supported_skill_names: list[str] = Field(default_factory=list)
    model_provider: str
    model_name: str
    system_prompt: str | None = None
    enabled: bool = True
    version: str = "1"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class WorkspaceDocument(FirestoreDocument):
    team_id: str
    enterprise_id: str | None = None
    team_name: str | None = None
    is_active: bool = True
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class WorkspaceAppSettingsDocument(FirestoreDocument):
    default_agent_id: str | None = None
    enabled_channel_ids: list[str] = Field(default_factory=list)
    locale: str | None = None
    thread_auto_reply: bool | None = None
    updated_at: datetime = Field(default_factory=utc_now)


class ChannelAppSettingsDocument(FirestoreDocument):
    default_agent_id: str | None = None
    thread_auto_reply: bool | None = None
    updated_at: datetime = Field(default_factory=utc_now)


class ChannelDocument(FirestoreDocument):
    channel_id: str
    team_id: str
    enterprise_id: str | None = None
    name: str | None = None
    channel_type: ChannelType
    is_archived: bool = False
    last_message_ts: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ThreadMessage(FirestoreDocument):
    ts: str
    role: MessageRole
    text: str
    user_id: str | None = None
    agent_id: str | None = None
    model_provider: str | None = None
    model_name: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ThreadDocument(FirestoreDocument):
    """Thread state and stored message history for a Slack conversation."""

    thread_ts: str
    root_message_ts: str
    channel_id: str
    team_id: str
    enterprise_id: str | None = None
    title: str | None = None
    status: ThreadStatus = ThreadStatus.ACTIVE
    agent_id: str | None = None
    participant_user_ids: list[str] = Field(default_factory=list)
    messages: list[ThreadMessage] = Field(default_factory=list)
    message_count: int = 0
    summary: str | None = None
    last_message_ts: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    @model_validator(mode="after")
    def sync_message_derived_fields(self) -> ThreadDocument:
        """Keep derived message fields synchronized with the stored messages.

        Returns:
            The validated thread document with derived fields updated in place.
        """
        if self.message_count != len(self.messages):
            self.message_count = len(self.messages)
        if self.messages:
            self.last_message_ts = self.messages[-1].ts
        return self


class ResolvedAgentRoute(FirestoreDocument):
    scope: AgentRouteScope
    agent: AgentDocument
    team_id: str
    channel_id: str
    thread_ts: str | None = None


def resolve_agent_id_for_slack_context(
    *,
    thread_agent_id: str | None = None,
    channel_agent_id: str | None = None,
    workspace_agent_id: str | None = None,
) -> tuple[str | None, AgentRouteScope | None]:
    """Resolve an agent id using thread, channel, then workspace precedence.

    Args:
        thread_agent_id: Agent configured directly on the Slack thread, if any.
        channel_agent_id: Agent configured for the Slack channel, if any.
        workspace_agent_id: Agent configured for the workspace fallback, if any.

    Returns:
        Tuple containing the resolved agent id and the scope that supplied it, or
        `(None, None)` when no configuration exists.
    """
    if thread_agent_id:
        return thread_agent_id, AgentRouteScope.THREAD
    if channel_agent_id:
        return channel_agent_id, AgentRouteScope.CHANNEL
    if workspace_agent_id:
        return workspace_agent_id, AgentRouteScope.WORKSPACE
    return None, None
