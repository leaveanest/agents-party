"""Initial PostgreSQL schema for Slack routing, OAuth, and work-item persistence."""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260330_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the initial relational schema used by the PostgreSQL repositories."""
    op.create_table(
        "agents",
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("agent_id"),
    )
    op.create_index(op.f("ix_agents_enabled"), "agents", ["enabled"], unique=False)

    op.create_table(
        "workspace_app_settings",
        sa.Column("team_id", sa.String(), nullable=False),
        sa.Column("default_agent_id", sa.String(), nullable=True),
        sa.Column("thread_auto_reply", sa.Boolean(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("team_id"),
    )

    op.create_table(
        "channel_app_settings",
        sa.Column("team_id", sa.String(), nullable=False),
        sa.Column("channel_id", sa.String(), nullable=False),
        sa.Column("default_agent_id", sa.String(), nullable=True),
        sa.Column("thread_auto_reply", sa.Boolean(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("team_id", "channel_id"),
    )

    op.create_table(
        "slack_threads",
        sa.Column("team_id", sa.String(), nullable=False),
        sa.Column("channel_id", sa.String(), nullable=False),
        sa.Column("thread_ts", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=True),
        sa.Column("root_message_ts", sa.String(), nullable=False),
        sa.Column("last_message_ts", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("team_id", "channel_id", "thread_ts"),
    )

    op.create_table(
        "slack_installations",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("client_id", sa.String(), nullable=False),
        sa.Column("app_id", sa.String(), nullable=True),
        sa.Column("enterprise_id", sa.String(), nullable=True),
        sa.Column("enterprise_name", sa.String(), nullable=True),
        sa.Column("enterprise_url", sa.String(), nullable=True),
        sa.Column("team_id", sa.String(), nullable=True),
        sa.Column("team_name", sa.String(), nullable=True),
        sa.Column("bot_token", sa.String(), nullable=True),
        sa.Column("bot_id", sa.String(), nullable=True),
        sa.Column("bot_user_id", sa.String(), nullable=True),
        sa.Column("bot_scopes", sa.String(), nullable=True),
        sa.Column("bot_refresh_token", sa.String(), nullable=True),
        sa.Column("bot_token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("user_token", sa.String(), nullable=True),
        sa.Column("user_scopes", sa.String(), nullable=True),
        sa.Column("user_refresh_token", sa.String(), nullable=True),
        sa.Column("user_token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("incoming_webhook_url", sa.String(), nullable=True),
        sa.Column("incoming_webhook_channel", sa.String(), nullable=True),
        sa.Column("incoming_webhook_channel_id", sa.String(), nullable=True),
        sa.Column("incoming_webhook_configuration_url", sa.String(), nullable=True),
        sa.Column("is_enterprise_install", sa.Boolean(), nullable=False),
        sa.Column("token_type", sa.String(), nullable=True),
        sa.Column("installed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_slack_installations_lookup",
        "slack_installations",
        ["client_id", "enterprise_id", "team_id", "user_id", "installed_at"],
        unique=False,
    )

    op.create_table(
        "slack_bots",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("client_id", sa.String(), nullable=False),
        sa.Column("app_id", sa.String(), nullable=True),
        sa.Column("enterprise_id", sa.String(), nullable=True),
        sa.Column("enterprise_name", sa.String(), nullable=True),
        sa.Column("team_id", sa.String(), nullable=True),
        sa.Column("team_name", sa.String(), nullable=True),
        sa.Column("bot_token", sa.String(), nullable=True),
        sa.Column("bot_id", sa.String(), nullable=True),
        sa.Column("bot_user_id", sa.String(), nullable=True),
        sa.Column("bot_scopes", sa.String(), nullable=True),
        sa.Column("bot_refresh_token", sa.String(), nullable=True),
        sa.Column("bot_token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_enterprise_install", sa.Boolean(), nullable=False),
        sa.Column("installed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_slack_bots_lookup",
        "slack_bots",
        ["client_id", "enterprise_id", "team_id", "installed_at"],
        unique=False,
    )

    op.create_table(
        "work_items",
        sa.Column("team_id", sa.String(), nullable=False),
        sa.Column("work_item_id", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("visibility_kind", sa.String(), nullable=False),
        sa.Column("audience_channel_id", sa.String(), nullable=True),
        sa.Column("primary_assignee_user_id", sa.String(), nullable=True),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("team_id", "work_item_id"),
    )
    op.create_index(
        op.f("ix_work_items_status"), "work_items", ["status"], unique=False
    )
    op.create_index(
        op.f("ix_work_items_visibility_kind"),
        "work_items",
        ["visibility_kind"],
        unique=False,
    )
    op.create_index(
        "ix_work_items_channel",
        "work_items",
        ["team_id", "audience_channel_id"],
        unique=False,
    )

    op.create_table(
        "work_item_participants",
        sa.Column("team_id", sa.String(), nullable=False),
        sa.Column("work_item_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("attention_profile", sa.String(), nullable=False),
        sa.Column("next_attention_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("muted_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_event_id", sa.String(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("team_id", "work_item_id", "user_id"),
    )

    op.create_table(
        "work_item_events",
        sa.Column("team_id", sa.String(), nullable=False),
        sa.Column("work_item_id", sa.String(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("team_id", "work_item_id", "event_id"),
    )

    op.create_table(
        "work_item_attention_index",
        sa.Column("team_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("work_item_id", sa.String(), nullable=False),
        sa.Column("needs_attention_now", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("visibility_kind", sa.String(), nullable=False),
        sa.Column("audience_channel_id", sa.String(), nullable=True),
        sa.Column("primary_assignee_user_id", sa.String(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("team_id", "user_id", "work_item_id"),
    )
    op.create_index(
        op.f("ix_work_item_attention_index_needs_attention_now"),
        "work_item_attention_index",
        ["needs_attention_now"],
        unique=False,
    )
    op.create_index(
        "ix_work_item_attention_index_viewer",
        "work_item_attention_index",
        ["team_id", "user_id", "needs_attention_now"],
        unique=False,
    )


def downgrade() -> None:
    """Drop the initial relational schema used by the PostgreSQL repositories."""
    op.drop_index(
        "ix_work_item_attention_index_viewer",
        table_name="work_item_attention_index",
    )
    op.drop_index(
        op.f("ix_work_item_attention_index_needs_attention_now"),
        table_name="work_item_attention_index",
    )
    op.drop_table("work_item_attention_index")

    op.drop_table("work_item_events")
    op.drop_table("work_item_participants")

    op.drop_index("ix_work_items_channel", table_name="work_items")
    op.drop_index(op.f("ix_work_items_visibility_kind"), table_name="work_items")
    op.drop_index(op.f("ix_work_items_status"), table_name="work_items")
    op.drop_table("work_items")

    op.drop_index("ix_slack_bots_lookup", table_name="slack_bots")
    op.drop_table("slack_bots")
    op.drop_index("ix_slack_installations_lookup", table_name="slack_installations")
    op.drop_table("slack_installations")

    op.drop_table("slack_threads")
    op.drop_table("channel_app_settings")
    op.drop_table("workspace_app_settings")

    op.drop_index(op.f("ix_agents_enabled"), table_name="agents")
    op.drop_table("agents")
