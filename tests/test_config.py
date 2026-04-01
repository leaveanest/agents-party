"""Tests for application settings behavior."""

from __future__ import annotations

from agents_party.config import Settings


def test_database_enabled_is_true_for_database_url() -> None:
    """Verify a direct database URL enables relational persistence.

    Returns:
        None.
    """
    app_settings = Settings.model_validate(
        {"database_url": "sqlite+pysqlite:///:memory:"}
    )

    assert app_settings.database_enabled is True
    assert app_settings.cloud_sql_enabled is False


def test_cloud_sql_enabled_requires_complete_configuration() -> None:
    """Verify Cloud SQL mode requires instance, database, and IAM user.

    Returns:
        None.
    """
    app_settings = Settings.model_validate(
        {
            "cloud_sql_instance_connection_name": "project:region:instance",
            "cloud_sql_database": "agents_party",
            "cloud_sql_iam_db_user": "runtime-user",
        }
    )

    assert app_settings.cloud_sql_enabled is True
    assert app_settings.database_enabled is True
    assert app_settings.cloud_sql_ip_type == "PUBLIC"


def test_database_enabled_is_false_without_any_database_configuration() -> None:
    """Verify the app reports missing database config when nothing is set.

    Returns:
        None.
    """
    app_settings = Settings.model_validate({})

    assert app_settings.cloud_sql_enabled is False
    assert app_settings.database_enabled is False


def test_slack_installation_store_enabled_requires_client_id_and_database() -> None:
    """Verify Slack installation persistence requires client id plus DB config.

    Returns:
        None.
    """
    app_settings = Settings.model_validate(
        {
            "slack_client_id": "123.456",
            "database_url": "sqlite+pysqlite:///:memory:",
        }
    )

    assert app_settings.slack_installation_store_enabled is True


def test_slack_enabled_supports_db_backed_installation_store_mode() -> None:
    """Verify Slack can be enabled without a static token in store-backed mode.

    Returns:
        None.
    """
    app_settings = Settings.model_validate(
        {
            "slack_signing_secret": "signing-secret",
            "slack_client_id": "123.456",
            "database_url": "sqlite+pysqlite:///:memory:",
        }
    )

    assert app_settings.slack_installation_store_enabled is True
    assert app_settings.slack_enabled is True
