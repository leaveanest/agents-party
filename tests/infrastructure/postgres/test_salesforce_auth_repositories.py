"""Tests for the PostgreSQL-backed Salesforce OAuth repositories."""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from agents_party.domain.salesforce_auth import (
    SalesforceConnectionDocument,
    SalesforceOAuthStateDocument,
    SalesforceWorkspaceAuthConfigDocument,
)
from agents_party.infrastructure.postgres import (
    PostgresSalesforceAuthConfigRepository,
    PostgresSalesforceConnectionRepository,
    PostgresSalesforceOAuthStateRepository,
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


def build_config(
    *,
    salesforce_org_id: str = "00D1",
) -> SalesforceWorkspaceAuthConfigDocument:
    """Build a Salesforce workspace auth config document for tests.

    Args:
        salesforce_org_id: Salesforce org id for the config.

    Returns:
        Salesforce workspace auth config document.
    """
    return SalesforceWorkspaceAuthConfigDocument(
        team_id="T1",
        salesforce_org_id=salesforce_org_id,
        salesforce_org_name="Acme",
        salesforce_my_domain_host="acme.my.salesforce.com",
        oauth_client_id="client-id",
        oauth_client_secret_encrypted="enc:client-secret",
        redirect_uri="https://example.com/oauth/salesforce/callback",
    )


def build_connection(
    *,
    slack_user_id: str,
    salesforce_org_id: str,
) -> SalesforceConnectionDocument:
    """Build a Salesforce OAuth connection document for tests.

    Args:
        slack_user_id: Slack user id owning the connection.
        salesforce_org_id: Salesforce org id for the connection.

    Returns:
        Salesforce OAuth connection document.
    """
    return SalesforceConnectionDocument(
        team_id="T1",
        slack_user_id=slack_user_id,
        salesforce_org_id=salesforce_org_id,
        salesforce_user_id=f"user-{salesforce_org_id}",
        salesforce_username=f"{salesforce_org_id}@example.com",
        access_token_encrypted=f"enc:{salesforce_org_id}:access",
        refresh_token_encrypted=f"enc:{salesforce_org_id}:refresh",
    )


def test_salesforce_auth_config_repository_round_trips_config() -> None:
    """Verify workspace auth config repository stores and updates configs."""
    repository = PostgresSalesforceAuthConfigRepository(engine=build_seeded_engine())
    config = build_config()
    updated_config = config.model_copy(
        update={
            "salesforce_org_name": "Acme Updated",
            "oauth_client_id": "updated-client-id",
        }
    )

    repository.upsert_config(config=config)
    repository.upsert_config(config=updated_config)

    assert (
        repository.get_config(team_id="T1", salesforce_org_id="00D1") == updated_config
    )
    assert repository.get_config(team_id="T1", salesforce_org_id="missing") is None


def test_salesforce_connection_repository_lists_multiple_orgs_for_user() -> None:
    """Verify the repository lists multiple Salesforce orgs under one Slack user."""
    repository = PostgresSalesforceConnectionRepository(engine=build_seeded_engine())
    connection_one = build_connection(slack_user_id="U1", salesforce_org_id="00D1")
    connection_two = build_connection(slack_user_id="U1", salesforce_org_id="00D2")
    connection_three = build_connection(slack_user_id="U2", salesforce_org_id="00D3")

    repository.upsert_connection(connection=connection_one)
    repository.upsert_connection(connection=connection_two)
    repository.upsert_connection(connection=connection_three)

    connections = repository.list_connections(team_id="T1", slack_user_id="U1")

    assert [connection.salesforce_org_id for connection in connections] == [
        "00D1",
        "00D2",
    ]
    assert (
        repository.get_connection(
            team_id="T1",
            slack_user_id="U1",
            salesforce_org_id="00D2",
        )
        == connection_two
    )


def test_salesforce_oauth_state_repository_consumes_state_atomically() -> None:
    """Verify consuming OAuth state returns it once and deletes it atomically."""
    repository = PostgresSalesforceOAuthStateRepository(engine=build_seeded_engine())
    state = SalesforceOAuthStateDocument(
        state_id="consume-state",
        team_id="T1",
        slack_user_id="U1",
        salesforce_org_id="00D1",
        pkce_code_verifier_encrypted="enc:verifier",
    )

    repository.create_state(state=state)

    first_consume = repository.consume_state(team_id="T1", state_id="consume-state")
    second_consume = repository.consume_state(team_id="T1", state_id="consume-state")

    assert first_consume == state
    assert second_consume is None
    assert repository.get_state(team_id="T1", state_id="consume-state") is None
