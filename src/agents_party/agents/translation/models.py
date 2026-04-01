"""Typed models for the translation agent package."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict

from agents_party.agents.slack_runtime import SlackAgentInvocation


class TranslationInvocation(SlackAgentInvocation):
    """Slack request envelope specialized for translation execution."""

    source_message_text: str | None = None
    requested_target_language: str | None = None
    target_message_ts: str | None = None
    reaction_name: str | None = None


class TranslationAction(StrEnum):
    """High-level outcomes produced by the translation agent."""

    TRANSLATED = "translated"
    CLARIFICATION_NEEDED = "clarification_needed"


class TranslationResult(BaseModel):
    """Structured response returned by the translation runtime."""

    model_config = ConfigDict(extra="forbid")

    action: TranslationAction
    translated_text: str = ""
    source_language: str | None = None
    target_language: str | None = None
    follow_up_question: str | None = None


__all__ = [
    "TranslationAction",
    "TranslationInvocation",
    "TranslationResult",
]
