"""Shared SQLAlchemy engine helpers for PostgreSQL-backed repositories."""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from google.cloud.sql.connector import Connector, IPTypes
from sqlalchemy import Engine, create_engine

from agents_party.config import Settings


def _resolve_cloud_sql_ip_type(ip_type: str) -> IPTypes:
    """Map configuration text onto Cloud SQL connector IP type values.

    Args:
        ip_type: Configured Cloud SQL IP type string.

    Returns:
        Connector enum value matching the configured IP type.

    Raises:
        ValueError: If the configured IP type is unsupported.
    """
    normalized = ip_type.strip().upper()
    if normalized == "PUBLIC":
        return IPTypes.PUBLIC
    if normalized == "PRIVATE":
        return IPTypes.PRIVATE
    if normalized == "PSC":
        return IPTypes.PSC
    raise ValueError("CLOUD_SQL_IP_TYPE must be one of PUBLIC, PRIVATE, or PSC.")


def normalize_database_url(database_url: str) -> str:
    """Return a SQLAlchemy-compatible database URL.

    Args:
        database_url: Raw database URL loaded from configuration. Heroku
            Postgres may provide a `postgres://` URL, and manually supplied URLs
            may omit the psycopg driver.

    Returns:
        Database URL normalized for SQLAlchemy engine creation.
    """
    if database_url.startswith("postgres://"):
        return "postgresql+psycopg://" + database_url.removeprefix("postgres://")
    if database_url.startswith("postgresql://"):
        return "postgresql+psycopg://" + database_url.removeprefix("postgresql://")
    return database_url


@lru_cache(maxsize=1)
def build_cloud_sql_connector() -> Connector:
    """Build and cache the shared Cloud SQL connector.

    Returns:
        Process-wide Cloud SQL connector configured for serverless refresh behavior.
    """
    return Connector(refresh_strategy="LAZY")


@lru_cache(maxsize=8)
def build_database_engine(
    database_url: str | None = None,
    *,
    cloud_sql_instance_connection_name: str | None = None,
    cloud_sql_database: str | None = None,
    cloud_sql_iam_db_user: str | None = None,
    cloud_sql_ip_type: str = "PUBLIC",
) -> Engine:
    """Build and cache a SQLAlchemy engine for local or Cloud SQL connectivity.

    Args:
        database_url: Optional SQLAlchemy-compatible database URL override.
        cloud_sql_instance_connection_name: Cloud SQL instance connection name.
        cloud_sql_database: Cloud SQL database name.
        cloud_sql_iam_db_user: IAM DB username used for PostgreSQL auth.
        cloud_sql_ip_type: Cloud SQL connector IP type selector.

    Returns:
        Shared SQLAlchemy engine for the requested database URL.

    Raises:
        ValueError: If neither a direct database URL nor the minimum Cloud SQL
            connector settings are provided.
    """
    if database_url:
        return create_engine(
            normalize_database_url(database_url),
            future=True,
            pool_pre_ping=True,
        )

    if (
        not cloud_sql_instance_connection_name
        or not cloud_sql_database
        or not cloud_sql_iam_db_user
    ):
        raise ValueError(
            "Configure DATABASE_URL or all Cloud SQL settings "
            "(CLOUD_SQL_INSTANCE_CONNECTION_NAME, CLOUD_SQL_DATABASE, "
            "CLOUD_SQL_IAM_DB_USER)."
        )

    connector = build_cloud_sql_connector()
    resolved_ip_type = _resolve_cloud_sql_ip_type(cloud_sql_ip_type)

    def connect_cloud_sql() -> Any:
        """Open a DB-API connection through the Cloud SQL Python Connector.

        Returns:
            Connected DB-API object created by the Cloud SQL connector.
        """
        return connector.connect(
            cloud_sql_instance_connection_name,
            "pg8000",
            user=cloud_sql_iam_db_user,
            db=cloud_sql_database,
            enable_iam_auth=True,
            ip_type=resolved_ip_type,
        )

    return create_engine(
        "postgresql+pg8000://",
        creator=connect_cloud_sql,
        future=True,
        pool_pre_ping=True,
    )


def build_database_engine_from_settings(app_settings: Settings) -> Engine:
    """Build a database engine using the repository's application settings.

    Args:
        app_settings: Application settings that control local or Cloud SQL
            connectivity.

    Returns:
        Shared SQLAlchemy engine for the active deployment settings.
    """
    return build_database_engine(
        database_url=app_settings.database_url,
        cloud_sql_instance_connection_name=(
            app_settings.cloud_sql_instance_connection_name
        ),
        cloud_sql_database=app_settings.cloud_sql_database,
        cloud_sql_iam_db_user=app_settings.cloud_sql_iam_db_user,
        cloud_sql_ip_type=app_settings.cloud_sql_ip_type,
    )


__all__ = [
    "build_cloud_sql_connector",
    "build_database_engine",
    "build_database_engine_from_settings",
    "normalize_database_url",
]
