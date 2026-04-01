"""Shared SQLModel helpers for PostgreSQL-backed persistence models."""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Column, Engine
from sqlmodel import Field, SQLModel


def json_payload_field() -> Any:
    """Build a JSON payload field used by persisted record models.

    Returns:
        SQLModel field configured to store arbitrary JSON payload data.
    """
    return Field(sa_column=Column(JSON, nullable=False))


def ensure_schema(engine: Engine) -> None:
    """Create the relational schema directly for tests or disposable local setup.

    Args:
        engine: SQLAlchemy engine bound to the target database.

    Returns:
        None.

    Notes:
        Alembic should own schema changes for real environments. This helper exists
        so repository tests can bootstrap isolated databases without invoking the
        migration CLI.
    """
    SQLModel.metadata.create_all(engine)


__all__ = ["ensure_schema", "json_payload_field"]
