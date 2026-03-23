---
name: pydantic-ai-agent-development
description: Build or refactor `pydantic-ai` agents for this repository. Use when Codex needs to add a new agent, restructure agent modules, wire dependencies or toolsets, choose between single-agent and multi-agent flows, or align agent code with the repository's Slack, domain, repository, and Firestore boundaries.
---

# Pydantic AI Agent Development

Build agents here by defining the contract first, then placing code in the correct layer.
Start from the smallest package that can work, keep dependencies typed, and keep side effects behind repositories or dedicated toolsets.

## Workflow

1. Define the agent contract before writing code.
   - Name the agent and state the user-facing job it performs.
   - Decide the `deps_type` that exposes repositories, clients, or services through `RunContext`.
   - Decide the `output_type` that keeps final answers structured and validated.
   - Decide whether the agent needs tools at all; avoid tool sprawl.
2. Start from the smallest current repo pattern.
   - Create a package under `src/agents_party/agents/<agent_name>/`.
   - Make `__init__.py` the public entry point and re-export the package surface that callers should import.
   - Start with `models.py` and `runtime.py` only when the agent is new or still small.
   - Add `executor.py`, `preparer.py`, `prompts.py`, or `messages.py` only after responsibilities diverge.
3. Map the change onto the repository boundaries.
   - Put agent builders, dependency containers, and orchestration helpers under `src/agents_party/agents/`.
   - Keep Slack SDK usage under `src/agents_party/slack/`.
   - Keep Firestore SDK usage under `src/agents_party/infrastructure/firestore/`.
   - Keep domain models independent from Slack and Firestore.
4. Start from an explicit scaffold instead of hand-rolling the shape every time.
   - Run `scripts/render_agent_module.py` when the task starts with a blank agent module.
   - The scaffold prints a minimal package layout for `__init__.py`, `models.py`, and `runtime.py`.
   - Adapt the generated skeleton to the concrete repositories, prompts, and outputs needed by the task.
5. Prefer one focused agent unless a hard boundary forces a split.
   - Split into multiple agents only when tool access, security boundaries, or context differ materially.
   - Keep a single agent when the only difference is prompt wording.
6. Reuse shared runtime helpers before copying a large built-in agent.
   - Use `prepared_agent_runner.py` for repository-backed prepare-then-execute flows.
   - Use `request_preparation.py` for sync-or-async request preparer hooks.
   - Use `slack_runtime.py` only for Slack-facing routing and execution envelopes.
   - Treat `work_manager/` as a reference for package shape, not as a template to copy wholesale.
7. Add tools and toolsets deliberately.
   - Group reusable capabilities into toolsets.
   - Keep each tool narrow, typed, and explicit about side effects.
   - For this repository, when a Gemini-backed agent needs enterprise Google access, assume Vertex AI via `google-vertex` unless the task explicitly requires `google-gla`.
   - On Vertex AI, plan around `WebSearchTool`, `CodeExecutionTool`, and `WebFetchTool`; use `ImageGenerationTool` only with image generation models.
   - On Vertex AI, do not design around `FileSearchTool`, `MemoryTool`, or `MCPServerTool` as built-in tools.
   - When using Google built-in tools, avoid combining them with function tools or output tools; if structured output is still required, prefer `PromptedOutput`.
   - Keep long domain detail in references or repositories, not in massive instruction strings.
8. Validate on the changed paths.
   - Run `uv run ruff check <changed paths>`.
   - Run `uv run ruff format <changed paths>`.
   - Run `uv run ty check <changed paths>`.
   - Add or update tests under `tests/` for new agent behavior.

## References

- Read `references/repo-map.md` before moving logic across package boundaries or wiring Slack and Firestore code.
- Read `references/pydantic-ai-best-practices.md` before choosing output models, dependencies, toolsets, or multi-agent decomposition.

## Expected Outcomes

- Create new agent packages under `src/agents_party/agents/<agent_name>/`.
- Keep public imports stable through `agents_party.agents.<agent_name>` via the package `__init__.py`.
- Keep reusable agent support code in adjacent `src/agents_party/agents/` modules when multiple agents share it.
- Add tests that use `TestModel` for fast structural validation before introducing broader end-to-end tests.

## Guardrails

- Do not put Slack SDK calls inside domain or repository modules.
- Do not put Firestore SDK calls outside `src/agents_party/infrastructure/firestore/` without a strong reason.
- Do not add multi-agent coordination when a single typed agent is enough.
- Do not leave outputs untyped when a stable schema is known.
- Do not start with a large multi-file split unless the agent already needs separate runtime, prompt, or preparation responsibilities.
- Do not propose Vertex AI built-in `FileSearchTool` support without re-verifying current provider support first.
