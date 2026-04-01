"""SQLModel-backed Slack OAuth installation store for PostgreSQL databases."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from logging import Logger
from typing import Any, cast

from pydantic import TypeAdapter
from sqlalchemy import Engine, desc
from sqlmodel import Session, col, select

from slack_sdk.oauth.installation_store.async_installation_store import (
    AsyncInstallationStore,
)
from slack_sdk.oauth.installation_store.installation_store import InstallationStore
from slack_sdk.oauth.installation_store.models.bot import Bot
from slack_sdk.oauth.installation_store.models.installation import Installation

from agents_party.infrastructure.postgres.connection import build_database_engine
from agents_party.infrastructure.postgres.models import (
    SlackBotRecord,
    SlackInstallationRecord,
    ensure_schema,
)


JSON_DICT_ADAPTER = TypeAdapter(dict[str, Any])


class PostgresSlackInstallationStore(InstallationStore, AsyncInstallationStore):
    """Persist Slack OAuth installations and bot tokens using SQLModel tables."""

    def __init__(
        self,
        *,
        client_id: str,
        database_url: str | None = None,
        engine: Engine | None = None,
        logger: Logger | None = None,
    ) -> None:
        """Create a store with either an injected engine or a database URL.

        Args:
            client_id: Slack app client id used to scope stored installations.
            database_url: SQLAlchemy-compatible database URL.
            engine: Optional injected SQLAlchemy engine for tests or overrides.
            logger: Optional logger override.

        Raises:
            ValueError: If neither `database_url` nor `engine` is provided.

        Notes:
            The target schema must already exist in non-test environments. Apply
            Alembic migrations before constructing this store in production.
        """
        if engine is None and database_url is None:
            raise ValueError("database_url or engine is required.")
        self.client_id = client_id
        self._engine = engine or build_database_engine(cast(str, database_url))
        self._logger = logger or logging.getLogger(__name__)

    @property
    def logger(self) -> Logger:
        """Return the logger used by the installation store.

        Returns:
            Logger instance bound to this store.
        """
        return self._logger

    def create_tables(self) -> None:
        """Create the SQLModel schema directly for tests or disposable setups.

        Returns:
            None.

        Notes:
            Alembic should manage schema changes in real environments. This helper
            exists only for parity with Slack SDK stores and lightweight tests.
        """
        ensure_schema(self._engine)

    def save(self, installation: Installation) -> None:
        """Persist one Slack installation row and its derived bot row.

        Args:
            installation: Slack OAuth installation data to persist.

        Returns:
            None.
        """
        payload = self._installation_payload(installation)
        installed_at = self._payload_datetime(payload, "installed_at")
        with Session(self._engine) as session:
            record = session.exec(
                select(SlackInstallationRecord)
                .where(
                    *self._scope_filters(
                        SlackInstallationRecord,
                        enterprise_id=installation.enterprise_id,
                        team_id=installation.team_id,
                    ),
                    SlackInstallationRecord.installed_at == installed_at,
                )
                .limit(1)
            ).first()
            if record is None:
                record = self._installation_record(installation, payload)
            else:
                self._apply_installation_record(record, installation, payload)
            session.add(record)
            session.commit()
        self.save_bot(installation.to_bot())

    def save_bot(self, bot: Bot) -> None:
        """Persist one Slack bot installation row.

        Args:
            bot: Slack bot installation data to persist.

        Returns:
            None.
        """
        payload = self._bot_payload(bot)
        installed_at = self._payload_datetime(payload, "installed_at")
        with Session(self._engine) as session:
            record = session.exec(
                select(SlackBotRecord)
                .where(
                    *self._scope_filters(
                        SlackBotRecord,
                        enterprise_id=bot.enterprise_id,
                        team_id=bot.team_id,
                    ),
                    SlackBotRecord.installed_at == installed_at,
                )
                .limit(1)
            ).first()
            if record is None:
                record = self._bot_record(bot, payload)
            else:
                self._apply_bot_record(record, bot, payload)
            session.add(record)
            session.commit()

    def find_bot(
        self,
        *,
        enterprise_id: str | None,
        team_id: str | None,
        is_enterprise_install: bool | None = False,
    ) -> Bot | None:
        """Return the latest stored bot installation for a workspace or org.

        Args:
            enterprise_id: Slack enterprise id for the installation scope.
            team_id: Slack team id for the installation scope.
            is_enterprise_install: Whether the app is installed at org scope.

        Returns:
            Latest bot installation, or `None` when no bot token is stored.
        """
        resolved_team_id = None if is_enterprise_install or team_id is None else team_id
        with Session(self._engine) as session:
            record = session.exec(
                select(SlackBotRecord)
                .where(
                    *self._scope_filters(
                        SlackBotRecord,
                        enterprise_id=enterprise_id,
                        team_id=resolved_team_id,
                    ),
                    col(SlackBotRecord.bot_token).is_not(None),
                )
                .order_by(desc(col(SlackBotRecord.installed_at)))
                .limit(1)
            ).first()
        if record is None:
            return None
        return self._build_bot(record)

    def find_installation(
        self,
        *,
        enterprise_id: str | None,
        team_id: str | None,
        user_id: str | None = None,
        is_enterprise_install: bool | None = False,
    ) -> Installation | None:
        """Return the latest stored installation for a workspace, org, or user.

        Args:
            enterprise_id: Slack enterprise id for the installation scope.
            team_id: Slack team id for the installation scope.
            user_id: Optional user id for user-level installation lookup.
            is_enterprise_install: Whether the app is installed at org scope.

        Returns:
            Latest matching installation, or `None` when nothing is stored.
        """
        resolved_team_id = None if is_enterprise_install or team_id is None else team_id
        statement = (
            select(SlackInstallationRecord)
            .where(
                *self._scope_filters(
                    SlackInstallationRecord,
                    enterprise_id=enterprise_id,
                    team_id=resolved_team_id,
                )
            )
            .order_by(desc(col(SlackInstallationRecord.installed_at)))
            .limit(1)
        )
        if user_id is not None:
            statement = statement.where(SlackInstallationRecord.user_id == user_id)

        with Session(self._engine) as session:
            record = session.exec(statement).first()
        if record is None:
            return None

        installation = self._build_installation(record)
        latest_bot = (
            self.find_bot(
                enterprise_id=enterprise_id,
                team_id=resolved_team_id,
                is_enterprise_install=is_enterprise_install,
            )
            if user_id is not None or installation.bot_token is None
            else None
        )
        if latest_bot is not None and installation.bot_token != latest_bot.bot_token:
            installation.bot_id = latest_bot.bot_id
            installation.bot_user_id = latest_bot.bot_user_id
            installation.bot_token = latest_bot.bot_token
            installation.bot_scopes = latest_bot.bot_scopes
            installation.bot_refresh_token = latest_bot.bot_refresh_token
            installation.bot_token_expires_at = latest_bot.bot_token_expires_at

        return installation

    def delete_bot(self, *, enterprise_id: str | None, team_id: str | None) -> None:
        """Delete stored bot rows for the supplied workspace or org scope.

        Args:
            enterprise_id: Slack enterprise id for the installation scope.
            team_id: Slack team id for the installation scope.

        Returns:
            None.
        """
        with Session(self._engine) as session:
            records = session.exec(
                select(SlackBotRecord).where(
                    *self._scope_filters(
                        SlackBotRecord,
                        enterprise_id=enterprise_id,
                        team_id=team_id,
                    )
                )
            ).all()
            for record in records:
                session.delete(record)
            session.commit()

    def delete_installation(
        self,
        *,
        enterprise_id: str | None,
        team_id: str | None,
        user_id: str | None = None,
    ) -> None:
        """Delete stored installation rows matching the supplied scope.

        Args:
            enterprise_id: Slack enterprise id for the installation scope.
            team_id: Slack team id for the installation scope.
            user_id: Optional user id to restrict deletion to one installer.

        Returns:
            None.
        """
        statement = select(SlackInstallationRecord).where(
            *self._scope_filters(
                SlackInstallationRecord,
                enterprise_id=enterprise_id,
                team_id=team_id,
            )
        )
        if user_id is not None:
            statement = statement.where(SlackInstallationRecord.user_id == user_id)

        with Session(self._engine) as session:
            records = session.exec(statement).all()
            for record in records:
                session.delete(record)
            session.commit()

    async def async_save(self, installation: Installation) -> None:
        """Persist one Slack installation row in an async context.

        Args:
            installation: Slack OAuth installation data to persist.

        Returns:
            None.
        """
        await asyncio.to_thread(self.save, installation)

    async def async_save_bot(self, bot: Bot) -> None:
        """Persist one Slack bot installation row in an async context.

        Args:
            bot: Slack bot installation data to persist.

        Returns:
            None.
        """
        await asyncio.to_thread(self.save_bot, bot)

    async def async_find_bot(
        self,
        *,
        enterprise_id: str | None,
        team_id: str | None,
        is_enterprise_install: bool | None = False,
    ) -> Bot | None:
        """Return the latest stored bot installation in an async context.

        Args:
            enterprise_id: Slack enterprise id for the installation scope.
            team_id: Slack team id for the installation scope.
            is_enterprise_install: Whether the app is installed at org scope.

        Returns:
            Latest bot installation, or `None` when no bot token is stored.
        """
        return await asyncio.to_thread(
            self.find_bot,
            enterprise_id=enterprise_id,
            team_id=team_id,
            is_enterprise_install=is_enterprise_install,
        )

    async def async_find_installation(
        self,
        *,
        enterprise_id: str | None,
        team_id: str | None,
        user_id: str | None = None,
        is_enterprise_install: bool | None = False,
    ) -> Installation | None:
        """Return the latest stored installation in an async context.

        Args:
            enterprise_id: Slack enterprise id for the installation scope.
            team_id: Slack team id for the installation scope.
            user_id: Optional user id for user-level installation lookup.
            is_enterprise_install: Whether the app is installed at org scope.

        Returns:
            Latest matching installation, or `None` when nothing is stored.
        """
        return await asyncio.to_thread(
            self.find_installation,
            enterprise_id=enterprise_id,
            team_id=team_id,
            user_id=user_id,
            is_enterprise_install=is_enterprise_install,
        )

    async def async_delete_bot(
        self,
        *,
        enterprise_id: str | None,
        team_id: str | None,
    ) -> None:
        """Delete stored bot rows in an async context.

        Args:
            enterprise_id: Slack enterprise id for the installation scope.
            team_id: Slack team id for the installation scope.

        Returns:
            None.
        """
        await asyncio.to_thread(
            self.delete_bot,
            enterprise_id=enterprise_id,
            team_id=team_id,
        )

    async def async_delete_installation(
        self,
        *,
        enterprise_id: str | None,
        team_id: str | None,
        user_id: str | None = None,
    ) -> None:
        """Delete stored installation rows in an async context.

        Args:
            enterprise_id: Slack enterprise id for the installation scope.
            team_id: Slack team id for the installation scope.
            user_id: Optional user id to restrict deletion to one installer.

        Returns:
            None.
        """
        await asyncio.to_thread(
            self.delete_installation,
            enterprise_id=enterprise_id,
            team_id=team_id,
            user_id=user_id,
        )

    def _installation_record(
        self,
        installation: Installation,
        payload: dict[str, Any],
    ) -> SlackInstallationRecord:
        """Build a SQLModel record for one Slack installation.

        Args:
            installation: Slack installation data to serialize.
            payload: JSON-safe payload representing the same installation.

        Returns:
            SQLModel record for the `slack_installations` table.
        """
        return SlackInstallationRecord(
            client_id=self.client_id,
            app_id=installation.app_id,
            enterprise_id=installation.enterprise_id,
            enterprise_name=installation.enterprise_name,
            enterprise_url=installation.enterprise_url,
            team_id=installation.team_id,
            team_name=installation.team_name,
            bot_token=installation.bot_token,
            bot_id=installation.bot_id,
            bot_user_id=installation.bot_user_id,
            bot_scopes=self._join_scopes(installation.bot_scopes),
            bot_refresh_token=installation.bot_refresh_token,
            bot_token_expires_at=self._payload_datetime(
                payload, "bot_token_expires_at"
            ),
            user_id=installation.user_id,
            user_token=installation.user_token,
            user_scopes=self._join_scopes(installation.user_scopes),
            user_refresh_token=installation.user_refresh_token,
            user_token_expires_at=self._payload_datetime(
                payload, "user_token_expires_at"
            ),
            incoming_webhook_url=installation.incoming_webhook_url,
            incoming_webhook_channel=installation.incoming_webhook_channel,
            incoming_webhook_channel_id=installation.incoming_webhook_channel_id,
            incoming_webhook_configuration_url=installation.incoming_webhook_configuration_url,
            is_enterprise_install=installation.is_enterprise_install,
            token_type=installation.token_type,
            installed_at=self._payload_datetime(payload, "installed_at")
            or datetime.now(UTC),
            payload=payload,
        )

    def _apply_installation_record(
        self,
        record: SlackInstallationRecord,
        installation: Installation,
        payload: dict[str, Any],
    ) -> None:
        """Copy installation values onto an existing SQLModel record.

        Args:
            record: Existing record to mutate in place.
            installation: Slack installation data to serialize.
            payload: JSON-safe payload representing the same installation.

        Returns:
            None.
        """
        record.client_id = self.client_id
        record.app_id = installation.app_id
        record.enterprise_id = installation.enterprise_id
        record.enterprise_name = installation.enterprise_name
        record.enterprise_url = installation.enterprise_url
        record.team_id = installation.team_id
        record.team_name = installation.team_name
        record.bot_token = installation.bot_token
        record.bot_id = installation.bot_id
        record.bot_user_id = installation.bot_user_id
        record.bot_scopes = self._join_scopes(installation.bot_scopes)
        record.bot_refresh_token = installation.bot_refresh_token
        record.bot_token_expires_at = self._payload_datetime(
            payload, "bot_token_expires_at"
        )
        record.user_id = installation.user_id
        record.user_token = installation.user_token
        record.user_scopes = self._join_scopes(installation.user_scopes)
        record.user_refresh_token = installation.user_refresh_token
        record.user_token_expires_at = self._payload_datetime(
            payload, "user_token_expires_at"
        )
        record.incoming_webhook_url = installation.incoming_webhook_url
        record.incoming_webhook_channel = installation.incoming_webhook_channel
        record.incoming_webhook_channel_id = installation.incoming_webhook_channel_id
        record.incoming_webhook_configuration_url = (
            installation.incoming_webhook_configuration_url
        )
        record.is_enterprise_install = installation.is_enterprise_install
        record.token_type = installation.token_type
        record.installed_at = (
            self._payload_datetime(payload, "installed_at") or record.installed_at
        )
        record.payload = payload

    def _bot_record(self, bot: Bot, payload: dict[str, Any]) -> SlackBotRecord:
        """Build a SQLModel record for one Slack bot installation.

        Args:
            bot: Slack bot installation data to serialize.
            payload: JSON-safe payload representing the same bot installation.

        Returns:
            SQLModel record for the `slack_bots` table.
        """
        return SlackBotRecord(
            client_id=self.client_id,
            app_id=bot.app_id,
            enterprise_id=bot.enterprise_id,
            enterprise_name=bot.enterprise_name,
            team_id=bot.team_id,
            team_name=bot.team_name,
            bot_token=bot.bot_token,
            bot_id=bot.bot_id,
            bot_user_id=bot.bot_user_id,
            bot_scopes=self._join_scopes(bot.bot_scopes),
            bot_refresh_token=bot.bot_refresh_token,
            bot_token_expires_at=self._payload_datetime(
                payload, "bot_token_expires_at"
            ),
            is_enterprise_install=bot.is_enterprise_install,
            installed_at=self._payload_datetime(payload, "installed_at")
            or datetime.now(UTC),
            payload=payload,
        )

    def _apply_bot_record(
        self,
        record: SlackBotRecord,
        bot: Bot,
        payload: dict[str, Any],
    ) -> None:
        """Copy bot installation values onto an existing SQLModel record.

        Args:
            record: Existing record to mutate in place.
            bot: Slack bot installation data to serialize.
            payload: JSON-safe payload representing the same bot installation.

        Returns:
            None.
        """
        record.client_id = self.client_id
        record.app_id = bot.app_id
        record.enterprise_id = bot.enterprise_id
        record.enterprise_name = bot.enterprise_name
        record.team_id = bot.team_id
        record.team_name = bot.team_name
        record.bot_token = bot.bot_token
        record.bot_id = bot.bot_id
        record.bot_user_id = bot.bot_user_id
        record.bot_scopes = self._join_scopes(bot.bot_scopes)
        record.bot_refresh_token = bot.bot_refresh_token
        record.bot_token_expires_at = self._payload_datetime(
            payload, "bot_token_expires_at"
        )
        record.is_enterprise_install = bot.is_enterprise_install
        record.installed_at = (
            self._payload_datetime(payload, "installed_at") or record.installed_at
        )
        record.payload = payload

    def _build_installation(self, record: SlackInstallationRecord) -> Installation:
        """Hydrate a Slack SDK installation entity from a persisted record.

        Args:
            record: Persisted installation row.

        Returns:
            Slack SDK installation entity.
        """
        return Installation(
            app_id=record.app_id,
            enterprise_id=record.enterprise_id,
            enterprise_name=record.enterprise_name,
            enterprise_url=record.enterprise_url,
            team_id=record.team_id,
            team_name=record.team_name,
            bot_token=record.bot_token,
            bot_id=record.bot_id,
            bot_user_id=record.bot_user_id,
            bot_scopes=record.bot_scopes or "",
            bot_refresh_token=record.bot_refresh_token,
            bot_token_expires_at=record.bot_token_expires_at,
            user_id=record.user_id,
            user_token=record.user_token,
            user_scopes=record.user_scopes or "",
            user_refresh_token=record.user_refresh_token,
            user_token_expires_at=record.user_token_expires_at,
            incoming_webhook_url=record.incoming_webhook_url,
            incoming_webhook_channel=record.incoming_webhook_channel,
            incoming_webhook_channel_id=record.incoming_webhook_channel_id,
            incoming_webhook_configuration_url=record.incoming_webhook_configuration_url,
            is_enterprise_install=record.is_enterprise_install,
            token_type=record.token_type,
            installed_at=record.installed_at,
            custom_values=self._custom_values(record.payload),
        )

    def _build_bot(self, record: SlackBotRecord) -> Bot:
        """Hydrate a Slack SDK bot entity from a persisted record.

        Args:
            record: Persisted bot row.

        Returns:
            Slack SDK bot entity.
        """
        return Bot(
            app_id=record.app_id,
            enterprise_id=record.enterprise_id,
            enterprise_name=record.enterprise_name,
            team_id=record.team_id,
            team_name=record.team_name,
            bot_token=record.bot_token or "",
            bot_id=record.bot_id or "",
            bot_user_id=record.bot_user_id or "",
            bot_scopes=record.bot_scopes or "",
            bot_refresh_token=record.bot_refresh_token,
            bot_token_expires_at=record.bot_token_expires_at,
            is_enterprise_install=record.is_enterprise_install,
            installed_at=record.installed_at,
            custom_values=self._custom_values(record.payload),
        )

    def _scope_filters(
        self,
        record_type: type[SlackInstallationRecord] | type[SlackBotRecord],
        *,
        enterprise_id: str | None,
        team_id: str | None,
    ) -> list[Any]:
        """Build the standard scope filters used by Slack SDK store lookups.

        Args:
            record_type: SQLModel record class being queried.
            enterprise_id: Slack enterprise id for the installation scope.
            team_id: Slack team id for the installation scope.

        Returns:
            SQLAlchemy filter expressions scoped by client, enterprise, and team.
        """
        filters: list[Any] = [record_type.client_id == self.client_id]
        if enterprise_id is None:
            filters.append(col(record_type.enterprise_id).is_(None))
        else:
            filters.append(record_type.enterprise_id == enterprise_id)
        if team_id is None:
            filters.append(col(record_type.team_id).is_(None))
        else:
            filters.append(record_type.team_id == team_id)
        return filters

    def _installation_payload(self, installation: Installation) -> dict[str, Any]:
        """Serialize a Slack installation into JSON-safe payload data.

        Args:
            installation: Slack installation data to serialize.

        Returns:
            JSON-safe payload containing standard fields and custom values.
        """
        return cast(
            dict[str, Any],
            JSON_DICT_ADAPTER.dump_python(
                installation.to_dict_for_copying(),
                mode="json",
            ),
        )

    def _bot_payload(self, bot: Bot) -> dict[str, Any]:
        """Serialize a Slack bot installation into JSON-safe payload data.

        Args:
            bot: Slack bot installation data to serialize.

        Returns:
            JSON-safe payload containing standard fields and custom values.
        """
        return cast(
            dict[str, Any],
            JSON_DICT_ADAPTER.dump_python(
                bot.to_dict_for_copying(),
                mode="json",
            ),
        )

    def _payload_datetime(
        self,
        payload: dict[str, Any],
        field_name: str,
    ) -> datetime | None:
        """Parse one ISO datetime field from a JSON-safe payload.

        Args:
            payload: JSON-safe payload produced by `_installation_payload` or `_bot_payload`.
            field_name: Datetime field name to parse.

        Returns:
            Parsed datetime value, or `None` when absent.
        """
        value = payload.get(field_name)
        if value is None:
            return None
        if isinstance(value, datetime):
            return value
        return datetime.fromisoformat(cast(str, value))

    def _join_scopes(self, scopes: Any) -> str | None:
        """Serialize a scope sequence into Slack SDK's comma-separated format.

        Args:
            scopes: Scope sequence or `None`.

        Returns:
            Comma-separated scope string, or `None` when no scopes exist.
        """
        if scopes is None:
            return None
        if isinstance(scopes, str):
            return scopes
        values = list(scopes)
        return ",".join(values) if values else None

    def _custom_values(self, payload: dict[str, object]) -> dict[str, Any]:
        """Extract Slack SDK custom values from a persisted payload blob.

        Args:
            payload: Persisted payload containing standard fields and custom values.

        Returns:
            Custom values dictionary preserved across persistence round-trips.
        """
        custom_values = payload.get("custom_values")
        if isinstance(custom_values, dict):
            return cast(dict[str, Any], custom_values)
        return {}


__all__ = ["PostgresSlackInstallationStore"]
