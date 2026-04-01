"""Tests for the SQLModel-backed Slack installation store."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from slack_sdk.oauth.installation_store.models.installation import Installation
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from agents_party.infrastructure.postgres import PostgresSlackInstallationStore
from agents_party.infrastructure.postgres.models import ensure_schema


def make_engine():
    """Build a reusable in-memory engine for installation-store tests.

    Returns:
        SQLite engine configured to persist across multiple connections.
    """
    return create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )


def build_seeded_engine():
    """Create an in-memory engine with the relational schema initialized.

    Returns:
        SQLite engine prepared with the repository schema for tests.
    """
    engine = make_engine()
    ensure_schema(engine)
    return engine


def build_installation(
    *,
    user_id: str,
    installed_at: datetime,
    bot_token: str | None = "xoxb-bot-token",
    bot_id: str | None = "B111",
    bot_user_id: str | None = "UBOT",
) -> Installation:
    """Build a representative Slack installation entity for tests.

    Args:
        user_id: Installer user id.
        installed_at: Installation timestamp.
        bot_token: Optional bot token to include in the installation.
        bot_id: Optional bot id to include in the installation.
        bot_user_id: Optional bot user id to include in the installation.

    Returns:
        Slack SDK installation entity configured for repository tests.
    """
    return Installation(
        app_id="A111",
        enterprise_id=None,
        enterprise_name=None,
        enterprise_url=None,
        team_id="T111",
        team_name="Workspace",
        bot_token=bot_token,
        bot_id=bot_id,
        bot_user_id=bot_user_id,
        bot_scopes=["commands", "chat:write"] if bot_token is not None else [],
        bot_refresh_token="bot-refresh" if bot_token is not None else None,
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
        custom_values={"tenant": "alpha", "source": "oauth"},
    )


def test_save_and_find_installation_preserve_standard_fields_and_custom_values() -> (
    None
):
    """Verify the store persists Slack installations and custom payload values.

    Returns:
        None.
    """
    store = PostgresSlackInstallationStore(
        client_id="123.456",
        engine=build_seeded_engine(),
    )
    installed_at = datetime(2026, 4, 1, 9, 0, tzinfo=UTC)

    store.save(build_installation(user_id="U111", installed_at=installed_at))

    installation = store.find_installation(
        enterprise_id=None,
        team_id="T111",
    )
    bot = store.find_bot(
        enterprise_id=None,
        team_id="T111",
    )

    assert installation is not None
    assert installation.user_id == "U111"
    assert installation.bot_token == "xoxb-bot-token"
    assert installation.get_custom_value("tenant") == "alpha"
    assert bot is not None
    assert bot.bot_user_id == "UBOT"


def test_find_installation_for_user_rehydrates_latest_bot_token() -> None:
    """Verify user-level installation lookups borrow the latest bot token.

    Returns:
        None.
    """
    store = PostgresSlackInstallationStore(
        client_id="123.456",
        engine=build_seeded_engine(),
    )
    base_installed_at = datetime(2026, 4, 1, 9, 0, tzinfo=UTC)
    user_installed_at = datetime(2026, 4, 1, 10, 0, tzinfo=UTC)

    store.save(build_installation(user_id="U111", installed_at=base_installed_at))
    store.save(
        build_installation(
            user_id="U222",
            installed_at=user_installed_at,
            bot_token=None,
            bot_id=None,
            bot_user_id=None,
        )
    )

    installation = store.find_installation(
        enterprise_id=None,
        team_id="T111",
        user_id="U222",
    )

    assert installation is not None
    assert installation.user_id == "U222"
    assert installation.bot_token == "xoxb-bot-token"
    assert installation.bot_id == "B111"
    assert installation.bot_user_id == "UBOT"


def test_delete_installation_and_bot_remove_rows_for_scope() -> None:
    """Verify deletion removes stored installation and bot rows.

    Returns:
        None.
    """
    store = PostgresSlackInstallationStore(
        client_id="123.456",
        engine=build_seeded_engine(),
    )
    installed_at = datetime(2026, 4, 1, 9, 0, tzinfo=UTC)

    store.save(build_installation(user_id="U111", installed_at=installed_at))
    store.delete_installation(
        enterprise_id=None,
        team_id="T111",
        user_id="U111",
    )
    store.delete_bot(
        enterprise_id=None,
        team_id="T111",
    )

    assert (
        store.find_installation(
            enterprise_id=None,
            team_id="T111",
            user_id="U111",
        )
        is None
    )
    assert store.find_bot(enterprise_id=None, team_id="T111") is None


@pytest.mark.asyncio
async def test_async_methods_delegate_to_the_same_store_behavior() -> None:
    """Verify the async installation-store interface works with the same tables.

    Returns:
        None.
    """
    store = PostgresSlackInstallationStore(
        client_id="123.456",
        engine=build_seeded_engine(),
    )
    installed_at = datetime(2026, 4, 1, 9, 0, tzinfo=UTC)

    await store.async_save(
        build_installation(user_id="U111", installed_at=installed_at)
    )
    installation = await store.async_find_installation(
        enterprise_id=None,
        team_id="T111",
        user_id="U111",
    )

    assert installation is not None
    assert installation.user_token == "xoxp-U111"
