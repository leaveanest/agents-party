"""Alembic environment for agents-party database migrations."""

from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context


ROOT_DIR = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agents_party.config import settings  # noqa: E402
from agents_party.infrastructure.postgres.connection import (  # noqa: E402
    build_database_engine_from_settings,
    normalize_database_url,
)
from agents_party.infrastructure.postgres.models import metadata  # noqa: E402


config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = metadata


def _database_url() -> str:
    """Resolve a SQLAlchemy URL for Alembic offline commands.

    Returns:
        SQLAlchemy-compatible URL used for offline migration rendering.

    Raises:
        RuntimeError: If no database settings are configured.
    """
    if settings.database_url:
        return normalize_database_url(settings.database_url)
    if settings.cloud_sql_enabled:
        return f"postgresql+pg8000:///{settings.cloud_sql_database}"
    database_url = config.get_main_option("sqlalchemy.url")
    if database_url:
        return database_url
    raise RuntimeError(
        "Configure DATABASE_URL or the Cloud SQL settings before running Alembic migrations."
    )


def run_migrations_offline() -> None:
    """Run Alembic migrations in offline mode.

    Returns:
        None.
    """
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        compare_server_default=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run Alembic migrations in online mode.

    Returns:
        None.
    """
    connectable = build_database_engine_from_settings(settings)

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
        )

        with context.begin_transaction():
            context.run_migrations()

    connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
