"""FastAPI application entry point for the agents-party service."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
import uvicorn

from agents_party.config import settings
from agents_party.google_auth import (
    GoogleAuthCoordinator,
    create_google_auth_router,
)
from agents_party.google_auth.wiring import build_google_auth_coordinator
from agents_party.slack.app import SlackBoltGateway


def create_app() -> FastAPI:
    """Create the FastAPI application and register HTTP routes.

    Returns:
        Configured FastAPI application instance.
    """
    slack_gateway = SlackBoltGateway(settings)
    google_auth_coordinator: GoogleAuthCoordinator | None = None

    def get_google_auth_coordinator() -> GoogleAuthCoordinator | None:
        """Return the current app-scoped Google OAuth coordinator.

        Returns:
            Active Google OAuth coordinator, or `None` when disabled.
        """
        return google_auth_coordinator

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        """Manage application-scoped async resources.

        Args:
            _app: FastAPI application instance.

        Yields:
            Control back to FastAPI while the application is running.
        """
        nonlocal google_auth_coordinator
        google_auth_coordinator = build_google_auth_coordinator(settings)
        try:
            yield
        finally:
            current_coordinator = google_auth_coordinator
            google_auth_coordinator = None
            if current_coordinator is not None:
                await current_coordinator.aclose()

    app = FastAPI(title=settings.app_name, lifespan=lifespan)
    app.include_router(
        create_google_auth_router(coordinator_provider=get_google_auth_coordinator)
    )

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
