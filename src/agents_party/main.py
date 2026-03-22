from fastapi import FastAPI, Request, Response
import uvicorn

from agents_party.config import settings
from agents_party.slack.app import SlackBoltGateway


def create_app() -> FastAPI:
    """Create the FastAPI application and register HTTP routes.

    Returns:
        Configured FastAPI application instance.
    """
    app = FastAPI(title=settings.app_name)
    slack_gateway = SlackBoltGateway(settings)

    @app.get("/healthz")
    async def healthcheck() -> dict[str, str]:
        """Return a lightweight liveness response.

        Returns:
            JSON payload indicating the process is healthy.
        """
        return {"status": "ok"}

    @app.post("/slack/events")
    async def slack_events(request: Request) -> Response:
        """Forward Slack event requests to the Bolt gateway.

        Args:
            request: Incoming FastAPI request carrying the Slack event payload.

        Returns:
            HTTP response returned by the Slack Bolt gateway.
        """
        return await slack_gateway.handle(request)

    return app


app = create_app()


def main() -> None:
    """Run the ASGI server for the application.

    Returns:
        None.
    """
    uvicorn.run(
        "agents_party.main:app",
        host=settings.app_host,
        port=settings.app_port,
        reload=settings.app_env == "local",
    )
