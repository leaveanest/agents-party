"""Slack Bolt application factory and FastAPI gateway integration."""
from typing import Any

from fastapi import Request, Response
from slack_bolt.authorization import AuthorizeResult
from slack_bolt.adapter.fastapi.async_handler import AsyncSlackRequestHandler
from slack_bolt.async_app import AsyncApp
from slack_sdk.oauth.installation_store.models.bot import Bot
from slack_sdk.oauth.installation_store.models.installation import Installation

from agents_party.config import Settings
from agents_party.infrastructure.postgres import PostgresSlackInstallationStore
from agents_party.infrastructure.postgres.connection import (
    build_database_engine_from_settings,
)
from agents_party.slack.events import register_event_handlers
from agents_party.slack.features import register_feature_handlers


def _build_installation_store(
    settings: Settings,
) -> PostgresSlackInstallationStore | None:
    """Build the Slack installation store when the app is DB-backed.

    Args:
        settings: Application settings containing Slack and database config.

    Returns:
        Installation store backed by PostgreSQL, or `None` when the required
        settings are absent.
    """
    if not settings.slack_installation_store_enabled:
        return None
    return PostgresSlackInstallationStore(
        client_id=str(settings.slack_client_id),
        engine=build_database_engine_from_settings(settings),
    )


def _build_authorize(
    settings: Settings,
    installation_store: PostgresSlackInstallationStore,
):
    """Build a Slack authorize callback backed by DB installs plus token fallback.

    Args:
        settings: Application settings containing Slack credentials.
        installation_store: Store used to resolve installed Slack credentials.

    Returns:
        Async authorize callback compatible with Slack Bolt.
    """
    async def authorize(
        context: Any,
        enterprise_id: str | None,
        team_id: str | None,
        user_id: str | None,
        actor_enterprise_id: str | None = None,
        actor_team_id: str | None = None,
        actor_user_id: str | None = None,
    ) -> AuthorizeResult | None:
        """Resolve Slack authorization for one incoming request.

        Args:
            context: Slack Bolt request context.
            enterprise_id: Slack enterprise id for the request scope.
            team_id: Slack workspace id for the request scope.
            user_id: Slack user id associated with the request.
            actor_enterprise_id: Optional actor enterprise id for Slack Connect.
            actor_team_id: Optional actor workspace id for Slack Connect.
            actor_user_id: Optional actor user id for Slack Connect.

        Returns:
            Authorize result resolved from the installation store, or a fallback
            static bot token authorize result when available.
        """
        authorize_result = await _authorize_from_installation_store(
            installation_store=installation_store,
            enterprise_id=enterprise_id,
            team_id=team_id,
            user_id=user_id,
            is_enterprise_install=bool(context.is_enterprise_install),
        )
        if authorize_result is not None:
            return authorize_result
        if settings.slack_bot_token is None:
            return None
        return AuthorizeResult(
            enterprise_id=enterprise_id,
            team_id=team_id,
            user_id=user_id,
            bot_token=settings.slack_bot_token,
        )

    return authorize


async def _authorize_from_installation_store(
    *,
    installation_store: PostgresSlackInstallationStore,
    enterprise_id: str | None,
    team_id: str | None,
    user_id: str | None,
    is_enterprise_install: bool,
) -> AuthorizeResult | None:
    """Resolve an authorize result from the stored Slack installation records.

    Args:
        installation_store: Store used to load persisted Slack credentials.
        enterprise_id: Slack enterprise id for the request scope.
        team_id: Slack workspace id for the request scope.
        user_id: Slack user id associated with the request.
        is_enterprise_install: Whether the app is installed org-wide.

    Returns:
        Authorize result built from stored installation data, or `None` when no
        matching installation data exists.
    """
    latest_installation = await installation_store.async_find_installation(
        enterprise_id=enterprise_id,
        team_id=team_id,
        is_enterprise_install=is_enterprise_install,
    )
    if latest_installation is not None:
        resolved_installation = await _resolve_user_installation(
            installation_store=installation_store,
            latest_installation=latest_installation,
            enterprise_id=enterprise_id,
            team_id=team_id,
            user_id=user_id,
            is_enterprise_install=is_enterprise_install,
        )
        bot = (
            _installation_bot(latest_installation)
            or await installation_store.async_find_bot(
                enterprise_id=enterprise_id,
                team_id=team_id,
                is_enterprise_install=is_enterprise_install,
            )
        )
        return _build_authorize_result(
            installation=resolved_installation,
            bot=bot,
            fallback_user_id=user_id,
        )

    bot = await installation_store.async_find_bot(
        enterprise_id=enterprise_id,
        team_id=team_id,
        is_enterprise_install=is_enterprise_install,
    )
    if bot is None:
        return None
    return AuthorizeResult(
        enterprise_id=enterprise_id,
        team_id=None if is_enterprise_install else team_id,
        bot_id=bot.bot_id,
        bot_user_id=bot.bot_user_id,
        bot_token=bot.bot_token,
        bot_scopes=bot.bot_scopes,
        user_id=user_id,
    )


