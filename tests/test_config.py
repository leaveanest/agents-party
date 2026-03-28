from __future__ import annotations

import pytest
from pydantic import SecretStr

from agents_party.config import Settings


def test_google_oauth_enabled_rejects_whitespace_only_client_id() -> None:
    """Verify whitespace-only client ids do not enable Google OAuth."""
    settings = Settings.model_validate(
        {
            "GOOGLE_OAUTH_CLIENT_ID": "   ",
            "GOOGLE_OAUTH_CLIENT_SECRET": SecretStr("client-secret"),
            "GOOGLE_OAUTH_REDIRECT_BASE_URL": "https://example.com",
            "GOOGLE_OAUTH_CONTEXT_SIGNING_SECRET": SecretStr("signing-secret"),
            "GOOGLE_TOKEN_ENCRYPTION_KEY": SecretStr("encryption-key"),
        }
    )

    assert settings.google_oauth_enabled is False


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
    settings = Settings.model_validate(
        {"GOOGLE_OAUTH_REDIRECT_BASE_URL": redirect_base_url}
    )

    with pytest.raises(ValueError, match=expected_message):
        _ = settings.google_oauth_callback_url


def test_google_oauth_callback_url_normalizes_trailing_slash() -> None:
    """Verify callback URLs are derived from a normalized redirect base URL."""
    settings = Settings.model_validate(
        {"GOOGLE_OAUTH_REDIRECT_BASE_URL": "https://example.com/app/"}
    )

    assert (
        settings.google_oauth_callback_url
        == "https://example.com/app/oauth/google/callback"
    )


def test_agent_selector_model_defaults_to_none() -> None:
    """Verify the agent router requires explicit selector-model configuration."""
    settings = Settings.model_validate({})

    assert settings.agent_selector_model is None


def test_transcription_settings_default_to_japanese_chirp3_in_us() -> None:
    """Verify transcription defaults target the expected Speech-to-Text setup."""
    settings = Settings.model_validate({})

    assert settings.google_cloud_speech_location == "us"
    assert settings.google_cloud_transcription_model == "chirp_3"
    assert settings.google_cloud_transcription_language_codes == ["ja-JP"]
    assert settings.google_cloud_transcription_staging_bucket is None


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

    settings = Settings()

    assert settings.google_cloud_transcription_language_codes == expected_codes


def test_settings_do_not_expose_legacy_slack_assistant_model() -> None:
    """Verify the legacy Slack-assistant model setting has been removed."""
    settings = Settings.model_validate(
        {"SLACK_ASSISTANT_MODEL": "google-gla:gemini-3-flash-preview"}
    )

    assert hasattr(settings, "slack_assistant_model") is False
