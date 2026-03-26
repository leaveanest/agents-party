# AGENTS.md

This repository is a Python Slack application called `agents-party`.
It uses `pydantic-ai` and `pydantic-ai-skills` for agent behavior, Firestore for persistence, and Terraform for infrastructure.

## Core Rules

- Use `uv` for Python environment and dependency management.
- Use `ruff` for linting and formatting.
- Use `ty` for type checking.
- Default new agent implementations to Gemini models unless the user or existing configuration explicitly requires a different model.
- Do not hardcode OpenAI model ids as defaults in agent configuration for this repository.
- Do not use `pip`, `poetry`, or ad-hoc virtualenv workflows in this repository.
- Keep changes small and local. Avoid speculative repo-wide rewrites.
- Write Python docstrings for new or changed modules, classes, functions, and methods.
- Prefer structured docstrings that clearly document purpose, parameters, return values, and raised errors. Use sections such as `Args`, `Returns`, and `Raises` when applicable.
- For functions and methods, document each argument's role and any non-obvious constraints, units, defaults, side effects, or mutation behavior that callers need to know.
- When touching an existing Python function or method, add or update its docstring in the same change.

## Required Commands

- Add runtime dependencies with `uv add ...`
- Add dev dependencies with `uv add --dev ...`
- Sync the environment with `uv sync`
- Lint changed files with `uv run ruff check <path>`
- Format changed files with `uv run ruff format <path>`
- Type-check changed files with `uv run ty check <path>`
- Run broader checks only when needed by the change or when explicitly requested

If `ruff`, `ty`, or test tooling is missing from the project, add it through `uv` instead of using another package manager.

## Repository Structure

- `src/agents_party/slack/`: Slack-specific entry points, events, and feature handlers
- `src/agents_party/agents/`: `pydantic-ai` agent definitions, skills, dependencies, and runners
- `src/agents_party/domain/`: domain models and business concepts that should not depend on Slack or Firestore
- `src/agents_party/repositories/`: persistence-facing interfaces and repository logic
- `src/agents_party/infrastructure/firestore/`: Firestore-specific client and storage implementation
- `tests/`: automated tests
- `terraform/`: infrastructure code, separated from application code
- `docs/`: design notes and operational documentation

## Architecture Boundaries

- Keep Slack SDK usage inside `src/agents_party/slack/`.
- Keep Firestore SDK usage inside `src/agents_party/infrastructure/firestore/` unless there is a strong reason not to.
- Prefer repositories as the boundary between domain logic and Firestore implementation.
- Put agent orchestration and skill composition in `src/agents_party/agents/`.
- Do not introduce database migration tooling for Firestore in this project.

## Documentation Conventions

- Store architecture diagrams under `docs/` and prefer PlantUML (`.puml`) unless the user asks for a different format.
- For architecture diagrams, prioritize system-to-system relationships over library-level dependencies.
- When documenting Google Cloud architecture, show managed services explicitly and keep Google Cloud internals more detailed than external systems when that helps explain the design.
- Treat Vertex AI as a Google Cloud service inside the Google Cloud boundary, not as an external provider.
- Do not enumerate Secret Manager contents or individual secret names in repository documentation unless the user explicitly asks for that level of detail.
- If a diagram includes infrastructure that is operationally assumed but not yet codified in `terraform/` or deployment config, label that assumption clearly.

## Validation Expectations

- After editing Python files, run `ruff` and `ty` on the changed paths.
- Run project-wide validation when changes affect shared configuration, import structure, or multiple packages.
- Prefer file-scoped validation first because it is faster and keeps feedback tight.
- After implementation work, ask the review agent to review the change before considering the task complete.
- If the review agent is unavailable, state that explicitly in the final handoff.

## When Unsure

- Ask a short clarifying question instead of making large structural assumptions.
- If a subtree needs specialized rules later, add a more specific `AGENTS.md` in that directory rather than bloating this file.
