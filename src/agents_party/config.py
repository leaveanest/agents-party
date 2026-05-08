"""Application configuration loaded from environment variables."""

from __future__ import annotations

import json
from typing import Annotated
from urllib.parse import SplitResult, urlsplit, urlunsplit

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    app_name: str = "agents-party"
    app_env: str = "local"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    default_timezone: str = Field(default="UTC", alias="DEFAULT_TIMEZONE")
    agent_selector_model: str | None = Field(
        default=None,
        alias="AGENT_SELECTOR_MODEL",
    )
    work_manager_model: str | None = Field(
        default="google-gla:gemini-3-flash-preview",
        alias="WORK_MANAGER_MODEL",
    )
    web_research_model: str | None = Field(
        default=None,
        alias="WEB_RESEARCH_MODEL",
    )
    google_maps_api_key: SecretStr | None = Field(
        default=None,
        alias="GOOGLE_MAPS_API_KEY",
    )
    google_maps_model: str | None = Field(
        default=None,
        alias="GOOGLE_MAPS_MODEL",
    )
    google_maps_language_code: str = Field(
        default="ja",
        alias="GOOGLE_MAPS_LANGUAGE_CODE",
    )
    google_maps_region_code: str = Field(
        default="JP",
        alias="GOOGLE_MAPS_REGION_CODE",
    )

    slack_bot_token: str | None = Field(default=None, alias="SLACK_BOT_TOKEN")
    slack_signing_secret: str | None = Field(
        default=None,
        alias="SLACK_SIGNING_SECRET",
    )
    slack_app_token: str | None = Field(default=None, alias="SLACK_APP_TOKEN")
    slack_client_id: str | None = Field(default=None, alias="SLACK_CLIENT_ID")

    database_url: str | None = Field(default=None, alias="DATABASE_URL")
    cloud_sql_instance_connection_name: str | None = Field(
        default=None,
        alias="CLOUD_SQL_INSTANCE_CONNECTION_NAME",
    )
    cloud_sql_database: str | None = Field(
        default=None,
        alias="CLOUD_SQL_DATABASE",
    )
    cloud_sql_iam_db_user: str | None = Field(
        default=None,
        alias="CLOUD_SQL_IAM_DB_USER",
    )
    cloud_sql_ip_type: str = Field(default="PUBLIC", alias="CLOUD_SQL_IP_TYPE")

    google_cloud_project: str | None = Field(default=None, alias="GOOGLE_CLOUD_PROJECT")
    google_cloud_location: str = Field(
        default="global",
        alias="GOOGLE_CLOUD_LOCATION",
    )
    google_cloud_speech_location: str = Field(
        default="us",
        alias="GOOGLE_CLOUD_SPEECH_LOCATION",
    )
    google_cloud_transcription_model: str = Field(
        default="chirp_3",
        alias="GOOGLE_CLOUD_TRANSCRIPTION_MODEL",
    )
    google_cloud_transcription_language_codes: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["ja-JP"],
        alias="GOOGLE_CLOUD_TRANSCRIPTION_LANGUAGE_CODES",
    )
    google_cloud_transcription_staging_bucket: str | None = Field(
        default=None,
        alias="GOOGLE_CLOUD_TRANSCRIPTION_STAGING_BUCKET",
    )
    image_generation_model: str = Field(
        default="gemini-2.5-flash-image",
        alias="IMAGE_GENERATION_MODEL",
    )
    video_generation_model: str = Field(
        default="veo-3.1-fast-generate-001",
        alias="VIDEO_GENERATION_MODEL",
    )
    video_generation_prompt_model: str | None = Field(
        default="gemini-2.5-flash",
        alias="VIDEO_GENERATION_PROMPT_MODEL",
    )
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
    salesforce_oauth_redirect_base_url: str | None = Field(
        default=None,
        alias="SALESFORCE_OAUTH_REDIRECT_BASE_URL",
    )
    salesforce_oauth_context_signing_secret: SecretStr | None = Field(
        default=None,
        alias="SALESFORCE_OAUTH_CONTEXT_SIGNING_SECRET",
    )
    salesforce_token_encryption_key: SecretStr | None = Field(
        default=None,
        alias="SALESFORCE_TOKEN_ENCRYPTION_KEY",
    )

    @property
    def slack_enabled(self) -> bool:
        """Return whether the minimum Slack credentials are configured.

        Returns:
            `True` when the signing secret is present and either a static bot token
            or an installation-store-backed Slack configuration is available.
        """
        return bool(
            self.slack_signing_secret
            and (self.slack_bot_token or self.slack_installation_store_enabled)
        )

    @property
    def slack_installation_store_enabled(self) -> bool:
        """Return whether Slack installation persistence can be used.

        Returns:
            `True` when the Slack client id and relational database settings are
            both present.
        """
        return bool(self.slack_client_id and self.database_enabled)

    @property
    def cloud_sql_enabled(self) -> bool:
        """Return whether the minimum Cloud SQL connector settings are present.

        Returns:
            `True` when the Cloud SQL instance, database, and IAM DB user are set.
        """
        return bool(
            self.cloud_sql_instance_connection_name
            and self.cloud_sql_database
            and self.cloud_sql_iam_db_user
        )

    @property
    def database_enabled(self) -> bool:
        """Return whether relational database connectivity is configured.

        Returns:
            `True` when either `DATABASE_URL` or the Cloud SQL connector settings
            are present.
        """
        return bool(self.database_url or self.cloud_sql_enabled)

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
            and self.database_enabled
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

    @property
    def salesforce_oauth_enabled(self) -> bool:
        """Return whether the minimum Salesforce OAuth settings are configured.

        Returns:
            `True` when all shared Salesforce OAuth settings are present.
        """
        return bool(
            has_valid_salesforce_oauth_redirect_base_url(
                self.salesforce_oauth_redirect_base_url
            )
            and has_secret(self.salesforce_oauth_context_signing_secret)
            and has_secret(self.salesforce_token_encryption_key)
            and self.database_enabled
        )

    @property
    def salesforce_oauth_callback_url(self) -> str:
        """Return the registered Salesforce OAuth callback URL.

        Returns:
            Absolute callback URL under the configured redirect base URL.

        Raises:
            ValueError: If the Salesforce OAuth redirect base URL is not configured.
        """
        return (
            read_salesforce_oauth_redirect_base_url(
                self.salesforce_oauth_redirect_base_url
            )
            + "/oauth/salesforce/callback"
        )

    @field_validator("google_cloud_transcription_language_codes", mode="before")
    @classmethod
    def _parse_transcription_language_codes(cls, value: object) -> object:
        """Parse transcription language codes from JSON, CSV, or a single value.

        Args:
            value: Raw setting value supplied by pydantic-settings.

        Returns:
            Normalized list of non-blank language codes.

        Raises:
            ValueError: If the configured value cannot be parsed into language codes.
        """
        if value is None:
            return value
        if isinstance(value, list):
            return [str(code).strip() for code in value if str(code).strip()]
        if not isinstance(value, str):
            raise ValueError("Transcription language codes must be a string or list.")

        raw_value = value.strip()
        if not raw_value:
            return []
        if raw_value.startswith("["):
            try:
                parsed_value = json.loads(raw_value)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    "Transcription language codes must be valid JSON or comma-separated text."
                ) from exc
            if isinstance(parsed_value, str):
                return [parsed_value.strip()] if parsed_value.strip() else []
            if isinstance(parsed_value, list):
                return [str(code).strip() for code in parsed_value if str(code).strip()]
            raise ValueError(
                "Transcription language code JSON must be a string or list."
            )
        return [code.strip() for code in raw_value.split(",") if code.strip()]


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


