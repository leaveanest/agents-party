"""Salesforce OAuth domain models and shared value objects."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from enum import StrEnum
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from agents_party.domain.slack_documents import DocumentModel, utc_now


SALESFORCE_OAUTH_SCOPES = ("api", "refresh_token", "id")


class SalesforceWorkspaceAuthConfigStatus(StrEnum):
    """Lifecycle states for workspace-level Salesforce OAuth configuration."""

    ACTIVE = "active"
    DISABLED = "disabled"


class SalesforceOAuthAppType(StrEnum):
    """Supported Salesforce OAuth application types."""

    EXTERNAL_CLIENT_APP = "external_client_app"
    CONNECTED_APP = "connected_app"


class SalesforceConnectionStatus(StrEnum):
    """Lifecycle states for a stored Salesforce OAuth connection."""

    ACTIVE = "active"
    REVOKED = "revoked"
    EXPIRED = "expired"
    ERROR = "error"


class SalesforceWorkspaceAuthConfigDocument(DocumentModel):
    """Workspace-level Salesforce OAuth configuration."""

    team_id: str
    salesforce_org_id: str
    salesforce_org_name: str | None = None
    salesforce_my_domain_host: str
    oauth_client_id: str
    oauth_client_secret_encrypted: str | None = None
    app_type: SalesforceOAuthAppType = SalesforceOAuthAppType.EXTERNAL_CLIENT_APP
    default_scopes: list[str] = Field(
        default_factory=lambda: list(SALESFORCE_OAUTH_SCOPES)
    )
    redirect_uri: str
    status: SalesforceWorkspaceAuthConfigStatus = (
        SalesforceWorkspaceAuthConfigStatus.ACTIVE
    )
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    @field_validator("salesforce_my_domain_host")
    @classmethod
    def validate_salesforce_my_domain_host(cls, value: str) -> str:
        """Validate and normalize the configured Salesforce OAuth host.

        Args:
            value: Raw Salesforce My Domain host or URL.

        Returns:
            Lowercase Salesforce host without scheme or path.

        Raises:
            ValueError: If the value is not a Salesforce-owned HTTPS host.
        """
        return normalize_salesforce_host(value)


class SalesforceOAuthStartContext(BaseModel):
    """Short-lived signed context used to begin a Salesforce OAuth flow."""

    model_config = ConfigDict(extra="forbid")

    team_id: str
    slack_user_id: str
    salesforce_org_id: str
    redirect_after_connect: str | None = None
    expires_at: datetime = Field(
        default_factory=lambda: utc_now() + timedelta(minutes=10)
    )


class SalesforceOAuthStateDocument(DocumentModel):
    """Server-side state stored for Salesforce OAuth callbacks."""

    state_id: str
    team_id: str
    slack_user_id: str
    salesforce_org_id: str
    pkce_code_verifier_encrypted: str
    redirect_after_connect: str | None = None
    requested_scopes: list[str] = Field(
        default_factory=lambda: list(SALESFORCE_OAUTH_SCOPES)
    )
    expires_at: datetime = Field(
        default_factory=lambda: utc_now() + timedelta(minutes=10)
    )
    created_at: datetime = Field(default_factory=utc_now)


class SalesforceOAuthStateToken(BaseModel):
    """Opaque callback token that identifies a stored Salesforce OAuth state."""

    model_config = ConfigDict(extra="forbid")

    team_id: str
    state_id: str
    expires_at: datetime


class SalesforceConnectionDocument(DocumentModel):
    """Stored Salesforce OAuth connection for a Slack user and org."""

    team_id: str
    slack_user_id: str
    salesforce_org_id: str
    salesforce_user_id: str
    salesforce_username: str | None = None
    salesforce_user_email: str | None = None
    salesforce_identity_url: str | None = None
    salesforce_instance_url: str | None = None
    granted_scopes: list[str] = Field(default_factory=list)
    connection_status: SalesforceConnectionStatus = SalesforceConnectionStatus.ACTIVE
    access_token_encrypted: str | None = None
    refresh_token_encrypted: str | None = None
    token_expires_at: datetime | None = None
    last_refreshed_at: datetime | None = None
    last_refresh_error_at: datetime | None = None
    last_refresh_error_code: str | None = None
    last_successful_access_at: datetime | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class SalesforceOAuthTokens(BaseModel):
    """Normalized token response returned by the Salesforce OAuth gateway."""

    model_config = ConfigDict(extra="forbid")

    access_token: str
    refresh_token: str | None = None
    granted_scopes: list[str] = Field(default_factory=list)
    expires_at: datetime | None = None
    instance_url: str | None = None
    identity_url: str | None = None


class SalesforceIdentity(BaseModel):
    """Identity response derived from Salesforce's identity endpoint."""

    model_config = ConfigDict(extra="forbid")

    organization_id: str
    user_id: str
    username: str | None = None
    email: str | None = None
    identity_url: str | None = None


