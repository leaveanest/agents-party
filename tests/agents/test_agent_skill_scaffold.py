"""Tests for the repository-local agent scaffold generator script."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType


def load_render_agent_module() -> ModuleType:
    """Load the agent scaffold generator script as a Python module.

    Returns:
        Loaded module object for the scaffold generator script.
    """
    script_path = (
        Path(__file__).resolve().parents[2]
        / ".agents/skills/pydantic-ai-agent-development/scripts/render_agent_module.py"
    )
    spec = importlib.util.spec_from_file_location(
        "render_agent_module",
        script_path,
    )
    assert spec is not None
    assert spec.loader is not None

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_render_agent_package_outputs_minimal_package_files() -> None:
    """Verify the scaffold generator emits the expected package file set.

    Returns:
        None.
    """
    module = load_render_agent_module()

    scaffold = module.render_agent_package(
        agent_name="Customer Support",
        module_name="customer_support",
        deps_class="CustomerSupportDeps",
        output_model="CustomerSupportOutput",
        summary_field="summary",
    )

    assert set(scaffold) == {"__init__.py", "models.py", "runtime.py"}
    assert "definitions/" not in "".join(scaffold.values())
    assert "class CustomerSupportOutput(BaseModel):" in scaffold["models.py"]
    assert "def build_customer_support_agent(" in scaffold["runtime.py"]
    assert "CustomerSupportOutput" in scaffold["__init__.py"]


def test_main_prints_sectioned_package_scaffold(monkeypatch, capsys) -> None:
    """Verify the CLI prints the scaffold as named sections.

    Args:
        monkeypatch: Pytest fixture used to override `sys.argv`.
        capsys: Pytest fixture used to capture CLI output.

    Returns:
        None.
    """
    module = load_render_agent_module()
    monkeypatch.setattr(
        "sys.argv",
        [
            "render_agent_module.py",
            "--agent-name",
            "Research Assistant",
        ],
    )

    module.main()
    output = capsys.readouterr().out

    assert "### `__init__.py`" in output
    assert "### `models.py`" in output
    assert "### `runtime.py`" in output
    assert "```python" in output
    assert "DEFAULT_RESEARCH_ASSISTANT_MODEL" in output
    assert "build_research_assistant_agent" in output
