"""Tests for the Google Maps infrastructure client."""

from __future__ import annotations

from typing import Any, cast

import httpx
import pytest

from agents_party.infrastructure.google_maps import (
    GoogleMapsClientError,
    HttpxGoogleMapsClient,
)


class FakeAsyncClient:
    """Stub async client for Google Maps transport tests."""

    def __init__(
        self,
        *,
        responses: list[httpx.Response] | None = None,
        error: Exception | None = None,
    ) -> None:
        """Initialize the stub async client.

        Args:
            responses: Ordered HTTP responses returned by `post`.
            error: Optional exception raised by `post`.

        Returns:
            None.
        """
        self.responses = list(responses or [])
        self.error = error
        self.calls: list[dict[str, object]] = []

    async def post(self, url: str, **kwargs: object) -> httpx.Response:
        """Record a POST request and return the configured outcome.

        Args:
            url: Target URL for the outbound request.
            **kwargs: Additional keyword arguments forwarded by the client.

        Returns:
            Configured HTTP response.

        Raises:
            Exception: Re-raises the configured client error.
        """
        self.calls.append({"url": url, **kwargs})
        if self.error is not None:
            raise self.error
        if not self.responses:
            raise AssertionError("No fake HTTP responses remain.")
        return self.responses.pop(0)


@pytest.mark.asyncio
async def test_search_places_normalizes_place_results() -> None:
    """Verify text search normalizes place summaries from the Places API.

    Returns:
        None.
    """
    http_client = FakeAsyncClient(
        responses=[
            httpx.Response(
                200,
                request=httpx.Request(
                    "POST", "https://places.googleapis.com/v1/places:searchText"
                ),
                json={
                    "places": [
                        {
                            "id": "place-1",
                            "displayName": {"text": "Shinjuku Station"},
                            "formattedAddress": "東京都新宿区新宿3丁目38-1",
                            "googleMapsUri": "https://maps.google.com/?cid=station",
                            "primaryType": "train_station",
                            "rating": 4.1,
                            "userRatingCount": 321,
                            "location": {
                                "latitude": 35.690921,
                                "longitude": 139.700258,
                            },
                        }
                    ]
                },
            )
        ]
    )
    client = HttpxGoogleMapsClient(api_key="test-key", http_client=http_client)  # type: ignore[arg-type]

    places = await client.search_places("新宿駅")

    assert len(places) == 1
    assert places[0].name == "Shinjuku Station"
    assert places[0].place_id == "place-1"
    assert places[0].google_maps_uri == "https://maps.google.com/?cid=station"
    headers = cast(dict[str, object], http_client.calls[0]["headers"])
    assert headers["X-Goog-FieldMask"] == (
        "places.id,places.displayName,places.formattedAddress,"
        "places.location,places.googleMapsUri,places.primaryType,"
        "places.rating,places.userRatingCount"
    )


@pytest.mark.asyncio
async def test_search_nearby_wraps_missing_anchor_results() -> None:
    """Verify nearby search raises a typed error when the anchor cannot resolve.

    Returns:
        None.
    """
    http_client = FakeAsyncClient(
        responses=[
            httpx.Response(
                200,
                request=httpx.Request(
                    "POST", "https://places.googleapis.com/v1/places:searchText"
                ),
                json={"places": []},
            )
        ]
    )
    client = HttpxGoogleMapsClient(api_key="test-key", http_client=http_client)  # type: ignore[arg-type]

    with pytest.raises(GoogleMapsClientError) as exc_info:
        await client.search_nearby("存在しない駅", "カフェ")

    assert (
        str(exc_info.value) == "Could not resolve the anchor place for nearby search."
    )
    assert exc_info.value.error_code == "anchor_not_found"
    assert exc_info.value.retriable is False


@pytest.mark.asyncio
async def test_search_nearby_filters_results_outside_radius() -> None:
    """Verify nearby search excludes places beyond the requested radius.

    Returns:
        None.
    """
    http_client = FakeAsyncClient(
        responses=[
            httpx.Response(
                200,
                request=httpx.Request(
                    "POST", "https://places.googleapis.com/v1/places:searchText"
                ),
                json={
                    "places": [
                        {
                            "id": "anchor",
                            "displayName": {"text": "東京駅"},
                            "formattedAddress": "東京都千代田区丸の内1丁目",
                            "location": {
                                "latitude": 35.681236,
                                "longitude": 139.767125,
                            },
                        }
                    ]
                },
            ),
            httpx.Response(
                200,
                request=httpx.Request(
                    "POST", "https://places.googleapis.com/v1/places:searchText"
                ),
                json={
                    "places": [
                        {
                            "id": "nearby",
                            "displayName": {"text": "Nearby Cafe"},
                            "formattedAddress": "東京都千代田区丸の内1丁目",
                            "location": {
                                "latitude": 35.6818,
                                "longitude": 139.7676,
                            },
                        },
                        {
                            "id": "far-away",
                            "displayName": {"text": "Far Away Cafe"},
                            "formattedAddress": "東京都新宿区西新宿2丁目",
                            "location": {
                                "latitude": 35.6895,
                                "longitude": 139.6917,
                            },
                        },
                    ]
                },
            ),
        ]
    )
    client = HttpxGoogleMapsClient(api_key="test-key", http_client=http_client)  # type: ignore[arg-type]

    places = await client.search_nearby("東京駅", "カフェ", radius_meters=500)

    assert [place.place_id for place in places] == ["nearby"]
    body = cast(dict[str, Any], http_client.calls[1]["json"])
    assert body["maxResultCount"] == 10


