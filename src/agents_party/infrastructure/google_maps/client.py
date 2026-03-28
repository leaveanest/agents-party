"""Google Maps Platform HTTP client helpers."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Protocol
from urllib.parse import urlencode

import httpx

if TYPE_CHECKING:
    from agents_party.agents.google_maps.models import (
        GoogleMapsPlaceSummary,
        GoogleMapsRouteSummary,
    )


class GoogleMapsClientError(RuntimeError):
    """Raised when Google Maps Platform cannot return a usable result."""

    def __init__(
        self,
        message: str,
        *,
        error_code: str | None = None,
        status_code: int | None = None,
        retriable: bool = False,
    ) -> None:
        """Initialize the Google Maps client error.

        Args:
            message: Human-readable error message.
            error_code: Optional stable machine-readable error code.
            status_code: Optional HTTP status code returned by the API.
            retriable: Whether retrying the request may succeed.
        """
        super().__init__(message)
        self.error_code = error_code
        self.status_code = status_code
        self.retriable = retriable


class GoogleMapsClientProtocol(Protocol):
    """Protocol implemented by Google Maps clients used by the agent runtime."""

    async def search_places(self, query: str) -> list["GoogleMapsPlaceSummary"]:
        """Search for places matching a free-text query."""

    async def search_nearby(
        self,
        anchor_query: str,
        search_query: str,
        radius_meters: int = 1500,
    ) -> list["GoogleMapsPlaceSummary"]:
        """Search for places near an anchor location."""

    async def compute_route(
        self,
        origin: str,
        destination: str,
        travel_mode: str = "driving",
    ) -> "GoogleMapsRouteSummary":
        """Compute a route between two locations."""

    async def aclose(self) -> None:
        """Close any owned transport resources."""


class HttpxGoogleMapsClient:
    """Thin wrapper around Google Maps Platform Places and Routes APIs."""

    _PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
    _ROUTES_COMPUTE_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
    _PLACES_FIELD_MASK = ",".join(
        (
            "places.id",
            "places.displayName",
            "places.formattedAddress",
            "places.location",
            "places.googleMapsUri",
            "places.primaryType",
            "places.rating",
            "places.userRatingCount",
        )
    )
    _ROUTES_FIELD_MASK = ",".join(
        (
            "routes.distanceMeters",
            "routes.duration",
            "routes.description",
        )
    )

    def __init__(
        self,
        *,
        api_key: str,
        language_code: str = "ja",
        region_code: str = "JP",
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        """Create a Google Maps HTTP client.

        Args:
            api_key: Google Maps Platform API key.
            language_code: Preferred response language code for Maps responses.
            region_code: Preferred response region code for Maps responses.
            http_client: Optional injected async HTTP client for tests.

        Raises:
            ValueError: If the API key is blank.
        """
        normalized_api_key = api_key.strip()
        if not normalized_api_key:
            raise ValueError("Google Maps API key must not be blank.")

        self._api_key = normalized_api_key
        self._language_code = language_code.strip() or "ja"
        self._region_code = region_code.strip() or "JP"
        self._owns_http_client = http_client is None
        self._http_client = http_client or httpx.AsyncClient(timeout=10.0)

    async def search_places(self, query: str) -> list["GoogleMapsPlaceSummary"]:
        """Search for places matching a free-text query.

        Args:
            query: User-facing place or address query.

        Returns:
            Up to five normalized place summaries.
        """
        return await self._search_text(
            text_query=query,
            max_result_count=5,
        )

    async def search_nearby(
        self,
        anchor_query: str,
        search_query: str,
        radius_meters: int = 1500,
    ) -> list["GoogleMapsPlaceSummary"]:
        """Search for places near an anchor location.

        Args:
            anchor_query: Anchor place or address used to establish the center.
            search_query: Query describing the nearby places to find.
            radius_meters: Radius around the anchor in meters.

        Returns:
            Up to five normalized nearby place summaries.

        Raises:
            GoogleMapsClientError: If the anchor cannot be resolved.
            ValueError: If the radius is not positive.
        """
        if radius_meters <= 0:
            raise ValueError("Nearby search radius must be positive.")

        anchor_results = await self._search_text(
            text_query=anchor_query,
            max_result_count=1,
        )
        if not anchor_results:
            raise GoogleMapsClientError(
                "Could not resolve the anchor place for nearby search.",
                error_code="anchor_not_found",
                retriable=False,
            )

        anchor = anchor_results[0]
        if anchor.latitude is None or anchor.longitude is None:
            raise GoogleMapsClientError(
                "Resolved anchor place is missing coordinates.",
                error_code="anchor_missing_coordinates",
                retriable=False,
            )

        return await self._search_text(
            text_query=search_query,
            max_result_count=5,
            location_bias={
                "circle": {
                    "center": {
                        "latitude": anchor.latitude,
                        "longitude": anchor.longitude,
                    },
                    "radius": float(radius_meters),
                }
            },
        )

    async def compute_route(
        self,
        origin: str,
        destination: str,
        travel_mode: str = "driving",
    ) -> "GoogleMapsRouteSummary":
        """Compute a route between two locations.

        Args:
            origin: Free-text route origin.
            destination: Free-text route destination.
            travel_mode: Requested travel mode, such as `driving` or `walking`.

        Returns:
            Normalized route summary.
        """
        payload = await self._post_json(
            self._ROUTES_COMPUTE_URL,
            json_body={
                "origin": {"address": origin},
                "destination": {"address": destination},
                "travelMode": _normalize_travel_mode(travel_mode),
                "languageCode": self._language_code,
                "units": "METRIC",
            },
            field_mask=self._ROUTES_FIELD_MASK,
            request_name="Google Maps route request",
        )
        routes = payload.get("routes")
        if not isinstance(routes, list) or not routes:
            raise GoogleMapsClientError(
                "Google Maps route request returned no routes.",
                error_code="empty_routes",
                retriable=False,
            )

        route = routes[0]
        if not isinstance(route, Mapping):
            raise GoogleMapsClientError(
                "Google Maps route response had an invalid shape.",
                error_code="invalid_response",
                retriable=False,
            )

        from agents_party.agents.google_maps.models import GoogleMapsRouteSummary

        return GoogleMapsRouteSummary(
            origin=origin.strip(),
            destination=destination.strip(),
            travel_mode=_canonical_travel_mode(travel_mode),
            distance_meters=_as_int(route.get("distanceMeters")),
            duration_seconds=_parse_duration_seconds(route.get("duration")),
            summary=_as_optional_text(route.get("description")),
            google_maps_uri=_build_google_maps_directions_uri(
                origin=origin,
                destination=destination,
                travel_mode=travel_mode,
            ),
        )

    async def aclose(self) -> None:
        """Close the owned HTTP client if this instance created it."""
        if self._owns_http_client:
            await self._http_client.aclose()

    async def _search_text(
        self,
        *,
        text_query: str,
        max_result_count: int,
        location_bias: Mapping[str, Any] | None = None,
    ) -> list["GoogleMapsPlaceSummary"]:
        """Execute a Places Text Search request and normalize the results.

        Args:
            text_query: Free-text place query to submit to Places.
            max_result_count: Maximum number of place results to request.
            location_bias: Optional location bias object for nearby searches.

        Returns:
            Normalized place summaries.
        """
        payload: dict[str, Any] = {
            "textQuery": text_query,
            "languageCode": self._language_code,
            "regionCode": self._region_code,
            "maxResultCount": max_result_count,
        }
        if location_bias is not None:
            payload["locationBias"] = dict(location_bias)

        response_payload = await self._post_json(
            self._PLACES_TEXT_SEARCH_URL,
            json_body=payload,
            field_mask=self._PLACES_FIELD_MASK,
            request_name="Google Maps place search",
        )
        places = response_payload.get("places")
        if not isinstance(places, list):
            return []
        return [
            self._parse_place(place) for place in places if isinstance(place, Mapping)
        ]

    def _parse_place(self, place: Mapping[str, Any]) -> "GoogleMapsPlaceSummary":
        """Normalize one Places API result into the shared place summary model.

        Args:
            place: Raw Places API place object.

        Returns:
            Normalized place summary.
        """
        from agents_party.agents.google_maps.models import GoogleMapsPlaceSummary

        display_name = place.get("displayName")
        name = ""
        if isinstance(display_name, Mapping):
            name = _as_optional_text(display_name.get("text")) or ""

        location = place.get("location")
        latitude: float | None = None
        longitude: float | None = None
        if isinstance(location, Mapping):
            latitude = _as_float(location.get("latitude"))
            longitude = _as_float(location.get("longitude"))

        return GoogleMapsPlaceSummary(
            name=name
            or _as_optional_text(place.get("formattedAddress"))
            or "Unknown place",
            place_id=_as_optional_text(place.get("id")),
            formatted_address=_as_optional_text(place.get("formattedAddress")),
            google_maps_uri=_as_optional_text(place.get("googleMapsUri")),
            primary_type=_as_optional_text(place.get("primaryType")),
            rating=_as_float(place.get("rating")),
            user_rating_count=_as_int(place.get("userRatingCount")),
            latitude=latitude,
            longitude=longitude,
        )

    async def _post_json(
        self,
        url: str,
        *,
        json_body: Mapping[str, Any],
        field_mask: str,
        request_name: str,
    ) -> Mapping[str, Any]:
        """Send a JSON POST request to Google Maps and parse the response.

        Args:
            url: Fully qualified endpoint URL.
            json_body: JSON payload sent to the endpoint.
            field_mask: Requested Maps field mask.
            request_name: Human-readable name for error messages.

        Returns:
            Parsed JSON object from the API.

        Raises:
            GoogleMapsClientError: If transport, HTTP, or JSON parsing fails.
        """
        try:
            response = await self._http_client.post(
                url,
                json=json_body,
                headers={
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": self._api_key,
                    "X-Goog-FieldMask": field_mask,
                },
            )
        except httpx.HTTPError as exc:
            raise GoogleMapsClientError(
                f"{request_name} failed due to an HTTP transport error.",
                error_code="transport_error",
                retriable=True,
            ) from exc

        if response.status_code >= 400:
            payload = self._safe_json(response)
            error_message = None
            error_code = None
            if isinstance(payload, Mapping):
                error_payload = payload.get("error")
                if isinstance(error_payload, Mapping):
                    error_message = _as_optional_text(error_payload.get("message"))
                    error_code = _as_optional_text(error_payload.get("status"))
            raise GoogleMapsClientError(
                error_message
                or f"{request_name} returned HTTP {response.status_code}.",
                error_code=error_code or "api_error",
                status_code=response.status_code,
                retriable=response.status_code in {429, 500, 502, 503, 504},
            )

        payload = self._safe_json(response)
        if not isinstance(payload, Mapping):
            raise GoogleMapsClientError(
                "Google Maps API returned a non-object JSON response.",
                error_code="invalid_response",
                status_code=response.status_code,
                retriable=False,
            )
        return payload

    def _safe_json(self, response: httpx.Response) -> Mapping[str, Any] | Any:
        """Parse JSON from an HTTP response.

        Args:
            response: HTTP response returned by `httpx`.

        Returns:
            Parsed JSON content.

        Raises:
            GoogleMapsClientError: If the body is not valid JSON.
        """
        try:
            return response.json()
        except ValueError as exc:
            raise GoogleMapsClientError(
                "Google Maps API returned invalid JSON.",
                error_code="invalid_response",
                status_code=response.status_code,
                retriable=False,
            ) from exc


def _canonical_travel_mode(travel_mode: str) -> str:
    """Return the normalized external travel-mode string.

    Args:
        travel_mode: User-provided travel-mode value.

    Returns:
        Canonical lower-case travel-mode string.
    """
    return {
        "drive": "driving",
        "driving": "driving",
        "car": "driving",
        "walk": "walking",
        "walking": "walking",
        "bicycle": "bicycling",
        "bicycling": "bicycling",
        "bike": "bicycling",
        "transit": "transit",
        "public_transit": "transit",
        "two_wheeler": "two_wheeler",
        "motorcycle": "two_wheeler",
    }.get(travel_mode.strip().lower(), "driving")


def _normalize_travel_mode(travel_mode: str) -> str:
    """Map a user-facing travel mode into the Routes API enum value.

    Args:
        travel_mode: User-provided travel-mode value.

    Returns:
        Routes API travel-mode enum string.
    """
    canonical_mode = _canonical_travel_mode(travel_mode)
    return {
        "driving": "DRIVE",
        "walking": "WALK",
        "bicycling": "BICYCLE",
        "transit": "TRANSIT",
        "two_wheeler": "TWO_WHEELER",
    }.get(canonical_mode, "DRIVE")


def _parse_duration_seconds(duration_value: object) -> int | None:
    """Parse a Routes API duration string into whole seconds.

    Args:
        duration_value: Raw duration value such as `\"1080s\"`.

    Returns:
        Whole duration in seconds when available.
    """
    if not isinstance(duration_value, str):
        return None
    normalized = duration_value.strip()
    if not normalized.endswith("s"):
        return None
    try:
        return int(float(normalized[:-1]))
    except ValueError:
        return None


def _build_google_maps_directions_uri(
    *,
    origin: str,
    destination: str,
    travel_mode: str,
) -> str:
    """Build a Google Maps directions link for a route.

    Args:
        origin: Route origin text.
        destination: Route destination text.
        travel_mode: User-facing travel-mode value.

    Returns:
        Public Google Maps directions URL.
    """
    return "https://www.google.com/maps/dir/?" + urlencode(
        {
            "api": "1",
            "origin": origin,
            "destination": destination,
            "travelmode": {
                "driving": "driving",
                "walking": "walking",
                "bicycling": "bicycling",
                "transit": "transit",
                "two_wheeler": "two-wheeler",
            }.get(_canonical_travel_mode(travel_mode), "driving"),
        }
    )


def _as_optional_text(value: object) -> str | None:
    """Return a stripped string when the value is a non-blank string.

    Args:
        value: Arbitrary value from an API response.

    Returns:
        Stripped string when present, otherwise `None`.
    """
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _as_int(value: object) -> int | None:
    """Convert an arbitrary numeric-looking value into an integer.

    Args:
        value: Arbitrary value from an API response.

    Returns:
        Integer value when conversion succeeds.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _as_float(value: object) -> float | None:
    """Convert an arbitrary numeric-looking value into a float.

    Args:
        value: Arbitrary value from an API response.

    Returns:
        Float value when conversion succeeds.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


__all__ = [
    "GoogleMapsClientError",
    "GoogleMapsClientProtocol",
    "HttpxGoogleMapsClient",
]
