"""Tests for the Google Maps agent package."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic_ai.models.test import TestModel

import agents_party.agents.google_maps.runtime as google_maps_runtime_module
from agents_party.agents.google_maps import (
    GoogleMapsAction,
    GoogleMapsInvocation,
    GoogleMapsPlaceSummary,
    GoogleMapsResult,
    GoogleMapsRouteSummary,
    build_google_maps_agent,
    build_google_maps_prompt,
    render_google_maps_response,
    run_google_maps,
)
from agents_party.domain import MessageRole, ThreadMessage


class FakeGoogleMapsClient:
    """Stub Google Maps client used by agent-runtime tests."""

    def __init__(self) -> None:
        """Initialize the fake Google Maps client.

        Returns:
            None.
        """
        self.search_places_calls: list[str] = []
        self.search_nearby_calls: list[tuple[str, str, int]] = []
        self.compute_route_calls: list[tuple[str, str, str]] = []
        self.closed = False

    async def search_places(self, query: str) -> list[GoogleMapsPlaceSummary]:
        """Record a place search and return a deterministic result.

        Args:
            query: Place-search query passed by the agent.

        Returns:
            Deterministic place summaries.
        """
        self.search_places_calls.append(query)
        return [
            GoogleMapsPlaceSummary(
                name="Shinjuku Station",
                formatted_address="東京都新宿区新宿3丁目38-1",
                google_maps_uri="https://maps.google.com/?cid=station",
            )
        ]

    async def search_nearby(
        self,
        anchor_query: str,
        search_query: str,
        radius_meters: int = 1500,
    ) -> list[GoogleMapsPlaceSummary]:
        """Record a nearby search and return a deterministic result.

        Args:
            anchor_query: Anchor place query passed by the agent.
            search_query: Nearby-search query passed by the agent.
            radius_meters: Nearby radius passed by the agent.

        Returns:
            Deterministic nearby place summaries.
        """
        self.search_nearby_calls.append((anchor_query, search_query, radius_meters))
        return [
            GoogleMapsPlaceSummary(
                name="Blue Bottle Coffee",
                formatted_address="東京都渋谷区渋谷1-1-1",
                google_maps_uri="https://maps.google.com/?cid=coffee",
                rating=4.3,
                user_rating_count=120,
            )
        ]

    async def compute_route(
        self,
        origin: str,
        destination: str,
        travel_mode: str = "driving",
    ) -> GoogleMapsRouteSummary:
        """Record a route lookup and return a deterministic route.

        Args:
            origin: Route origin passed by the agent.
            destination: Route destination passed by the agent.
            travel_mode: Travel mode passed by the agent.

        Returns:
            Deterministic route summary.
        """
        self.compute_route_calls.append((origin, destination, travel_mode))
        return GoogleMapsRouteSummary(
            origin=origin,
            destination=destination,
            travel_mode=travel_mode,
            distance_meters=7200,
            duration_seconds=1080,
            summary="首都高速経由",
            google_maps_uri="https://www.google.com/maps/dir/?api=1",
        )

    async def aclose(self) -> None:
        """Mark the fake client as closed.

        Returns:
            None.
        """
        self.closed = True


def make_invocation() -> GoogleMapsInvocation:
    """Build a representative Slack invocation for Google Maps tests.

    Returns:
        Google Maps invocation containing request and thread context.
    """
    return GoogleMapsInvocation(
        team_id="T1",
        user_id="U1",
        channel_id="C123",
        viewer_context_channel_ids=["C123"],
        text="新宿駅近くのカフェを探して",
        thread_ts="1712345678.000100",
        message_ts="1712345678.000100",
        thread_messages=[
            ThreadMessage(
                ts="1712345678.000100",
                role=MessageRole.USER,
                text="新宿駅近くのカフェを探して",
                user_id="U1",
            )
        ],
    )


@pytest.mark.asyncio
async def test_build_google_maps_agent_registers_expected_tools() -> None:
    """Verify the Google Maps agent exposes the intended function tools.

    Returns:
        None.
    """
    model = TestModel(
        call_tools=[],
        custom_output_text=(
            '{"action":"answered","answer":"ok","places":[],"route":null,'
            '"caveats":[],"follow_up_question":null}'
        ),
    )
    agent = build_google_maps_agent(model=model, client=FakeGoogleMapsClient())

    result = await agent.run(build_google_maps_prompt(make_invocation()))

    assert result.output.answer == "ok"
    params = model.last_model_request_parameters
    assert params is not None
    assert {tool.name for tool in params.function_tools} == {
        "compute_route",
        "list_skills",
        "load_skill",
        "read_skill_resource",
        "run_skill_script",
        "search_nearby",
        "search_places",
    }


def test_build_google_maps_instructions_include_lodging_skill_guidance() -> None:
    """Verify the Google Maps instructions mention the lodging advisor skill.

    Returns:
        None.
    """
    instructions = "\n".join(google_maps_runtime_module.build_google_maps_instructions())

    assert "`lodging-search-advisor`" in instructions
    assert "where to stay" in instructions


def test_build_google_maps_prompt_includes_request_and_transcript() -> None:
    """Verify the Google Maps prompt preserves request and thread context.

    Returns:
        None.
    """
    prompt = build_google_maps_prompt(make_invocation())

    assert "Slack request:\n新宿駅近くのカフェを探して" in prompt
    assert (
        "Slack thread transcript:\n"
        "[1712345678.000100] user:U1 新宿駅近くのカフェを探して" in prompt
    )
    assert prompt.endswith("Return the structured Google Maps result for this request.")


def test_render_google_maps_response_renders_route_and_places() -> None:
    """Verify rendered Slack output includes route, places, and caveats.

    Returns:
        None.
    """
    result = GoogleMapsResult(
        action=GoogleMapsAction.ANSWERED,
        answer="候補を見つけました。",
        places=[
            GoogleMapsPlaceSummary(
                name="Blue Bottle Coffee",
                formatted_address="東京都渋谷区渋谷1-1-1",
                google_maps_uri="https://maps.google.com/?cid=coffee",
                rating=4.3,
                user_rating_count=120,
            )
        ],
        route=GoogleMapsRouteSummary(
            origin="東京駅",
            destination="渋谷駅",
            travel_mode="driving",
            distance_meters=7200,
            duration_seconds=1080,
            summary="首都高速経由",
            google_maps_uri="https://www.google.com/maps/dir/?api=1",
        ),
        caveats=["現在の交通状況までは反映していません。"],
    )

    rendered = render_google_maps_response(result)

    assert rendered.startswith("候補を見つけました。")
    assert "ルート:\n- 出発地: 東京駅" in rendered
    assert "候補スポット:\n- Blue Bottle Coffee | 東京都渋谷区渋谷1-1-1" in rendered
    assert "注意点:\n- 現在の交通状況までは反映していません。" in rendered


@pytest.mark.asyncio
async def test_run_google_maps_uses_rendered_prompt() -> None:
    """Verify runtime execution builds a prompt from the invocation payload.

    Returns:
        None.
    """
    captured_prompt: str | None = None
    fake_client = FakeGoogleMapsClient()

    class FakeAgent:
        """Stub Pydantic AI agent returning a fixed Google Maps result."""

        async def run(self, prompt: str) -> SimpleNamespace:
            """Record the prompt and return a deterministic result.

            Args:
                prompt: Prompt rendered by the runtime.

            Returns:
                Namespace carrying the structured output.
            """
            nonlocal captured_prompt
            captured_prompt = prompt
            return SimpleNamespace(
                output=GoogleMapsResult(
                    action=GoogleMapsAction.ANSWERED,
                    answer="確認しました。",
                    places=[],
                    route=None,
                    caveats=[],
                    follow_up_question=None,
                )
            )

    def fake_build_google_maps_agent(
        model: str | None = None,
        *,
        client: FakeGoogleMapsClient | None = None,
    ) -> FakeAgent:
        """Return a fake agent for runtime tests.

        Args:
            model: Optional model override passed by the runtime.
            client: Injected fake client passed by the runtime.

        Returns:
            Fake agent instance.
        """
        assert model == "google-vertex:gemini-3-flash-preview"
        assert client is fake_client
        return FakeAgent()

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            google_maps_runtime_module,
            "build_google_maps_agent",
            fake_build_google_maps_agent,
        )
        result = await run_google_maps(
            make_invocation(),
            model="google-vertex:gemini-3-flash-preview",
            client=fake_client,
        )

    assert result.answer == "確認しました。"
    assert captured_prompt is not None
    assert "Slack request:\n新宿駅近くのカフェを探して" in captured_prompt
    assert fake_client.closed is False
