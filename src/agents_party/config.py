from pydantic import Field
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
    work_manager_model: str | None = Field(
        default="google-gla:gemini-3-flash-preview",
        alias="WORK_MANAGER_MODEL",
    )

    slack_bot_token: str | None = Field(default=None, alias="SLACK_BOT_TOKEN")
    slack_signing_secret: str | None = Field(default=None, alias="SLACK_SIGNING_SECRET")
    slack_app_token: str | None = Field(default=None, alias="SLACK_APP_TOKEN")

    google_cloud_project: str | None = Field(default=None, alias="GOOGLE_CLOUD_PROJECT")
    firestore_database: str = Field(default="(default)", alias="FIRESTORE_DATABASE")

    @property
    def slack_enabled(self) -> bool:
        """Return whether the minimum Slack credentials are configured.

        Returns:
            `True` when both the bot token and signing secret are present.
        """
        return bool(self.slack_bot_token and self.slack_signing_secret)


settings = Settings()
