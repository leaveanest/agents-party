"""Public API for the agent-router package."""

from .models import (
    AgentRouterAction,
    AgentRouterDeps,
    AgentRouterResult,
)
from .runtime import (
    build_agent_router_agent,
    build_agent_router_instructions,
    build_agent_router_prompt,
    run_agent_router,
)

__all__ = [
    "AgentRouterAction",
    "AgentRouterDeps",
    "AgentRouterResult",
    "build_agent_router_agent",
    "build_agent_router_instructions",
    "build_agent_router_prompt",
    "run_agent_router",
]
