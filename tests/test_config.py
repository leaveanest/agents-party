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
