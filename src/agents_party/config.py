"""Application configuration loaded from environment variables."""

from urllib.parse import SplitResult, urlsplit, urlunsplit

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "agents-party"
    app_env: str = "local"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    default_timezone: str = Field(default="UTC", alias="DEFAULT_TIMEZONE")
    agent_selector_model: str | None = Field(
        default="google-gla:gemini-3-flash-preview",
        alias="AGENT_SELECTOR_MODEL",
    )
    slack_assistant_model: str | None = Field(
        default=None,
        alias="SLACK_ASSISTANT_MODEL",
    )
    work_manager_model: str | None = Field(
        default="google-gla:gemini-3-flash-preview",
        alias="WORK_MANAGER_MODEL",
    )
    web_research_model: str | None = Field(
        default=None,
        alias="WEB_RESEARCH_MODEL",
    )

    slack_bot_token: str | None = Field(default=None, alias="SLACK_BOT_TOKEN")
    slack_signing_secret: str | None = Field(default=None, alias="SLACK_SIGNING_SECRET")
    slack_app_token: str | None = Field(default=None, alias="SLACK_APP_TOKEN")

    google_cloud_project: str | None = Field(default=None, alias="GOOGLE_CLOUD_PROJECT")
    firestore_database: str = Field(default="(default)", alias="FIRESTORE_DATABASE")
    google_oauth_client_id: str | None = Field(
        default=None,
        alias="GOOGLE_OAUTH_CLIENT_ID",
    )
    google_oauth_client_secret: SecretStr | None = Field(
        default=None,
        alias="GOOGLE_OAUTH_CLIENT_SECRET",
    )
    google_oauth_redirect_base_url: str | None = Field(
        default=None,
        alias="GOOGLE_OAUTH_REDIRECT_BASE_URL",
    )
    google_oauth_context_signing_secret: SecretStr | None = Field(
        default=None,
        alias="GOOGLE_OAUTH_CONTEXT_SIGNING_SECRET",
    )
    google_token_encryption_key: SecretStr | None = Field(
        default=None,
        alias="GOOGLE_TOKEN_ENCRYPTION_KEY",
    )

    @property
    def slack_enabled(self) -> bool:
        """Return whether the minimum Slack credentials are configured.

        Returns:
            `True` when both the bot token and signing secret are present.
        """
        return bool(self.slack_bot_token and self.slack_signing_secret)

    @property
    def google_oauth_enabled(self) -> bool:
        """Return whether the minimum Google OAuth settings are configured.

        Returns:
            `True` when all required Google OAuth settings are present.
        """
        return bool(
            has_text(self.google_oauth_client_id)
            and has_secret(self.google_oauth_client_secret)
            and has_valid_google_oauth_redirect_base_url(
                self.google_oauth_redirect_base_url
            )
            and has_secret(self.google_oauth_context_signing_secret)
            and has_secret(self.google_token_encryption_key)
        )

    @property
    def google_oauth_callback_url(self) -> str:
        """Return the registered Google OAuth callback URL.

        Returns:
            Absolute callback URL under the configured redirect base URL.

        Raises:
            ValueError: If the Google OAuth redirect base URL is not configured.
        """
        return (
            read_google_oauth_redirect_base_url(self.google_oauth_redirect_base_url)
            + "/oauth/google/callback"
        )


settings = Settings()


def has_text(value: str | None) -> bool:
    """Return whether a string setting is present and non-blank.

    Args:
        value: Optional string value loaded from settings.

    Returns:
        `True` when a non-blank value is present.
    """
    return value is not None and bool(value.strip())


def read_non_blank_text(value: str | None, *, env_name: str) -> str:
    """Return a required string setting after trimming outer whitespace.

    Args:
        value: Optional string value loaded from settings.
        env_name: Environment variable name used in error messages.

    Returns:
        Trimmed string value.

    Raises:
        ValueError: If the setting is missing or blank.
    """
    if value is None:
        raise ValueError(f"{env_name} is not configured.")
    normalized_value = value.strip()
    if not normalized_value:
        raise ValueError(f"{env_name} is not configured.")
    return normalized_value


def has_secret(value: SecretStr | None) -> bool:
    """Return whether a settings secret is present and non-blank.

    Args:
        value: Optional secret wrapper loaded from settings.

    Returns:
        `True` when a non-blank secret value is present.
    """
    return value is not None and bool(value.get_secret_value().strip())


def read_secret(value: SecretStr | None) -> str:
    """Return a secret value as plaintext.

    Args:
        value: Optional secret wrapper loaded from settings.

    Returns:
        Plaintext secret value.

    Raises:
        ValueError: If the secret is missing or blank.
    """
    if value is None:
        raise ValueError("Required secret is not configured.")
    secret_value = value.get_secret_value().strip()
    if not secret_value:
        raise ValueError("Required secret is not configured.")
    return secret_value


def has_valid_google_oauth_redirect_base_url(value: str | None) -> bool:
    """Return whether the Google OAuth redirect base URL is valid.

    Args:
        value: Optional Google OAuth redirect base URL.

    Returns:
        `True` when the value is a usable absolute HTTP(S) base URL.
    """
    try:
        read_google_oauth_redirect_base_url(value)
    except ValueError:
        return False
    return True


def read_google_oauth_redirect_base_url(value: str | None) -> str:
    """Return a validated Google OAuth redirect base URL.

    Args:
        value: Optional Google OAuth redirect base URL.

    Returns:
        Normalized absolute HTTP(S) base URL without query or fragment.

    Raises:
        ValueError: If the URL is missing, blank, relative, or otherwise invalid.
    """
    base_url = read_non_blank_text(
        value,
        env_name="GOOGLE_OAUTH_REDIRECT_BASE_URL",
    )
    split_url = urlsplit(base_url)
    if split_url.scheme not in {"http", "https"} or not split_url.netloc:
        raise ValueError(
            "GOOGLE_OAUTH_REDIRECT_BASE_URL must be an absolute http(s) URL."
        )
    if split_url.query or split_url.fragment:
        raise ValueError(
            "GOOGLE_OAUTH_REDIRECT_BASE_URL must not include a query string or fragment."
        )
    normalized_split = SplitResult(
        scheme=split_url.scheme,
        netloc=split_url.netloc,
        path=split_url.path.rstrip("/"),
        query="",
        fragment="",
    )
    return urlunsplit(normalized_split)