class SalesforceOAuthCallbackResult(BaseModel):
    """Outcome of a completed Salesforce OAuth callback."""

    model_config = ConfigDict(extra="forbid")

    redirect_after_connect: str | None = None
    connection: SalesforceConnectionDocument


def calculate_expiration(
    *, expires_in_seconds: int | None, now: datetime | None = None
) -> datetime | None:
    """Convert an OAuth `expires_in` duration into an absolute UTC timestamp.

    Args:
        expires_in_seconds: Lifetime returned by the OAuth endpoint, in seconds.
        now: Optional base timestamp used for deterministic tests.

    Returns:
        Absolute UTC expiration timestamp, or `None` when no duration is available.
    """
    if expires_in_seconds is None:
        return None
    base_time = now or utc_now()
    return base_time.astimezone(UTC) + timedelta(seconds=expires_in_seconds)


def is_salesforce_host(host: str) -> bool:
    """Return whether a host belongs to an expected Salesforce domain.

    Args:
        host: Hostname to validate.

    Returns:
        `True` when the hostname is under a Salesforce-owned domain used for OAuth
        and identity calls.
    """
    normalized_host = host.strip().lower().rstrip(".")
    return (
        normalized_host == "salesforce.com"
        or normalized_host.endswith(".salesforce.com")
        or normalized_host == "force.com"
        or normalized_host.endswith(".force.com")
    )


def normalize_salesforce_host(value: str) -> str:
    """Normalize a Salesforce host or URL and reject non-Salesforce hosts.

    Args:
        value: Raw host or URL from workspace OAuth configuration.

    Returns:
        Lowercase host without scheme, path, query, or fragment.

    Raises:
        ValueError: If the value is blank, uses a non-HTTPS URL, includes userinfo,
            or is not under an expected Salesforce domain.
    """
    raw_value = value.strip()
    if not raw_value:
        raise ValueError("Salesforce host must not be blank.")
    parsed = urlsplit(raw_value if "://" in raw_value else f"https://{raw_value}")
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("Salesforce host must be an HTTPS Salesforce host.")
    if parsed.username or parsed.password:
        raise ValueError("Salesforce host must not include credentials.")
    host = (parsed.hostname or "").lower().rstrip(".")
    if not is_salesforce_host(host):
        raise ValueError("Salesforce host must be under a Salesforce domain.")
    return host


__all__ = [
    "SALESFORCE_OAUTH_SCOPES",
    "SalesforceConnectionDocument",
    "SalesforceConnectionStatus",
    "SalesforceIdentity",
    "SalesforceOAuthAppType",
    "SalesforceOAuthCallbackResult",
    "SalesforceOAuthStartContext",
    "SalesforceOAuthStateDocument",
    "SalesforceOAuthStateToken",
    "SalesforceOAuthTokens",
    "SalesforceWorkspaceAuthConfigDocument",
    "SalesforceWorkspaceAuthConfigStatus",
    "calculate_expiration",
    "is_salesforce_host",
    "normalize_salesforce_host",
]
