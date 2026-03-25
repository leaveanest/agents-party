"""Typed models for the web-research agent package."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from agents_party.agents.slack_runtime import SlackAgentInvocation


class WebResearchInvocation(SlackAgentInvocation):
    """Slack request envelope specialized for web research execution."""


class WebResearchAction(StrEnum):
    """High-level outcomes produced by the web-research agent."""

    ANSWERED = "answered"
    CLARIFICATION_NEEDED = "clarification_needed"


class WebResearchSource(BaseModel):
    """Source citation captured from the web-research run."""

    model_config = ConfigDict(extra="forbid")

    title: str
    url: str
    publisher: str | None = None
    note: str | None = None


class WebResearchResult(BaseModel):
    """Structured response returned by the web-research runtime."""

    model_config = ConfigDict(extra="forbid")

    action: WebResearchAction
    answer: str = ""
    sources: list[WebResearchSource] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)
    follow_up_question: str | None = None


__all__ = [
    "WebResearchAction",
    "WebResearchInvocation",
    "WebResearchResult",
    "WebResearchSource",
]