@pytest.mark.asyncio
async def test_compute_route_normalizes_route_result() -> None:
    """Verify route lookups normalize distance, duration, and directions links.

    Returns:
        None.
    """
    http_client = FakeAsyncClient(
        responses=[
            httpx.Response(
                200,
                request=httpx.Request(
                    "POST",
                    "https://routes.googleapis.com/directions/v2:computeRoutes",
                ),
                json={
                    "routes": [
                        {
                            "distanceMeters": 7200,
                            "duration": "1080s",
                            "description": "首都高速経由",
                        }
                    ]
                },
            )
        ]
    )
    client = HttpxGoogleMapsClient(api_key="test-key", http_client=http_client)  # type: ignore[arg-type]

    route = await client.compute_route("東京駅", "渋谷駅", travel_mode="driving")

    assert route.distance_meters == 7200
    assert route.duration_seconds == 1080
    assert route.summary == "首都高速経由"
    assert route.google_maps_uri is not None
    assert "origin=%E6%9D%B1%E4%BA%AC%E9%A7%85" in route.google_maps_uri
    assert "destination=%E6%B8%8B%E8%B0%B7%E9%A7%85" in route.google_maps_uri


@pytest.mark.asyncio
async def test_compute_route_defaults_unknown_travel_mode_to_driving() -> None:
    """Verify unknown travel modes are normalized to driving consistently.

    Returns:
        None.
    """
    http_client = FakeAsyncClient(
        responses=[
            httpx.Response(
                200,
                request=httpx.Request(
                    "POST",
                    "https://routes.googleapis.com/directions/v2:computeRoutes",
                ),
                json={
                    "routes": [
                        {
                            "distanceMeters": 7200,
                            "duration": "1080s",
                            "description": "首都高速経由",
                        }
                    ]
                },
            )
        ]
    )
    client = HttpxGoogleMapsClient(api_key="test-key", http_client=http_client)  # type: ignore[arg-type]

    route = await client.compute_route("東京駅", "渋谷駅", travel_mode="train")

    assert route.travel_mode == "driving"
    assert route.google_maps_uri is not None
    assert "travelmode=driving" in route.google_maps_uri
    body = cast(dict[str, Any], http_client.calls[0]["json"])
    assert body["travelMode"] == "DRIVE"


@pytest.mark.asyncio
async def test_search_places_wraps_httpx_transport_failures() -> None:
    """Verify place search wraps transport failures in a typed client error.

    Returns:
        None.
    """
    request = httpx.Request(
        "POST", "https://places.googleapis.com/v1/places:searchText"
    )
    client = HttpxGoogleMapsClient(
        api_key="test-key",
        http_client=FakeAsyncClient(
            error=httpx.ReadTimeout("timed out", request=request)
        ),  # type: ignore[arg-type]
    )

    with pytest.raises(GoogleMapsClientError) as exc_info:
        await client.search_places("新宿駅")

    assert (
        str(exc_info.value)
        == "Google Maps place search failed due to an HTTP transport error."
    )
    assert exc_info.value.error_code == "transport_error"
    assert exc_info.value.retriable is True


@pytest.mark.asyncio
async def test_search_places_wraps_google_api_errors() -> None:
    """Verify Google Maps API error payloads surface as typed client errors.

    Returns:
        None.
    """
    client = HttpxGoogleMapsClient(
        api_key="test-key",
        http_client=FakeAsyncClient(
            responses=[
                httpx.Response(
                    429,
                    request=httpx.Request(
                        "POST",
                        "https://places.googleapis.com/v1/places:searchText",
                    ),
                    json={
                        "error": {
                            "message": "Quota exceeded.",
                            "status": "RESOURCE_EXHAUSTED",
                        }
                    },
                )
            ]
        ),  # type: ignore[arg-type]
    )

    with pytest.raises(GoogleMapsClientError) as exc_info:
        await client.search_places("新宿駅")

    assert str(exc_info.value) == "Quota exceeded."
    assert exc_info.value.error_code == "RESOURCE_EXHAUSTED"
    assert exc_info.value.status_code == 429
    assert exc_info.value.retriable is True


@pytest.mark.asyncio
async def test_search_places_wraps_non_object_error_json() -> None:
    """Verify non-object error JSON still surfaces as a typed client error.

    Returns:
        None.
    """
    client = HttpxGoogleMapsClient(
        api_key="test-key",
        http_client=FakeAsyncClient(
            responses=[
                httpx.Response(
                    503,
                    request=httpx.Request(
                        "POST",
                        "https://places.googleapis.com/v1/places:searchText",
                    ),
                    json=["temporary", "error"],
                )
            ]
        ),  # type: ignore[arg-type]
    )

    with pytest.raises(GoogleMapsClientError) as exc_info:
        await client.search_places("新宿駅")

    assert str(exc_info.value) == "Google Maps place search returned HTTP 503."
    assert exc_info.value.error_code == "api_error"
    assert exc_info.value.status_code == 503
    assert exc_info.value.retriable is True


def test_google_maps_client_requires_api_key() -> None:
    """Verify the Google Maps client rejects blank API keys.

    Returns:
        None.
    """
    with pytest.raises(ValueError) as exc_info:
        HttpxGoogleMapsClient(api_key=" ")

    assert str(exc_info.value) == "Google Maps API key must not be blank."
