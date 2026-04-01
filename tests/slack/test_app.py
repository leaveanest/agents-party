"""Tests for Slack Bolt app initialization and authorization wiring."""

from __future__ import annotations

from datetime import UTC, datetime
import logging

import pytest
from slack_bolt.context.async_context import AsyncBoltContext
from slack_sdk.oauth.installation_store.models.installation import Installation
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from agents_party.config import Settings
from agents_party.infrastructure.postgres import PostgresSlackInstallationStore
from agents_party.infrastructure.postgres.models import ensure_schema
from agents_party.slack import app as slack_app_module


def build_test_engine():
    """Create a reusable in-memory SQLAlchemy engine for Slack app tests.

    Returns:
        SQLite engine configured to keep the relational schema across sessions.
    """
    return create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )


def build_installation(*, user_id: str, installed_at: datetime) -> Installation:
    """Build a representative Slack installation entity for authorization tests.

    Args:
        user_id: Slack user id for the installing user.
        installed_at: Timestamp to assign to the stored installation.

    Returns:
        Slack installation entity with bot and user credentials populated.
    """
    return Installation(
        app_id="A111",
        enterprise_id=None,
        enterprise_name=None,
        enterprise_url=None,
        team_id="T111",
        team_name="Workspace",
        bot_token="xoxb-stored-token",
        bot_id="B111",
        bot_user_id="UBOT",
        bot_scopes=["commands", "chat:write"],
        bot_refresh_token="bot-refresh",
        bot_token_expires_at=installed_at,
        user_id=user_id,
        user_token=f"xoxp-{user_id}",
        user_scopes=["channels:history"],
        user_refresh_token=f"user-refresh-{user_id}",
        user_token_expires_at=installed_at,
        incoming_webhook_url="https://example.com/webhook",
        incoming_webhook_channel="#general",
        incoming_webhook_channel_id="C111",
        incoming_webhook_configuration_url="https://example.com/config",
        is_enterprise_install=False,
        token_type="bot",
        installed_at=installed_at,
        custom_values={"tenant": "alpha"},
    )


def build_context() -> AsyncBoltContext:
    """Create a minimal Bolt request context for authorize callback tests.

    Returns:
        Async Bolt context with workspace-scoped installation semantics.
    """
    return AsyncBoltContext(
        {
            "is_enterprise_install": False,
            "logger": logging.getLogger(__name__),
        }
    )


def test_create_bolt_app_keeps_static_token_when_store_is_disabled() -> None:
    """Verify single-workspace mode keeps using the configured bot token.

    Returns:
        None.
    """
    app_settings = Settings.model_validate(
        {
            "slack_bot_token": "xoxb-static-token",
            "slack_signing_secret": "signing-secret",
        }
    )

    app = slack_app_module.create_bolt_app(app_settings)

    assert app.installation_store is None
    assert app.client.token == "xoxb-static-token"


@pytest.mark.asyncio
async def test_create_bolt_app_wires_installation_store_and_static_token_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify DB-backed installs are wired without breaking static token auth.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to inject a test engine.

    Returns:
        None.
    """
    engine = build_test_engine()
    ensure_schema(engine)
    monkeypatch.setattr(
        slack_app_module,
        "build_database_engine_from_settings",
        lambda _settings: engine,
    )
    app_settings = Settings.model_validate(
        {
            "slack_bot_token": "xoxb-static-token",
            "slack_signing_secret": "signing-secret",
            "slack_client_id": "123.456",
            "database_url": "sqlite+pysqlite:///:memory:",
        }
    )

    app = slack_app_module.create_bolt_app(app_settings)
    authorize = app._async_authorize

    assert isinstance(app.installation_store, PostgresSlackInstallationStore)
    assert app.client.token is None
    assert authorize is not None

    auth_result = await authorize(
        context=build_context(),
        enterprise_id=None,
        team_id="T111",
        user_id="U111",
    )

    assert auth_result is not None
    assert auth_result.bot_token == "xoxb-static-token"


@pytest.mark.asyncio
async def test_create_bolt_app_prefers_stored_installation_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify stored Slack installations are used before the static token.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to inject a test engine.

    Returns:
        None.
    """
    engine = build_test_engine()
    ensure_schema(engine)
    store = PostgresSlackInstallationStore(client_id="123.456", engine=engine)
    store.save(
        build_installation(
            user_id="U111",
            installed_at=datetime(2026, 4, 1, 12, 0, tzinfo=UTC),
        )
    )
    monkeypatch.setattr(
        slack_app_module,
        "build_database_engine_from_settings",
        lambda _settings: engine,
    )
    app_settings = Settings.model_validate(
        {
            "slack_bot_token": "xoxb-static-token",
            "slack_signing_secret": "signing-secret",
            "slack_client_id": "123.456",
            "database_url": "sqlite+pysqlite:///:memory:",
        }
    )

    app = slack_app_module.create_bolt_app(app_settings)
    authorize = app._async_authorize

    assert authorize is not None

    auth_result = await authorize(
        context=build_context(),
        enterprise_id=None,
        team_id="T111",
        user_id="U111",
    )

    assert auth_result is not None
    assert auth_result.bot_token == "xoxb-stored-token"
    assert auth_result.user_token == "xoxp-U111"
