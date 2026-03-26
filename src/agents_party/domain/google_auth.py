"""Google OAuth domain models and shared value objects."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from agents_party.domain.slack_documents import FirestoreDocument, utc_now


GOOGLE_OAUTH_SCOPES = (
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/calendar.readonly",
)


class GoogleConnectionStatus(StrEnum):
    """Lifecycle states for a stored Google OAuth connection."""

    ACTIVE = "active"
    REVOKED = "revoked"
    EXPIRED = "expired"
    ERROR = "error"


class GoogleOAuthStartContext(BaseModel):
    """Short-lived signed context used to kick off a Google OAuth flow."""

    model_config = ConfigDict(extra="forbid")

    team_id: str
    slack_user_id: str
    redirect_after_connect: str | None = None
    expires_at: datetime = Field(
        default_factory=lambda: utc_now() + timedelta(minutes=10)
    )


class GoogleOAuthStateDocument(FirestoreDocument):
    """Server-side state stored for Google OAuth callbacks."""

    state_id: str
    team_id: str
    slack_user_id: str
    redirect_after_connect: str | None = None
    requested_scopes: list[str] = Field(
        default_factory=lambda: list(GOOGLE_OAUTH_SCOPES)
    )
    expires_at: datetime = Field(
        default_factory=lambda: utc_now() + timedelta(minutes=10)
    )
    created_at: datetime = Field(default_factory=utc_now)


class GoogleOAuthStateToken(BaseModel):
    """Opaque callback token that identifies a stored OAuth state document."""

    model_config = ConfigDict(extra="forbid")

    team_id: str
    state_id: str
    expires_at: datetime


class GoogleAuthConnectionDocument(FirestoreDocument):
    """Stored Google OAuth connection for a Slack user and Google account."""

    team_id: str
    slack_user_id: str
    google_account_subject: str
    google_account_email: str | None = None
    google_account_email_verified: bool = False
    granted_scopes: list[str] = Field(default_factory=list)
    connection_status: GoogleConnectionStatus = GoogleConnectionStatus.ACTIVE
    access_token_encrypted: str | None = None
    refresh_token_encrypted: str | None = None
    token_expires_at: datetime | None = None
    refresh_token_expires_at: datetime | None = None
    last_refreshed_at: datetime | None = None
    last_refresh_error_at: datetime | None = None
    last_refresh_error_code: str | None = None
    last_successful_access_at: datetime | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class GoogleOAuthTokens(BaseModel):
    """Normalized token response returned by the Google OAuth gateway."""

    model_config = ConfigDict(extra="forbid")

    access_token: str
    refresh_token: str | None = None
    id_token: str | None = None
    granted_scopes: list[str] = Field(default_factory=list)
    expires_at: datetime | None = None
    refresh_token_expires_at: datetime | None = None


class GoogleIdentityClaims(BaseModel):
    """Verified identity claims derived from a Google ID token."""

    model_config = ConfigDict(extra="forbid")

    subject: str
    email: str | None = None
    email_verified: bool = False


class GoogleOAuthCallbackResult(BaseModel):
    """Outcome of a completed Google OAuth callback."""

    model_config = ConfigDict(extra="forbid")

    redirect_after_connect: str | None = None
    connection: GoogleAuthConnectionDocument


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


__all__ = [
    "GOOGLE_OAUTH_SCOPES",
    "GoogleAuthConnectionDocument",
    "GoogleConnectionStatus",
    "GoogleIdentityClaims",
    "GoogleOAuthCallbackResult",
    "GoogleOAuthStartContext",
    "GoogleOAuthStateDocument",
    "GoogleOAuthStateToken",
    "GoogleOAuthTokens",
    "calculate_expiration",
]
