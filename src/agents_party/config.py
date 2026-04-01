"""Application configuration loaded from environment variables."""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


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


settings = Settings()
