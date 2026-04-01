"""Production wiring helpers for the Google OAuth coordinator."""

from __future__ import annotations

from agents_party.config import (
    Settings,
    read_google_oauth_redirect_base_url,
    read_non_blank_text,
    read_secret,
)
from agents_party.google_auth.service import GoogleAuthCoordinator
from agents_party.infrastructure.postgres import (
    PostgresGoogleAuthConnectionRepository,
    PostgresGoogleOAuthStateRepository,
)
from agents_party.infrastructure.postgres.connection import (
    build_database_engine_from_settings,
)
from agents_party.infrastructure.google_auth import (
    FernetTokenCipher,
    GoogleOAuthContextSigner,
    HttpxGoogleOAuthGateway,
)


def build_google_auth_coordinator(settings: Settings) -> GoogleAuthCoordinator | None:
    """Build the production Google OAuth coordinator from application settings.

    Args:
        settings: Application settings used to configure repositories and helpers.

    Returns:
        Configured Google OAuth coordinator, or `None` when Google OAuth is disabled.
    """
    if not settings.google_oauth_enabled or not settings.database_enabled:
        return None
    engine = build_database_engine_from_settings(settings)

    return GoogleAuthCoordinator(
        connection_repository=PostgresGoogleAuthConnectionRepository(
            engine=engine,
        ),
        state_repository=PostgresGoogleOAuthStateRepository(
            engine=engine,
        ),
        gateway=HttpxGoogleOAuthGateway(
            client_id=read_non_blank_text(
                settings.google_oauth_client_id,
                env_name="GOOGLE_OAUTH_CLIENT_ID",
            ),
            client_secret=read_secret(settings.google_oauth_client_secret),
        ),
        context_signer=GoogleOAuthContextSigner(
            secret=read_secret(settings.google_oauth_context_signing_secret),
        ),
        token_cipher=FernetTokenCipher(
            key=read_secret(settings.google_token_encryption_key)
        ),
        redirect_uri=read_google_oauth_redirect_base_url(
            settings.google_oauth_redirect_base_url
        )
        + "/oauth/google/callback",
    )


__all__ = ["build_google_auth_coordinator"]
