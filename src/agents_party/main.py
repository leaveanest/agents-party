from fastapi import FastAPI, Request, Response
import uvicorn

from agents_party.config import settings
from agents_party.slack.app import SlackBoltGateway


def create_app() -> FastAPI:
    app = FastAPI(title=settings.app_name)
    slack_gateway = SlackBoltGateway(settings)

    @app.get("/healthz")
    async def healthcheck() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/slack/events")
    async def slack_events(request: Request) -> Response:
        return await slack_gateway.handle(request)

    return app


app = create_app()


def main() -> None:
    uvicorn.run(
        "agents_party.main:app",
        host=settings.app_host,
        port=settings.app_port,
        reload=settings.app_env == "local",
    )
