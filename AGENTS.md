# AGENTS.md

This repository is a Python Slack application called `agents-party`.
It uses `pydantic-ai` and `pydantic-ai-skills` for agent behavior, Firestore for persistence, and Terraform for infrastructure.

## Core Rules

- Use `uv` for Python environment and dependency management.
- Use `ruff` for linting and formatting.
- Use `ty` for type checking.
- Do not use `pip`, `poetry`, or ad-hoc virtualenv workflows in this repository.
- Keep changes small and local. Avoid speculative repo-wide rewrites.

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

## Validation Expectations

- After editing Python files, run `ruff` and `ty` on the changed paths.
- Run project-wide validation when changes affect shared configuration, import structure, or multiple packages.
- Prefer file-scoped validation first because it is faster and keeps feedback tight.

## When Unsure

- Ask a short clarifying question instead of making large structural assumptions.
- If a subtree needs specialized rules later, add a more specific `AGENTS.md` in that directory rather than bloating this file.