async def _resolve_user_installation(
    *,
    installation_store: PostgresSlackInstallationStore,
    latest_installation: Installation,
    enterprise_id: str | None,
    team_id: str | None,
    user_id: str | None,
    is_enterprise_install: bool,
) -> Installation:
    """Resolve the best installation row for the request user.

    Args:
        installation_store: Store used to load persisted Slack credentials.
        latest_installation: Latest workspace or enterprise installation.
        enterprise_id: Slack enterprise id for the request scope.
        team_id: Slack workspace id for the request scope.
        user_id: Slack user id associated with the request.
        is_enterprise_install: Whether the app is installed org-wide.

    Returns:
        Installation row to use for authorization, preferring the request
        user's installation when one is stored.
    """
    if user_id is None or latest_installation.user_id == user_id:
        return latest_installation
    request_user_installation = await installation_store.async_find_installation(
        enterprise_id=enterprise_id,
        team_id=team_id,
        user_id=user_id,
        is_enterprise_install=is_enterprise_install,
    )
    if request_user_installation is None:
        latest_installation.user_id = user_id
        latest_installation.user_token = None
        latest_installation.user_scopes = None
        return latest_installation
    latest_installation.user_id = request_user_installation.user_id
    latest_installation.user_token = request_user_installation.user_token
    latest_installation.user_scopes = request_user_installation.user_scopes
    return latest_installation


def _installation_bot(installation: Installation) -> Bot | None:
    """Extract bot credentials from an installation when present.

    Args:
        installation: Slack installation row loaded from the store.

    Returns:
        Bot entity built from the installation, or `None` when bot credentials
        are absent from the installation row.
    """
    if installation.bot_token is None:
        return None
    return installation.to_bot()


def _build_authorize_result(
    *,
    installation: Installation,
    bot: Bot | None,
    fallback_user_id: str | None,
) -> AuthorizeResult:
    """Build a Bolt authorize result from stored installation data.

    Args:
        installation: Slack installation row selected for the request.
        bot: Optional bot credentials associated with the installation.
        fallback_user_id: Request user id used when no user install is stored.

    Returns:
        Bolt authorize result ready for listener execution.
    """
    return AuthorizeResult(
        enterprise_id=installation.enterprise_id,
        team_id=installation.team_id,
        team=installation.team_name,
        url=installation.enterprise_url,
        bot_id=bot.bot_id if bot is not None else installation.bot_id,
        bot_user_id=(
            bot.bot_user_id if bot is not None else installation.bot_user_id
        ),
        bot_token=bot.bot_token if bot is not None else installation.bot_token,
        bot_scopes=bot.bot_scopes if bot is not None else installation.bot_scopes,
        user_id=installation.user_id or fallback_user_id,
        user_token=installation.user_token,
        user_scopes=installation.user_scopes,
    )


def create_bolt_app(settings: Settings) -> AsyncApp:
    """Create the Slack Bolt application when Slack is configured.

    Args:
        settings: Application settings containing Slack credentials.

    Returns:
        Configured asynchronous Slack Bolt application.

    Raises:
        ValueError: If the minimum Slack credentials are not configured.
    """
    if not settings.slack_enabled:
        raise ValueError(
            "Slack is not configured. Set SLACK_SIGNING_SECRET and either "
            "SLACK_BOT_TOKEN or SLACK_CLIENT_ID with database settings."
        )

    installation_store = _build_installation_store(settings)
    authorize = (
        _build_authorize(settings, installation_store)
        if installation_store is not None
        else None
    )
    app = AsyncApp(
        token=settings.slack_bot_token if authorize is None else None,
        signing_secret=settings.slack_signing_secret,
        process_before_response=True,
        installation_store=installation_store,
        authorize=authorize,
    )
    register_event_handlers(app)
    register_feature_handlers(app)
    return app


class SlackBoltGateway:
    def __init__(self, settings: Settings):
        """Initialize the FastAPI-to-Bolt gateway.

        Args:
            settings: Application settings used to decide whether Slack is enabled.

        Returns:
            None.
        """
        self._handler: AsyncSlackRequestHandler | None = None
        if settings.slack_enabled:
            self._handler = AsyncSlackRequestHandler(create_bolt_app(settings))

    async def handle(self, request: Request) -> Response:
        """Handle a FastAPI request by delegating to Slack Bolt when configured.

        Args:
            request: Incoming HTTP request from the Slack events endpoint.

        Returns:
            Slack Bolt response, or a `503` response when Slack is not configured.
        """
        if self._handler is None:
            return Response(
                content="Slack is not configured.",
                media_type="text/plain",
                status_code=503,
            )
        return await self._handler.handle(request)
