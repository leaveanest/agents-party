"""Tests for application settings behavior."""

from __future__ import annotations

import pytest
from pydantic import SecretStr

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


def test_google_oauth_enabled_rejects_whitespace_only_client_id() -> None:
    """Verify whitespace-only client ids do not enable Google OAuth."""
    app_settings = Settings.model_validate(
        {
            "GOOGLE_OAUTH_CLIENT_ID": "   ",
            "GOOGLE_OAUTH_CLIENT_SECRET": SecretStr("client-secret"),
            "GOOGLE_OAUTH_REDIRECT_BASE_URL": "https://example.com",
            "GOOGLE_OAUTH_CONTEXT_SIGNING_SECRET": SecretStr("signing-secret"),
            "GOOGLE_TOKEN_ENCRYPTION_KEY": SecretStr("encryption-key"),
            "DATABASE_URL": "sqlite+pysqlite:///:memory:",
        }
    )

    assert app_settings.google_oauth_enabled is False


@pytest.mark.parametrize(
    ("redirect_base_url", "expected_message"),
    [
        ("/relative", "absolute http"),
        ("https://example.com?foo=bar", "must not include a query string or fragment"),
    ],
)
def test_google_oauth_callback_url_rejects_invalid_redirect_base_urls(
    redirect_base_url: str,
    expected_message: str,
) -> None:
    """Verify invalid redirect base URLs fail fast when building callback URLs."""
    app_settings = Settings.model_validate(
        {"GOOGLE_OAUTH_REDIRECT_BASE_URL": redirect_base_url}
    )

    with pytest.raises(ValueError, match=expected_message):
        _ = app_settings.google_oauth_callback_url


def test_google_oauth_callback_url_normalizes_trailing_slash() -> None:
    """Verify callback URLs are derived from a normalized redirect base URL."""
    app_settings = Settings.model_validate(
        {"GOOGLE_OAUTH_REDIRECT_BASE_URL": "https://example.com/app/"}
    )

    assert (
        app_settings.google_oauth_callback_url
        == "https://example.com/app/oauth/google/callback"
    )


def test_agent_selector_model_defaults_to_none() -> None:
    """Verify the agent router requires explicit selector-model configuration."""
    app_settings = Settings.model_validate({})

    assert app_settings.agent_selector_model is None


def test_transcription_settings_default_to_japanese_chirp3_in_us() -> None:
    """Verify transcription defaults target the expected Speech-to-Text setup."""
    app_settings = Settings.model_validate({})

    assert app_settings.google_cloud_speech_location == "us"
    assert app_settings.google_cloud_transcription_model == "chirp_3"
    assert app_settings.google_cloud_transcription_language_codes == ["ja-JP"]
    assert app_settings.google_cloud_transcription_staging_bucket is None


@pytest.mark.parametrize(
    ("raw_value", "expected_codes"),
    [
        ("ja-JP", ["ja-JP"]),
        ("ja-JP,en-US", ["ja-JP", "en-US"]),
        ('["ja-JP", "en-US"]', ["ja-JP", "en-US"]),
    ],
)
def test_transcription_language_codes_accept_common_env_formats(
    monkeypatch: pytest.MonkeyPatch,
    raw_value: str,
    expected_codes: list[str],
) -> None:
    """Verify transcription language codes parse from common environment formats."""
    monkeypatch.setenv("GOOGLE_CLOUD_TRANSCRIPTION_LANGUAGE_CODES", raw_value)

    app_settings = Settings()

    assert app_settings.google_cloud_transcription_language_codes == expected_codes


def test_settings_do_not_expose_legacy_slack_assistant_model() -> None:
    """Verify the legacy Slack-assistant model setting has been removed."""
    app_settings = Settings.model_validate(
        {"SLACK_ASSISTANT_MODEL": "google-gla:gemini-3-flash-preview"}
    )

    assert hasattr(app_settings, "slack_assistant_model") is False
