"""Tests for the PostgreSQL-backed Google OAuth repositories."""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from agents_party.domain.google_auth import (
    GoogleAuthConnectionDocument,
    GoogleOAuthStateDocument,
)
from agents_party.infrastructure.postgres import (
    PostgresGoogleAuthConnectionRepository,
    PostgresGoogleOAuthStateRepository,
)
from agents_party.infrastructure.postgres.models import ensure_schema


def make_engine():
    """Build a reusable in-memory engine for repository tests.

    Returns:
        SQLite engine configured to persist across multiple connections.
    """
    return create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )


def build_seeded_engine():
    """Create an in-memory engine with the relational schema initialized.

    Returns:
        SQLite engine prepared with the repository schema for tests.
    """
    engine = make_engine()
    ensure_schema(engine)
    return engine


def build_connection(
    *,
    slack_user_id: str,
    subject: str,
) -> GoogleAuthConnectionDocument:
    """Build a Google OAuth connection document for repository tests.

    Args:
        slack_user_id: Slack user id owning the connection.
        subject: Stable Google `sub` value for the account.

    Returns:
        Google OAuth connection document.
    """
    return GoogleAuthConnectionDocument(
        team_id="T1",
        slack_user_id=slack_user_id,
        google_account_subject=subject,
        google_account_email=f"{subject}@example.com",
        google_account_email_verified=True,
        granted_scopes=["openid", "email"],
        access_token_encrypted=f"enc:{subject}:access",
        refresh_token_encrypted=f"enc:{subject}:refresh",
    )


def test_google_auth_connection_repository_lists_multiple_accounts_for_same_user() -> (
    None
):
    """Verify the repository lists multiple Google accounts under one Slack user.

    Returns:
        None.
    """
    repository = PostgresGoogleAuthConnectionRepository(engine=build_seeded_engine())
    connection_one = build_connection(slack_user_id="U1", subject="sub-one")
    connection_two = build_connection(slack_user_id="U1", subject="sub-two")
    connection_three = build_connection(slack_user_id="U2", subject="sub-three")

    repository.upsert_connection(connection=connection_one)
    repository.upsert_connection(connection=connection_two)
    repository.upsert_connection(connection=connection_three)

    connections = repository.list_connections(team_id="T1", slack_user_id="U1")

    assert [connection.google_account_subject for connection in connections] == [
        "sub-one",
        "sub-two",
    ]
    assert (
        repository.get_connection(
            team_id="T1",
            slack_user_id="U1",
            google_account_subject="sub-two",
        )
        == connection_two
    )


def test_google_oauth_state_repository_round_trips_and_deletes_state() -> None:
    """Verify the state repository stores, reads, and deletes OAuth state.

    Returns:
        None.
    """
    repository = PostgresGoogleOAuthStateRepository(engine=build_seeded_engine())
    state = GoogleOAuthStateDocument(
        state_id="T1.state",
        team_id="T1",
        slack_user_id="U1",
        redirect_after_connect="https://example.com/app",
    )

    repository.create_state(state=state)
    stored_state = repository.get_state(team_id="T1", state_id="T1.state")
    repository.delete_state(team_id="T1", state_id="T1.state")

    assert stored_state == state
    assert repository.get_state(team_id="T1", state_id="T1.state") is None


def test_google_oauth_state_repository_consumes_state_atomically() -> None:
    """Verify consuming OAuth state returns it once and deletes it atomically.

    Returns:
        None.
    """
    repository = PostgresGoogleOAuthStateRepository(engine=build_seeded_engine())
    state = GoogleOAuthStateDocument(
        state_id="consume-state",
        team_id="T1",
        slack_user_id="U1",
    )

    repository.create_state(state=state)

    first_consume = repository.consume_state(team_id="T1", state_id="consume-state")
    second_consume = repository.consume_state(team_id="T1", state_id="consume-state")

    assert first_consume == state
    assert second_consume is None
    assert repository.get_state(team_id="T1", state_id="consume-state") is None
