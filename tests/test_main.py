from __future__ import annotations

from importlib import import_module

from fastapi import Request, Response
from fastapi.testclient import TestClient

main_module = import_module("agents_party.main")


class FakeGoogleAuthCoordinator:
    """Test double for app-scoped Google OAuth coordinator lifecycle checks."""

    def __init__(self, name: str) -> None:
        """Initialize the fake coordinator.

        Args:
            name: Identifier embedded into returned authorization URLs.

        Returns:
            None.
        """
        self.name = name
        self.closed = False

    async def begin_authorization(self, *, context_token: str) -> str:
        """Return an authorization URL unique to this coordinator instance.

        Args:
            context_token: Signed OAuth start context token.

        Returns:
            Deterministic authorization URL for assertions.
        """
        return f"https://example.com/{self.name}?context={context_token}"

    async def handle_callback(
        self,
        *,
        state_id: str | None,
        code: str | None,
        error: str | None,
        error_description: str | None,
    ) -> object:
        """Fail because callback handling is not used in this test.

        Args:
            state_id: OAuth state identifier.
            code: OAuth authorization code.
            error: OAuth provider error code.
            error_description: OAuth provider error description.

        Raises:
            AssertionError: Always, because this test only exercises start routing.
        """
        del state_id, code, error, error_description
        raise AssertionError("handle_callback should not be called in this test")

    async def aclose(self) -> None:
        """Record that the coordinator was closed during shutdown.

        Returns:
            None.
        """
        self.closed = True


class FakeSlackBoltGateway:
    """Minimal Slack gateway fake for app factory tests."""

    def __init__(self, settings: object) -> None:
        """Initialize the fake Slack gateway.

        Args:
            settings: Application settings passed by the app factory.

        Returns:
            None.
        """
        del settings

    async def handle(self, request: Request) -> Response:
        """Return a deterministic placeholder response.

        Args:
            request: Incoming FastAPI request.

        Returns:
            Placeholder HTTP response.
        """
        del request
        return Response(status_code=204)


def test_create_app_rebuilds_google_auth_coordinator_for_each_lifespan(
    monkeypatch,
) -> None:
    """Verify each FastAPI lifespan run receives a fresh coordinator instance.

    Args:
        monkeypatch: Pytest helper for temporarily patching module attributes.

    Returns:
        None.
    """
    created: list[FakeGoogleAuthCoordinator] = []

    def build_fake_coordinator(_settings: object) -> FakeGoogleAuthCoordinator:
        coordinator = FakeGoogleAuthCoordinator(name=f"coordinator-{len(created) + 1}")
        created.append(coordinator)
        return coordinator

    monkeypatch.setattr(main_module, "SlackBoltGateway", FakeSlackBoltGateway)
    monkeypatch.setattr(
        main_module,
        "build_google_auth_coordinator",
        build_fake_coordinator,
    )

    app = main_module.create_app()

    with TestClient(app) as first_client:
        first_response = first_client.get(
            "/oauth/google/start",
            params={"context": "first-context"},
            follow_redirects=False,
        )

    with TestClient(app) as second_client:
        second_response = second_client.get(
            "/oauth/google/start",
            params={"context": "second-context"},
            follow_redirects=False,
        )

    assert [coordinator.name for coordinator in created] == [
        "coordinator-1",
        "coordinator-2",
    ]
    assert first_response.headers["location"] == (
        "https://example.com/coordinator-1?context=first-context"
    )
    assert second_response.headers["location"] == (
        "https://example.com/coordinator-2?context=second-context"
    )
    assert created[0].closed is True
    assert created[1].closed is True