def has_valid_salesforce_oauth_redirect_base_url(value: str | None) -> bool:
    """Return whether the Salesforce OAuth redirect base URL is valid.

    Args:
        value: Optional Salesforce OAuth redirect base URL.

    Returns:
        `True` when the value is a usable absolute HTTP(S) base URL.
    """
    try:
        read_salesforce_oauth_redirect_base_url(value)
    except ValueError:
        return False
    return True


def read_salesforce_oauth_redirect_base_url(value: str | None) -> str:
    """Return a validated Salesforce OAuth redirect base URL.

    Args:
        value: Optional Salesforce OAuth redirect base URL.

    Returns:
        Normalized absolute HTTP(S) base URL without query or fragment.

    Raises:
        ValueError: If the URL is missing, blank, relative, or otherwise invalid.
    """
    base_url = read_non_blank_text(
        value,
        env_name="SALESFORCE_OAUTH_REDIRECT_BASE_URL",
    )
    split_url = urlsplit(base_url)
    if split_url.scheme not in {"http", "https"} or not split_url.netloc:
        raise ValueError(
            "SALESFORCE_OAUTH_REDIRECT_BASE_URL must be an absolute http(s) URL."
        )
    if split_url.query or split_url.fragment:
        raise ValueError(
            "SALESFORCE_OAUTH_REDIRECT_BASE_URL must not include a query string or fragment."
        )
    normalized_split = SplitResult(
        scheme=split_url.scheme,
        netloc=split_url.netloc,
        path=split_url.path.rstrip("/"),
        query="",
        fragment="",
    )
    return urlunsplit(normalized_split)
