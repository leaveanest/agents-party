"""Tests for PostgreSQL engine construction helpers."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, cast

import pytest

from agents_party.config import Settings
from agents_party.infrastructure.postgres import connection


class FakeCloudSqlConnector:
    """Record Cloud SQL connector invocations for engine-builder tests."""

    def __init__(self) -> None:
        """Initialize an empty call log.

        Returns:
            None.
        """
        self.calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def connect(self, *args: Any, **kwargs: Any) -> object:
        """Capture one Cloud SQL connection request.

        Args:
            *args: Positional connector arguments.
            **kwargs: Keyword connector arguments.

        Returns:
            Opaque stand-in object for the DB-API connection.
        """
        self.calls.append((args, kwargs))
        return object()


def call_engine_creator(engine: Any) -> object:
    """Invoke the SQLAlchemy pool creator with a stable zero-argument type.

    Args:
        engine: SQLAlchemy engine whose low-level creator should be exercised.

    Returns:
        Opaque DB-API connection object returned by the creator.
    """
    creator = cast(Callable[[], object], engine.pool._creator)
    return creator()


@pytest.fixture(autouse=True)
def clear_connection_caches() -> None:
    """Reset cached engines and connectors between tests.

    Returns:
        None.
    """
    connection.build_database_engine.cache_clear()
    connection.build_cloud_sql_connector.cache_clear()


def test_build_database_engine_prefers_database_url_over_cloud_sql() -> None:
    """Verify an explicit database URL bypasses Cloud SQL connector logic.

    Returns:
        None.
    """
    engine = connection.build_database_engine(
        database_url="sqlite+pysqlite:///:memory:",
        cloud_sql_instance_connection_name="project:region:instance",
        cloud_sql_database="agents_party",
        cloud_sql_iam_db_user="runtime",
    )

    assert engine.url.drivername == "sqlite+pysqlite"


def test_build_database_engine_requires_complete_configuration() -> None:
    """Verify engine construction rejects incomplete database settings.

    Returns:
        None.
    """
    with pytest.raises(ValueError):
        connection.build_database_engine(
            cloud_sql_instance_connection_name="project:region:instance",
            cloud_sql_database="agents_party",
        )


def test_build_database_engine_uses_cloud_sql_connector(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify Cloud SQL configuration builds a connector-backed pg8000 engine.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub the connector.

    Returns:
        None.
    """
    fake_connector = FakeCloudSqlConnector()
    monkeypatch.setattr(
        connection,
        "build_cloud_sql_connector",
        lambda: fake_connector,
    )

    engine = connection.build_database_engine(
        cloud_sql_instance_connection_name="project:region:instance",
        cloud_sql_database="agents_party",
        cloud_sql_iam_db_user="runtime-user",
    )

    created_connection = call_engine_creator(engine)

    assert engine.url.drivername == "postgresql+pg8000"
    assert created_connection is not None
    assert len(fake_connector.calls) == 1
    args, kwargs = fake_connector.calls[0]
    assert args == ("project:region:instance", "pg8000")
    assert kwargs["user"] == "runtime-user"
    assert kwargs["db"] == "agents_party"
    assert kwargs["enable_iam_auth"] is True
    assert kwargs["ip_type"] == connection.IPTypes.PUBLIC


def test_build_database_engine_from_settings_supports_cloud_sql(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify settings-based engine construction uses Cloud SQL inputs.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub the connector.

    Returns:
        None.
    """
    fake_connector = FakeCloudSqlConnector()
    monkeypatch.setattr(
        connection,
        "build_cloud_sql_connector",
        lambda: fake_connector,
    )
    app_settings = Settings.model_validate(
        {
            "cloud_sql_instance_connection_name": "project:region:instance",
            "cloud_sql_database": "agents_party",
            "cloud_sql_iam_db_user": "runtime-user",
            "work_manager_model": "google-gla:gemini-3-flash-preview",
        }
    )

    engine = connection.build_database_engine_from_settings(app_settings)
    call_engine_creator(engine)

    assert engine.url.drivername == "postgresql+pg8000"
    assert fake_connector.calls[0][1]["ip_type"] == connection.IPTypes.PUBLIC
