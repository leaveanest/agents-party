from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "agents-party"
    app_env: str = "local"
    app_host: str = "0.0.0.0"
    app_port: int = 8000

    slack_bot_token: str | None = Field(default=None, alias="SLACK_BOT_TOKEN")
    slack_signing_secret: str | None = Field(default=None, alias="SLACK_SIGNING_SECRET")
    slack_app_token: str | None = Field(default=None, alias="SLACK_APP_TOKEN")

    google_cloud_project: str | None = Field(default=None, alias="GOOGLE_CLOUD_PROJECT")
    firestore_database: str = Field(default="(default)", alias="FIRESTORE_DATABASE")

    @property
    def slack_enabled(self) -> bool:
        return bool(self.slack_bot_token and self.slack_signing_secret)


settings = Settings()
