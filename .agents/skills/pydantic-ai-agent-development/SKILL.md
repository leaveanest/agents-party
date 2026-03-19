---
name: pydantic-ai-agent-development
description: Build or refactor `pydantic-ai` agents for this repository. Use when Codex needs to add a new agent, restructure agent modules, wire dependencies or toolsets, choose between single-agent and multi-agent flows, or align agent code with the repository's Slack, domain, repository, and Firestore boundaries.
---

# Pydantic AI Agent Development

Build agents here by defining the contract first, then placing code in the correct layer.
Keep instructions concise, keep dependencies typed, and keep side effects behind repositories or dedicated toolsets.

## Workflow

1. Define the agent contract before writing code.
   - Name the agent and state the user-facing job it performs.
   - Decide the `deps_type` that exposes repositories, clients, or services through `RunContext`.
   - Decide the `output_type` that keeps final answers structured and validated.
   - Decide whether the agent needs tools at all; avoid tool sprawl.
2. Map the change onto the repository boundaries.
   - Put agent builders, dependency containers, and orchestration helpers under `src/agents_party/agents/`.
   - Keep Slack SDK usage under `src/agents_party/slack/`.
   - Keep Firestore SDK usage under `src/agents_party/infrastructure/firestore/`.
   - Keep domain models independent from Slack and Firestore.
3. Start from an explicit scaffold instead of hand-rolling the shape every time.
   - Run `scripts/render_agent_module.py` when the task starts with a blank agent module.
   - Adapt the generated skeleton to the concrete repositories and outputs needed by the task.
4. Prefer one focused agent unless a hard boundary forces a split.
   - Split into multiple agents only when tool access, security boundaries, or context differ materially.
   - Keep a single agent when the only difference is prompt wording.
5. Add tools and toolsets deliberately.
   - Group reusable capabilities into toolsets.
   - Keep each tool narrow, typed, and explicit about side effects.
   - Keep long domain detail in references or repositories, not in massive instruction strings.
6. Validate on the changed paths.
   - Run `uv run ruff check <changed paths>`.
   - Run `uv run ruff format <changed paths>`.
   - Run `uv run ty check <changed paths>`.
   - Add or update tests under `tests/` for new agent behavior.

## References

- Read `references/repo-map.md` before moving logic across package boundaries or wiring Slack and Firestore code.
- Read `references/pydantic-ai-best-practices.md` before choosing output models, dependencies, toolsets, or multi-agent decomposition.

## Expected Outcomes

- Create new agent modules under `src/agents_party/agents/definitions/`.
- Keep reusable agent support code under `src/agents_party/agents/skills/` or adjacent `agents/` modules.
- Add tests that use `TestModel` for fast structural validation before introducing broader end-to-end tests.

## Guardrails

- Do not put Slack SDK calls inside domain or repository modules.
- Do not put Firestore SDK calls outside `src/agents_party/infrastructure/firestore/` without a strong reason.
- Do not add multi-agent coordination when a single typed agent is enough.
- Do not leave outputs untyped when a stable schema is known.
