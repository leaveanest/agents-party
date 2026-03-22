from fastapi import Request, Response
from slack_bolt.adapter.fastapi.async_handler import AsyncSlackRequestHandler
from slack_bolt.async_app import AsyncApp

from agents_party.config import Settings
from agents_party.slack.events import register_event_handlers
from agents_party.slack.features import register_feature_handlers


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
            "Slack is not configured. Set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET."
        )

    app = AsyncApp(
        token=settings.slack_bot_token,
        signing_secret=settings.slack_signing_secret,
        process_before_response=True,
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
