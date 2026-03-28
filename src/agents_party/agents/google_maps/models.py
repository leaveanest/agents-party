"""Typed models for the Google Maps agent package."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from agents_party.agents.slack_runtime import SlackAgentInvocation


class GoogleMapsInvocation(SlackAgentInvocation):
    """Slack request envelope specialized for Google Maps execution."""


class GoogleMapsAction(StrEnum):
    """High-level outcomes produced by the Google Maps agent."""

    ANSWERED = "answered"
    CLARIFICATION_NEEDED = "clarification_needed"


class GoogleMapsPlaceSummary(BaseModel):
    """Normalized place summary returned from Google Maps lookups."""

    model_config = ConfigDict(extra="forbid")

    name: str
    place_id: str | None = None
    formatted_address: str | None = None
    google_maps_uri: str | None = None
    primary_type: str | None = None
    rating: float | None = None
    user_rating_count: int | None = None
    latitude: float | None = None
    longitude: float | None = None


class GoogleMapsRouteSummary(BaseModel):
    """Normalized route summary returned from Google Maps routing."""

    model_config = ConfigDict(extra="forbid")

    origin: str
    destination: str
    travel_mode: str = "driving"
    distance_meters: int | None = None
    duration_seconds: int | None = None
    summary: str | None = None
    google_maps_uri: str | None = None


class GoogleMapsResult(BaseModel):
    """Structured response returned by the Google Maps runtime."""

    model_config = ConfigDict(extra="forbid")

    action: GoogleMapsAction
    answer: str = ""
    places: list[GoogleMapsPlaceSummary] = Field(default_factory=list)
    route: GoogleMapsRouteSummary | None = None
    caveats: list[str] = Field(default_factory=list)
    follow_up_question: str | None = None


__all__ = [
    "GoogleMapsAction",
    "GoogleMapsInvocation",
    "GoogleMapsPlaceSummary",
    "GoogleMapsResult",
    "GoogleMapsRouteSummary",
]
