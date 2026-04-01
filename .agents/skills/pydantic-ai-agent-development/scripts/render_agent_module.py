"""Render a minimal package scaffold for new repository-local agents."""

from __future__ import annotations

import argparse
import re
from collections.abc import Mapping

DEFAULT_MODEL = "google-vertex:gemini-3-flash-preview"


def _to_snake_case(value: str) -> str:
    """Convert a label into a snake_case module name.

    Args:
        value: User-provided agent name or label.

    Returns:
        Snake-case version of the provided value.
    """
    normalized = re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_")
    snake_case = re.sub(r"(?<!^)(?=[A-Z])", "_", normalized)
    return re.sub(r"_+", "_", snake_case).lower()


def _to_pascal_case(value: str) -> str:
    """Convert a label into a PascalCase Python type name.

    Args:
        value: User-provided agent name or label.

    Returns:
        Pascal-case version of the provided value.
    """
    parts = re.split(r"[^a-zA-Z0-9]+", value)
    return "".join(part.capitalize() for part in parts if part)


def _render_init_module(
    *,
    module_name: str,
    deps_class: str,
    output_model: str,
) -> str:
    """Render the public package entry point for a scaffolded agent.

    Args:
        module_name: Snake-case module name used for function names.
        deps_class: Dependency dataclass name.
        output_model: Pydantic output model name.

    Returns:
        Python module source for `__init__.py`.
    """
    builder_name = f"build_{module_name}_agent"
    run_name = f"run_{module_name}"
    default_model_name = f"DEFAULT_{module_name.upper()}_MODEL"

    return f'''"""Public API for the {module_name} agent package."""

from .models import {deps_class}, {output_model}
from .runtime import {default_model_name}, {builder_name}, {run_name}

__all__ = [
    "{deps_class}",
    "{output_model}",
    "{default_model_name}",
    "{builder_name}",
    "{run_name}",
]
'''


def _render_models_module(
    *,
    agent_name: str,
    deps_class: str,
    output_model: str,
    summary_field: str,
) -> str:
    """Render the typed models module for a scaffolded agent.

    Args:
        agent_name: Human-readable agent name for docstrings.
        deps_class: Dependency dataclass name.
        output_model: Pydantic output model name.
        summary_field: Primary response field name.

    Returns:
        Python module source for `models.py`.
    """
    return f'''"""Typed models for the {agent_name} agent package."""

from dataclasses import dataclass

from pydantic import BaseModel, Field


@dataclass(slots=True)
class {deps_class}:
    """Dependencies the {agent_name} agent can access through RunContext."""


class {output_model}(BaseModel):
    """Structured response returned by the {agent_name} agent."""

    {summary_field}: str = Field(description="Primary structured response for callers.")
'''


def _render_runtime_module(
    *,
    agent_name: str,
    module_name: str,
    deps_class: str,
    output_model: str,
) -> str:
    """Render the runtime module for a scaffolded agent.

    Args:
        agent_name: Human-readable agent name for docstrings.
        module_name: Snake-case module name used for function names.
        deps_class: Dependency dataclass name.
        output_model: Pydantic output model name.

    Returns:
        Python module source for `runtime.py`.
    """
    builder_name = f"build_{module_name}_agent"
    run_name = f"run_{module_name}"
    default_model_name = f"DEFAULT_{module_name.upper()}_MODEL"

    return f'''"""Runtime helpers for the {module_name} agent package.

Keep the public entry point small. Split prompts, preparers, messages, or
executors into adjacent modules only when responsibilities clearly diverge.
"""

from pydantic_ai import Agent

from .models import {deps_class}, {output_model}

{default_model_name} = "{DEFAULT_MODEL}"


def {builder_name}(
    model: str = {default_model_name},
) -> Agent[{deps_class}, {output_model}]:
    """Build the {agent_name} agent.

    Args:
        model: Provider-qualified Gemini model name for the agent.

    Returns:
        Configured `pydantic-ai` agent instance.
    """
    return Agent(
        model,
        deps_type={deps_class},
        output_type={output_model},
        instructions=(
            "Describe the agent's job in one or two stable sentences. "
            "Keep Slack and database specifics outside this package. "
            "Move volatile domain detail into repositories, tools, or adjacent helpers."
        ),
    )


async def {run_name}(
    prompt: str,
    *,
    deps: {deps_class},
    model: str = {default_model_name},
) -> {output_model}:
    """Run the {agent_name} agent against a prepared prompt.

    Args:
        prompt: Prepared input passed to the agent.
        deps: Typed dependencies exposed through `RunContext`.
        model: Provider-qualified Gemini model name for the agent.

    Returns:
        Structured agent output.
    """
    agent = {builder_name}(model=model)
    result = await agent.run(prompt, deps=deps)
    return result.output
'''


def render_agent_package(
    *,
    agent_name: str,
    module_name: str,
    deps_class: str,
    output_model: str,
    summary_field: str,
) -> dict[str, str]:
    """Render a minimal package scaffold for a new agent.

    Args:
        agent_name: Human-readable agent name for docstrings.
        module_name: Snake-case module name used for package and function names.
        deps_class: Dependency dataclass name.
        output_model: Pydantic output model name.
        summary_field: Primary response field name for the output model.

    Returns:
        Mapping of relative file names to Python source content.
    """
    return {
        "__init__.py": _render_init_module(
            module_name=module_name,
            deps_class=deps_class,
            output_model=output_model,
        ),
        "models.py": _render_models_module(
            agent_name=agent_name,
            deps_class=deps_class,
            output_model=output_model,
            summary_field=summary_field,
        ),
        "runtime.py": _render_runtime_module(
            agent_name=agent_name,
            module_name=module_name,
            deps_class=deps_class,
            output_model=output_model,
        ),
    }


def render_sectioned_output(sections: Mapping[str, str]) -> str:
    """Render scaffold files as a Markdown-style sectioned document.

    Args:
        sections: Mapping of relative file names to file content.

    Returns:
        Single string containing the files grouped into named code sections.
    """
    ordered_sections = []
    for file_name in ("__init__.py", "models.py", "runtime.py"):
        ordered_sections.append(
            f"### `{file_name}`\n```python\n{sections[file_name]}\n```"
        )
    return "\n\n".join(ordered_sections)


def main() -> None:
    """Render the scaffold package for a new agent and print it to stdout.

    Returns:
        None.
    """
    parser = argparse.ArgumentParser(
        description="Render a starter pydantic-ai agent module for this repository."
    )
    parser.add_argument(
        "--agent-name", required=True, help="User-facing or logical agent name."
    )
    parser.add_argument(
        "--deps-class",
        help="Optional dependency class name. Defaults to <AgentName>Deps.",
    )
    parser.add_argument(
        "--output-model",
        help="Optional output model class name. Defaults to <AgentName>Output.",
    )
    parser.add_argument(
        "--summary-field",
        default="summary",
        help="Primary output field name. Defaults to 'summary'.",
    )
    args = parser.parse_args()

    module_name = _to_snake_case(args.agent_name)
    pascal_name = _to_pascal_case(args.agent_name)
    deps_class = args.deps_class or f"{pascal_name}Deps"
    output_model = args.output_model or f"{pascal_name}Output"
    scaffold = render_agent_package(
        agent_name=args.agent_name,
        module_name=module_name,
        deps_class=deps_class,
        output_model=output_model,
        summary_field=args.summary_field,
    )

    print(render_sectioned_output(scaffold))


if __name__ == "__main__":
    main()
