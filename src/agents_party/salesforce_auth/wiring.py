"""Production wiring helpers for the Salesforce OAuth coordinator."""

from __future__ import annotations

from agents_party.config import Settings, read_secret
from agents_party.infrastructure.postgres import (
    PostgresSalesforceAuthConfigRepository,
    PostgresSalesforceConnectionRepository,
    PostgresSalesforceOAuthStateRepository,
)
from agents_party.infrastructure.postgres.connection import (
    build_database_engine_from_settings,
)
from agents_party.infrastructure.salesforce import (
    FernetSalesforceTokenCipher,
    HttpxSalesforceOAuthGateway,
    SalesforceOAuthContextSigner,
)
from agents_party.salesforce_auth.service import SalesforceAuthCoordinator


def build_salesforce_auth_coordinator(
    settings: Settings,
) -> SalesforceAuthCoordinator | None:
    """Build the production Salesforce OAuth coordinator from settings.

    Args:
        settings: Application settings used to configure repositories and helpers.

    Returns:
        Configured Salesforce OAuth coordinator, or `None` when disabled.
    """
    if not settings.salesforce_oauth_enabled or not settings.database_enabled:
        return None
    engine = build_database_engine_from_settings(settings)
    token_cipher = FernetSalesforceTokenCipher(
        key=read_secret(settings.salesforce_token_encryption_key)
    )

    return SalesforceAuthCoordinator(
        config_repository=PostgresSalesforceAuthConfigRepository(engine=engine),
        connection_repository=PostgresSalesforceConnectionRepository(engine=engine),
        state_repository=PostgresSalesforceOAuthStateRepository(engine=engine),
        gateway=HttpxSalesforceOAuthGateway(client_secret_cipher=token_cipher),
        context_signer=SalesforceOAuthContextSigner(
            secret=read_secret(settings.salesforce_oauth_context_signing_secret),
        ),
        token_cipher=token_cipher,
    )


__all__ = ["build_salesforce_auth_coordinator"]
