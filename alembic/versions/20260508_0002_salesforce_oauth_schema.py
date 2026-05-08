"""Add Salesforce OAuth persistence tables."""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260508_0002"
down_revision = "20260330_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create Salesforce OAuth configuration, connection, and state tables."""
    op.create_table(
        "salesforce_auth_configs",
        sa.Column("team_id", sa.String(), nullable=False),
        sa.Column("salesforce_org_id", sa.String(), nullable=False),
        sa.Column("salesforce_my_domain_host", sa.String(), nullable=False),
        sa.Column("oauth_client_id", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("team_id", "salesforce_org_id"),
    )
    op.create_index(
        "ix_salesforce_auth_configs_status",
        "salesforce_auth_configs",
        ["team_id", "status"],
        unique=False,
    )

    op.create_table(
        "salesforce_connections",
        sa.Column("team_id", sa.String(), nullable=False),
        sa.Column("slack_user_id", sa.String(), nullable=False),
        sa.Column("salesforce_org_id", sa.String(), nullable=False),
        sa.Column("salesforce_user_id", sa.String(), nullable=False),
        sa.Column("salesforce_username", sa.String(), nullable=True),
        sa.Column("connection_status", sa.String(), nullable=False),
        sa.Column("token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("team_id", "slack_user_id", "salesforce_org_id"),
    )
    op.create_index(
        "ix_salesforce_connections_status",
        "salesforce_connections",
        ["team_id", "connection_status"],
        unique=False,
    )

    op.create_table(
        "salesforce_oauth_states",
        sa.Column("team_id", sa.String(), nullable=False),
        sa.Column("state_id", sa.String(), nullable=False),
        sa.Column("slack_user_id", sa.String(), nullable=False),
        sa.Column("salesforce_org_id", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("team_id", "state_id"),
    )
    op.create_index(
        "ix_salesforce_oauth_states_expires_at",
        "salesforce_oauth_states",
        ["expires_at"],
        unique=False,
    )


def downgrade() -> None:
    """Drop Salesforce OAuth persistence tables."""
    op.drop_index(
        "ix_salesforce_oauth_states_expires_at",
        table_name="salesforce_oauth_states",
    )
    op.drop_table("salesforce_oauth_states")

    op.drop_index(
        "ix_salesforce_connections_status",
        table_name="salesforce_connections",
    )
    op.drop_table("salesforce_connections")

    op.drop_index(
        "ix_salesforce_auth_configs_status",
        table_name="salesforce_auth_configs",
    )
    op.drop_table("salesforce_auth_configs")
