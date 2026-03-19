from __future__ import annotations

import argparse
import re


def _to_snake_case(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_")
    return re.sub(r"(?<!^)(?=[A-Z])", "_", normalized).lower()


def _to_pascal_case(value: str) -> str:
    parts = re.split(r"[^a-zA-Z0-9]+", value)
    return "".join(part.capitalize() for part in parts if part)


def _render_module(
    *,
    module_name: str,
    deps_class: str,
    output_model: str,
    summary_field: str,
) -> str:
    builder_name = f"build_{module_name}_agent"

    return f"""from dataclasses import dataclass

from pydantic import BaseModel, Field
from pydantic_ai import Agent


@dataclass(slots=True)
class {deps_class}:
    \"\"\"Dependencies the agent can access through RunContext.\"\"\"


class {output_model}(BaseModel):
    {summary_field}: str = Field(description="Primary structured response for callers.")


def {builder_name}(model: str) -> Agent[{deps_class}, {output_model}]:
    return Agent(
        model,
        deps_type={deps_class},
        output_type={output_model},
        instructions=(
            "Describe the agent's job in one or two stable sentences. "
            "Move volatile domain detail into repositories, tools, or references."
        ),
    )
"""


def main() -> None:
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

    print(
        _render_module(
            module_name=module_name,
            deps_class=deps_class,
            output_model=output_model,
            summary_field=args.summary_field,
        )
    )


if __name__ == "__main__":
    main()
