"""Public API for the web-research agent package."""

from .models import (
    WebResearchAction,
    WebResearchInvocation,
    WebResearchResult,
    WebResearchSource,
)
from .runtime import (
    DEFAULT_WEB_RESEARCH_MODEL,
    build_web_research_agent,
    build_web_research_instructions,
    build_web_research_prompt,
    render_web_research_response,
    run_web_research,
)

__all__ = [
    "DEFAULT_WEB_RESEARCH_MODEL",
    "WebResearchAction",
    "WebResearchInvocation",
    "WebResearchResult",
    "WebResearchSource",
    "build_web_research_agent",
    "build_web_research_instructions",
    "build_web_research_prompt",
    "render_web_research_response",
    "run_web_research",
]
