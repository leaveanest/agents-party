"""SQLModel metadata and table models for PostgreSQL-backed persistence."""

from sqlmodel import SQLModel

from agents_party.infrastructure.postgres.models.common import ensure_schema
from agents_party.infrastructure.postgres.models.google_auth import (
    GoogleAuthConnectionRecord,
    GoogleOAuthStateRecord,
)
from agents_party.infrastructure.postgres.models.salesforce_auth import (
    SalesforceAuthConfigRecord,
    SalesforceConnectionRecord,
    SalesforceOAuthStateRecord,
)
from agents_party.infrastructure.postgres.models.slack_routing import (
    AgentRecord,
    ChannelAppSettingsRecord,
    SlackThreadRecord,
    WorkspaceAppSettingsRecord,
)
from agents_party.infrastructure.postgres.models.slack_installations import (
    SlackBotRecord,
    SlackInstallationRecord,
)
from agents_party.infrastructure.postgres.models.work_management import (
    WorkItemAttentionIndexRecord,
    WorkItemCalendarLinkRecord,
    WorkItemEventRecord,
    WorkItemParticipantRecord,
    WorkItemRecord,
)


metadata = SQLModel.metadata

__all__ = [
    "AgentRecord",
    "ChannelAppSettingsRecord",
    "GoogleAuthConnectionRecord",
    "GoogleOAuthStateRecord",
    "SalesforceAuthConfigRecord",
    "SalesforceConnectionRecord",
    "SalesforceOAuthStateRecord",
    "SlackThreadRecord",
    "SlackBotRecord",
    "SlackInstallationRecord",
    "WorkspaceAppSettingsRecord",
    "WorkItemAttentionIndexRecord",
    "WorkItemCalendarLinkRecord",
    "WorkItemEventRecord",
    "WorkItemParticipantRecord",
    "WorkItemRecord",
    "ensure_schema",
    "metadata",
]
