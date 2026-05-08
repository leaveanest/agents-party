"""Add work-item calendar event link table."""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260508_0003"
down_revision = "20260508_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the work-item calendar link table and lookup indexes."""
    op.create_table(
        "work_item_calendar_links",
        sa.Column("team_id", sa.String(), nullable=False),
        sa.Column("work_item_id", sa.String(), nullable=False),
        sa.Column("link_id", sa.String(), nullable=False),
        sa.Column("provider_kind", sa.String(), nullable=False),
        sa.Column("external_calendar_id", sa.String(), nullable=False),
        sa.Column("external_event_id", sa.String(), nullable=False),
        sa.Column("event_title_snapshot", sa.String(), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_all_day", sa.Boolean(), nullable=False),
        sa.Column("response_status", sa.String(), nullable=True),
        sa.Column("sync_status", sa.String(), nullable=False),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("team_id", "work_item_id", "link_id"),
        sa.UniqueConstraint(
            "team_id",
            "work_item_id",
            "provider_kind",
            "external_calendar_id",
            "external_event_id",
            name="uq_work_item_calendar_links_external_event",
        ),
    )
    op.create_index(
        "ix_work_item_calendar_links_external_event",
        "work_item_calendar_links",
        [
            "team_id",
            "provider_kind",
            "external_calendar_id",
            "external_event_id",
        ],
        unique=False,
    )
    op.create_index(
        "ix_work_item_calendar_links_sync_status",
        "work_item_calendar_links",
        ["team_id", "sync_status"],
        unique=False,
    )


def downgrade() -> None:
    """Drop the work-item calendar link table."""
    op.drop_index(
        "ix_work_item_calendar_links_sync_status",
        table_name="work_item_calendar_links",
    )
    op.drop_index(
        "ix_work_item_calendar_links_external_event",
        table_name="work_item_calendar_links",
    )
    op.drop_table("work_item_calendar_links")
